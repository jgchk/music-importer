import { ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportEvent } from '../../domain/import/events.js';
import {
  DELIVERED_CANDIDATE,
  SOURCE,
  awaitingReviewWithCandidate,
  requested,
  resolved,
} from '../../domain/import/__fixtures__/import-fixtures.js';
import {
  FakeCheckpointStore,
  FakeEventBus,
  FakeEventStore,
  silentLogger,
} from '../__fixtures__/fakes.js';
import { infraError } from '../ports/errors.js';
import type { StoredEvent } from '../ports/event-store-port.js';
import type {
  PublishedEvent,
  PublishedEventMapping,
  WebhookDeliveryPort,
} from '../ports/published-events-port.js';
import { WebhookPublisher, webhookConsumerName, webhookDeliveryId } from './webhook-publisher.js';
import type { WebhookPublisherDeps } from './webhook-publisher.js';

const URL_A = 'https://a.example/hook';
const URL_B = 'https://b.example/hook';

/** A history whose last event is the published `ReleaseVerdictRecorded` fact. */
function verdictHistory(): ImportEvent[] {
  return [
    ...awaitingReviewWithCandidate(),
    resolved({ kind: 'reject-and-retry-download', reasons: ['corrupt rip'] }),
    {
      type: 'ReleaseVerdictRecorded',
      acquisitionId: SOURCE.acquisitionId,
      candidate: DELIVERED_CANDIDATE,
      reasons: ['corrupt rip'],
    },
  ];
}

interface Delivery {
  readonly url: string;
  readonly deliveryId: string;
  readonly event: PublishedEvent;
}

let store: FakeEventStore;
let checkpoints: FakeCheckpointStore;
let bus: FakeEventBus;
let deliveries: Delivery[];
let failuresFor: Map<string, number>;
let deliverPort: WebhookDeliveryPort;
let sleeps: number[];

const mapping: PublishedEventMapping = {
  publishes: (type) => type === 'ReleaseVerdictRecorded',
  render: vi.fn((stored: StoredEvent, prefix: readonly StoredEvent[]) =>
    ok({
      type: 'release.verdict',
      timestamp: stored.metadata.occurredAt,
      data: { globalSeq: stored.globalSeq, prefixVersions: prefix.map((entry) => entry.version) },
    }),
  ),
};

beforeEach(() => {
  store = new FakeEventStore();
  checkpoints = new FakeCheckpointStore();
  bus = new FakeEventBus();
  deliveries = [];
  failuresFor = new Map();
  sleeps = [];
  deliverPort = {
    deliver: (url, deliveryId, event) => {
      const remaining = failuresFor.get(url) ?? 0;
      if (remaining > 0) {
        failuresFor.set(url, remaining - 1);
        return errAsync(infraError('webhook.deliver', 'unreachable'));
      }
      deliveries.push({ url, deliveryId, event });
      return okAsync(undefined);
    },
  };
  vi.mocked(mapping.render).mockClear();
});

function publisher(overrides: Partial<WebhookPublisherDeps> = {}): WebhookPublisher {
  return new WebhookPublisher({
    store,
    checkpoints,
    bus,
    logger: silentLogger(),
    mapping,
    deliver: deliverPort,
    subscribers: [URL_A],
    retry: { attempts: 3, baseDelayMs: 500 },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
}

async function seed(history: readonly ImportEvent[], streamId = 'imp-1'): Promise<void> {
  await store.append(streamId, 0, history, { importId: streamId, occurredAt: 't' });
}

function lastSeq(): number {
  return store.all().at(-1)!.globalSeq;
}

const consumerA = webhookConsumerName(URL_A);
const consumerB = webhookConsumerName(URL_B);

describe('webhookConsumerName / webhookDeliveryId', () => {
  it('derives a stable, url-scoped consumer name', () => {
    expect(webhookConsumerName(URL_A)).toBe(consumerA);
    expect(consumerA).toMatch(/^webhook:[0-9a-f]{16}$/);
    expect(consumerA).not.toBe(consumerB);
  });

  it('derives a deterministic delivery id from subscriber and global sequence', () => {
    expect(webhookDeliveryId(URL_A, 12)).toBe(webhookDeliveryId(URL_A, 12));
    expect(webhookDeliveryId(URL_A, 12)).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(webhookDeliveryId(URL_A, 12)).not.toBe(webhookDeliveryId(URL_A, 13));
    expect(webhookDeliveryId(URL_A, 12)).not.toBe(webhookDeliveryId(URL_B, 12));
  });
});

describe('WebhookPublisher.start', () => {
  it('drains the backlog: delivers mapped events and checkpoints past unmapped ones', async () => {
    await seed(verdictHistory());
    const p = publisher();
    await p.start();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      url: URL_A,
      deliveryId: webhookDeliveryId(URL_A, lastSeq()),
    });
    expect(checkpoints.peek(consumerA)).toBe(lastSeq());
    expect(bus.subscriberCount()).toBe(1);
    p.stop();
  });

  it('renders from the stream prefix as of the event, not the whole stream', async () => {
    await seed(verdictHistory());
    await seed([requested()], 'imp-2'); // later, unrelated stream noise
    await publisher().start();

    const verdict = store.all().find((entry) => entry.type === 'ReleaseVerdictRecorded')!;
    const [stored, prefix] = vi.mocked(mapping.render).mock.calls[0]!;
    expect(stored.globalSeq).toBe(verdict.globalSeq);
    expect(prefix.at(-1)!.globalSeq).toBe(verdict.globalSeq);
    expect(prefix.every((entry) => entry.streamId === 'imp-1')).toBe(true);
    expect(prefix.every((entry) => entry.version <= verdict.version)).toBe(true);
  });

  it('resumes from the saved checkpoint without redelivering acknowledged events', async () => {
    await seed(verdictHistory());
    await checkpoints.save(consumerA, lastSeq());
    const p = publisher();
    await p.start();
    expect(deliveries).toHaveLength(0);
    p.stop();
  });

  it('tolerates a checkpoint load failure by starting from the beginning (at-least-once)', async () => {
    await seed(verdictHistory());
    checkpoints.failLoad = true;
    await publisher().start();
    expect(deliveries).toHaveLength(1);
  });

  it('logs and keeps following when catch-up read-all fails', async () => {
    store.failReadAll = true;
    const p = publisher();
    await p.start();
    expect(bus.subscriberCount()).toBe(1);
    expect(deliveries).toHaveLength(0);
    p.stop();
  });

  it('delivers live events published on the bus after start', async () => {
    const p = publisher();
    await p.start();
    await seed(verdictHistory());
    bus.publish(store.all());
    await vi.waitFor(() => {
      expect(deliveries).toHaveLength(1);
    });
    p.stop();
  });

  it('stops following the bus on stop()', async () => {
    const p = publisher();
    await p.start();
    p.stop();
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe('WebhookPublisher delivery semantics', () => {
  it('retries with bounded exponential backoff, then succeeds without advancing past order', async () => {
    await seed(verdictHistory());
    failuresFor.set(URL_A, 2);
    await publisher().start();

    expect(deliveries).toHaveLength(1);
    expect(sleeps).toEqual([500, 1000]);
    expect(checkpoints.peek(consumerA)).toBe(lastSeq());
  });

  it('holds the checkpoint when retries are exhausted, and redelivers with the same id on restart', async () => {
    await seed(verdictHistory());
    failuresFor.set(URL_A, 3);
    const first = publisher();
    await first.start();
    first.stop();
    expect(deliveries).toHaveLength(0);
    expect(checkpoints.peek(consumerA)).toBe(lastSeq() - 1); // held at the undelivered event

    // Restart (fresh instance, same durable checkpoints): the event redelivers, same delivery id.
    const second = publisher();
    await second.start();
    second.stop();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.deliveryId).toBe(webhookDeliveryId(URL_A, lastSeq()));
    expect(checkpoints.peek(consumerA)).toBe(lastSeq());
  });

  it('preserves order: an undelivered event blocks later events for that subscriber', async () => {
    await seed(verdictHistory(), 'imp-1');
    const firstVerdictSeq = lastSeq();
    await seed(verdictHistory(), 'imp-2');
    failuresFor.set(URL_A, 3); // first delivery exhausts its retries
    await publisher().start();

    // Only the second event's delivery would violate order — nothing must be delivered.
    expect(deliveries).toHaveLength(0);
    expect(checkpoints.peek(consumerA)).toBe(firstVerdictSeq - 1);
  });

  it('isolates subscribers: a dead subscriber holds its own checkpoint while the live one advances', async () => {
    await seed(verdictHistory());
    failuresFor.set(URL_B, 3);
    const p = publisher({ subscribers: [URL_A, URL_B] });
    await p.start();
    p.stop();

    expect(deliveries.map((d) => d.url)).toEqual([URL_A]);
    expect(checkpoints.peek(consumerA)).toBe(lastSeq());
    expect(checkpoints.peek(consumerB)).toBe(lastSeq() - 1); // held at the undelivered event
  });

  it('does not attempt delivery when rendering fails, and holds the checkpoint', async () => {
    await seed(verdictHistory());
    const brokenMapping: PublishedEventMapping = {
      publishes: () => true,
      render: () => err({ kind: 'RenderError', eventType: 'release.verdict', message: 'x' }),
    };
    await publisher({ mapping: brokenMapping }).start();
    expect(deliveries).toHaveLength(0);
    expect(checkpoints.peek(consumerA)).toBeUndefined();
  });

  it('holds the checkpoint when the stream prefix cannot be read', async () => {
    await seed(verdictHistory());
    store.failReads = true;
    await publisher().start();
    expect(deliveries).toHaveLength(0);
    expect(checkpoints.peek(consumerA)).toBe(lastSeq() - 1); // held at the unreadable event
  });

  it('coalesces concurrent pump requests instead of interleaving deliveries', async () => {
    await seed(verdictHistory());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowDeliver: WebhookDeliveryPort = {
      deliver: (url, deliveryId, event) =>
        ResultAsync.fromSafePromise(gate).andThen(() =>
          deliverPort.deliver(url, deliveryId, event),
        ),
    };
    const p = publisher({ deliver: slowDeliver });
    const first = p.poll();
    const second = p.poll(); // while the first is mid-delivery: coalesced, not interleaved
    release();
    await first;
    await second;
    expect(deliveries).toHaveLength(1);
    expect(checkpoints.peek(consumerA)).toBe(lastSeq());
  });
});
