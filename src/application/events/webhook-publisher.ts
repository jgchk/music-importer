import { createHash } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import type {
  CheckpointStore,
  EventBus,
  EventStorePort,
  StoredEvent,
} from '../ports/event-store-port.js';
import type { PublishedEventMapping, WebhookDeliveryPort } from '../ports/published-events-port.js';

/**
 * The durable webhook publisher (change: outbound-release-verdicts, mirroring music-downloader's).
 * The event store IS the transactional outbox: domain events are durably appended before anything
 * else happens, so publishing is just one more checkpointed consumer of the global stream — the
 * reactor's shape, with a per-subscriber consumer name. Per subscriber, events are delivered in
 * global order, at-least-once: the checkpoint advances only on acknowledged delivery, an
 * undelivered event is never skipped ahead of (order over throughput), and a crash or dead
 * subscriber redelivers from the checkpoint on the next cycle/restart (convergence over loss).
 * Subscribers are isolated — one slow or dead URL holds only its own checkpoint.
 *
 * The payload contract is owned by the interfaces layer and injected as a
 * {@link PublishedEventMapping}; evolution of it is additive-only within an event type — a
 * breaking payload change is a new event `type` (see `src/interfaces/contracts/events/`).
 */

export interface WebhookRetryPolicy {
  readonly attempts: number; // total delivery attempts per cycle before parking
  readonly baseDelayMs: number; // backoff: base * 2^(attempt-1)
}

export const DEFAULT_WEBHOOK_RETRY: WebhookRetryPolicy = { attempts: 3, baseDelayMs: 500 };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The durable checkpoint key for one subscriber: `webhook:<url-hash>`. */
export function webhookConsumerName(url: string): string {
  return `webhook:${sha256Hex(url).slice(0, 16)}`;
}

/**
 * The deterministic delivery id (the receiver's idempotency key, sent as `webhook-id`): a pure
 * function of subscriber and global sequence, so a redelivery carries the same id as the original.
 * The global sequence alone identifies the stored event; the stream version adds nothing.
 */
export function webhookDeliveryId(url: string, globalSeq: number): string {
  return `msg_${sha256Hex(`${url}\n${String(globalSeq)}`).slice(0, 32)}`;
}

export interface WebhookPublisherDeps {
  readonly store: EventStorePort;
  readonly checkpoints: CheckpointStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly mapping: PublishedEventMapping;
  readonly deliver: WebhookDeliveryPort;
  readonly subscribers: readonly string[];
  readonly retry: WebhookRetryPolicy;
  readonly sleep: (ms: number) => Promise<void>;
}

/** One subscriber's ordered, checkpointed delivery loop. */
class SubscriberWorker {
  readonly consumer: string;
  private lastProcessed = 0;
  private running = false;
  private pending = false;

  constructor(
    private readonly url: string,
    private readonly deps: WebhookPublisherDeps,
  ) {
    this.consumer = webhookConsumerName(url);
  }

  async resume(): Promise<void> {
    const checkpoint = await this.deps.checkpoints.load(this.consumer);
    this.lastProcessed = checkpoint.unwrapOr(0);
  }

  /** Serialized drain: concurrent calls coalesce into one more pass, never interleave. */
  async pump(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.drain();
      } while (this.pending);
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    const backlog = await this.deps.store.readAll(this.lastProcessed);
    if (backlog.isErr()) {
      this.deps.logger.error(
        { url: this.url, consumer: this.consumer, err: backlog.error },
        'webhook catch-up failed',
      );
      return;
    }
    for (const stored of backlog.value) {
      if (!(await this.publish(stored))) return; // hold: redeliver on the next cycle/restart
      this.lastProcessed = stored.globalSeq;
      await this.deps.checkpoints.save(this.consumer, stored.globalSeq);
    }
  }

  /** True when the checkpoint may advance past `stored` (delivered, or not a published type). */
  private async publish(stored: StoredEvent): Promise<boolean> {
    if (!this.deps.mapping.publishes(stored.type)) return true;

    const stream = await this.deps.store.readStream(stored.streamId);
    if (stream.isErr()) {
      this.deps.logger.error(
        { url: this.url, importId: stored.streamId, err: stream.error },
        'webhook stream read failed; holding checkpoint',
      );
      return false;
    }
    // Render from the prefix as of the event (deterministic, replay-safe) — same posture as the reactor.
    const prefix = stream.value.filter((entry) => entry.version <= stored.version);
    const rendered = this.deps.mapping.render(stored, prefix);
    if (rendered.isErr()) {
      // A schema-violating payload never leaves the process; the defect surfaces loudly and the
      // checkpoint holds so nothing is silently lost (convergence over loss).
      this.deps.logger.error(
        { url: this.url, importId: stored.streamId, err: rendered.error },
        'outbound payload failed rendering/validation; delivery not attempted, checkpoint held',
      );
      return false;
    }

    const deliveryId = webhookDeliveryId(this.url, stored.globalSeq);
    const { attempts, baseDelayMs } = this.deps.retry;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.deps.deliver.deliver(this.url, deliveryId, rendered.value);
      if (result.isOk()) {
        this.deps.logger.debug(
          { url: this.url, deliveryId, type: rendered.value.type, globalSeq: stored.globalSeq },
          'webhook delivered',
        );
        return true;
      }
      this.deps.logger.warn(
        { url: this.url, deliveryId, attempt, err: result.error },
        'webhook delivery failed',
      );
      if (attempt < attempts) await this.deps.sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    this.deps.logger.error(
      { url: this.url, consumer: this.consumer, deliveryId, globalSeq: stored.globalSeq },
      'webhook delivery exhausted retries; holding checkpoint for redelivery',
    );
    return false;
  }
}

export class WebhookPublisher {
  private readonly workers: readonly SubscriberWorker[];
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: WebhookPublisherDeps) {
    this.workers = deps.subscribers.map((url) => new SubscriberWorker(url, deps));
  }

  /** Resume each subscriber from its checkpoint, drain the backlog, then follow the live bus. */
  async start(): Promise<void> {
    for (const worker of this.workers) await worker.resume();
    await this.poll();
    this.unsubscribe = this.deps.bus.subscribe(() => {
      void this.poll();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Pump every subscriber independently — a held checkpoint never starves another subscriber. */
  async poll(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.pump()));
  }
}
