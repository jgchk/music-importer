import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { InfraError } from '../../application/ports/errors.js';
import type {
  EventBus,
  EventStorePort,
  StoredEvent,
} from '../../application/ports/event-store-port.js';

/**
 * The in-process publish-after-commit fan-out: the event store publishes committed events
 * here, and the reactor and projections subscribe to follow them live within the single process.
 * Fan-out is synchronous. The durable recovery path — after a restart, or for a subscriber that
 * missed live events — is {@link pollCatchUp} over the store's global order, not this bus.
 */
export class InProcessEventBus implements EventBus {
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
}

/**
 * `global_seq` polling catch-up: drain every event after `fromGlobalSeq` in global order,
 * feed each to `handler`, and return the new cursor. This is the durable path that rebuilds a
 * projection or resumes the reactor after a restart, independent of the ephemeral in-process bus.
 * Composition schedules repeated calls; each call advances the caller's cursor.
 */
export async function pollCatchUp(
  store: Pick<EventStorePort, 'readAll'>,
  fromGlobalSeq: number,
  handler: (event: StoredEvent) => void | Promise<void>,
): Promise<Result<number, InfraError>> {
  const result = await store.readAll(fromGlobalSeq);
  if (result.isErr()) return err(result.error);

  let cursor = fromGlobalSeq;
  for (const event of result.value) {
    await handler(event);
    cursor = event.globalSeq;
  }
  return ok(cursor);
}
