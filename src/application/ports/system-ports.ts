/** Ambient capabilities injected into the shell so it stays deterministic under test. */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
