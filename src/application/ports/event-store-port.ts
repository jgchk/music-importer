import type { ResultAsync } from 'neverthrow';
import type { ImportEvent, ImportEventType } from '../../domain/import/events.js';
import type { InfraError } from './errors.js';

/**
 * The event store: append / read-stream / read-all behind a port so the SQLite adapter can
 * be swapped for Postgres later without touching the application. `global_seq` gives the total
 * order that drives projections and the reactor; `UNIQUE(stream_id, version)` is optimistic
 * concurrency, surfaced here as {@link ConcurrencyConflict}.
 */
export interface EventMetadata {
  readonly importId: string;
  readonly occurredAt: string; // ISO-8601
  readonly correlationId?: string;
}

export interface StoredEvent {
  readonly globalSeq: number;
  readonly streamId: string;
  readonly version: number;
  readonly type: ImportEventType;
  readonly event: ImportEvent;
  readonly metadata: EventMetadata;
}

export interface ConcurrencyConflict {
  readonly kind: 'ConcurrencyConflict';
  readonly streamId: string;
  readonly expectedVersion: number;
}

export type AppendError = InfraError | ConcurrencyConflict;

export interface EventStorePort {
  /** Append `events` to `streamId` iff its current version equals `expectedVersion`. */
  append(
    streamId: string,
    expectedVersion: number,
    events: readonly ImportEvent[],
    metadata: EventMetadata,
  ): ResultAsync<readonly StoredEvent[], AppendError>;

  readStream(streamId: string): ResultAsync<readonly StoredEvent[], InfraError>;

  /** All events after `fromGlobalSeq`, in global order — the projection/reactor catch-up path. */
  readAll(fromGlobalSeq: number): ResultAsync<readonly StoredEvent[], InfraError>;
}

/** The durable reactor checkpoint: last global_seq a consumer has processed. */
export interface CheckpointStore {
  load(consumer: string): ResultAsync<number, InfraError>; // 0 when never checkpointed
  save(consumer: string, globalSeq: number): ResultAsync<void, InfraError>;
}

/** In-process publish-after-commit fan-out; the durable catch-up path is `readAll`. */
export interface EventBus {
  publish(events: readonly StoredEvent[]): void;
  subscribe(handler: (event: StoredEvent) => void): () => void;
}
