import { errAsync, okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import { Import } from '../../domain/import/import.js';
import type { DomainError } from '../../domain/import/import.js';
import type { ImportCommand } from '../../domain/import/commands.js';
import type {
  AppendError,
  EventMetadata,
  EventStorePort,
  StoredEvent,
} from '../ports/event-store-port.js';
import type { Clock } from '../ports/system-ports.js';

/**
 * The single write path: load the stream, fold it, run `decide`, and append the resulting events
 * under optimistic concurrency. `decide` is the guard — stale/duplicate outcomes come back as an
 * empty event list (no append), protocol violations as a `DomainError`.
 */
export type CommandError = DomainError | AppendError;

export interface CommandDeps {
  readonly store: EventStorePort;
  readonly clock: Clock;
}

export function applyCommand(
  deps: CommandDeps,
  importId: string,
  command: ImportCommand,
): ResultAsync<readonly StoredEvent[], CommandError> {
  return deps.store.readStream(importId).andThen((stored) => {
    const aggregate = Import.fromHistory(stored.map((entry) => entry.event));
    const decision = aggregate.execute(command);
    if (decision.isErr()) return errAsync(decision.error);
    if (decision.value.length === 0) return okAsync<readonly StoredEvent[], CommandError>([]);
    const metadata: EventMetadata = {
      importId,
      occurredAt: deps.clock.now().toISOString(),
    };
    return deps.store.append(importId, stored.length, decision.value, metadata);
  });
}
