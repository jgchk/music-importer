/**
 * Infrastructure faults: the neverthrow `Err` channel of the outbound ports. Distinct from
 * business sadness (a stalled download, no candidates), which flows as domain events. The shell
 * treats an `InfraError` as a retryable operational concern (backoff / dead-letter), never a fact.
 */
export interface InfraError {
  readonly kind: 'InfraError';
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}

export function infraError(operation: string, message: string, cause?: unknown): InfraError {
  return { kind: 'InfraError', operation, message, cause };
}
