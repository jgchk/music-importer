import { errAsync, okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { ImportEvent } from '../../domain/import/events.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { infraError } from '../ports/errors.js';
import type { InfraError } from '../ports/errors.js';
import type {
  AppendError,
  CheckpointStore,
  EventBus,
  EventMetadata,
  EventStorePort,
  StoredEvent,
} from '../ports/event-store-port.js';
import type { Clock } from '../ports/system-ports.js';

/** A minimal in-memory event store for application-layer tests (optimistic concurrency, global order). */
export class FakeEventStore implements EventStorePort {
  private readonly events: StoredEvent[] = [];
  public failReads = false;
  public failReadAll = false;
  public conflictOnAppend = false;
  public bus: EventBus | undefined;

  append(
    streamId: string,
    expectedVersion: number,
    events: readonly ImportEvent[],
    metadata: EventMetadata,
  ): ResultAsync<readonly StoredEvent[], AppendError> {
    if (this.conflictOnAppend) {
      return errAsync({ kind: 'ConcurrencyConflict', streamId, expectedVersion });
    }
    const current = this.events.filter((entry) => entry.streamId === streamId);
    if (current.length !== expectedVersion) {
      return errAsync({ kind: 'ConcurrencyConflict', streamId, expectedVersion });
    }
    const stored = events.map((event, index) => ({
      globalSeq: this.events.length + index + 1,
      streamId,
      version: expectedVersion + index,
      type: event.type,
      event,
      metadata,
    }));
    this.events.push(...stored);
    this.bus?.publish(stored);
    return okAsync(stored);
  }

  readStream(streamId: string): ResultAsync<readonly StoredEvent[], InfraError> {
    if (this.failReads) return errAsync(infraError('readStream', 'boom'));
    return okAsync(this.events.filter((entry) => entry.streamId === streamId));
  }

  readAll(fromGlobalSeq: number): ResultAsync<readonly StoredEvent[], InfraError> {
    if (this.failReadAll) return errAsync(infraError('readAll', 'boom'));
    return okAsync(this.events.filter((entry) => entry.globalSeq > fromGlobalSeq));
  }

  all(): readonly StoredEvent[] {
    return this.events;
  }
}

export class FakeCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, number>();
  public failLoad = false;

  load(consumer: string): ResultAsync<number, InfraError> {
    if (this.failLoad) return errAsync(infraError('checkpoint.load', 'boom'));
    return okAsync(this.checkpoints.get(consumer) ?? 0);
  }

  save(consumer: string, globalSeq: number): ResultAsync<void, InfraError> {
    this.checkpoints.set(consumer, globalSeq);
    return okAsync(undefined);
  }

  peek(consumer: string): number | undefined {
    return this.checkpoints.get(consumer);
  }
}

export class FakeEventBus implements EventBus {
  private readonly handlers = new Set<(event: StoredEvent) => void>();

  publish(events: readonly StoredEvent[]): void {
    for (const event of events) {
      for (const handler of this.handlers) handler(event);
    }
  }

  subscribe(handler: (event: StoredEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscriberCount(): number {
    return this.handlers.size;
  }
}

/** A logger that discards output — for tests that exercise logging call sites without noise. */
export function silentLogger(): Logger {
  return createLogger({ level: 'silent', destination: { write: () => undefined } });
}

export function fixedClock(iso = '2026-07-18T12:00:00.000Z'): Clock {
  const date = new Date(iso);
  return { now: () => date };
}
