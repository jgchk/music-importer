import { describe, expect, it } from 'vitest';
import { infraError } from './errors.js';

describe('infraError', () => {
  it('builds a tagged infrastructure error carrying the operation and cause', () => {
    const cause = new Error('ECONNREFUSED');
    expect(infraError('bridge.propose', 'unreachable', cause)).toEqual({
      kind: 'InfraError',
      operation: 'bridge.propose',
      message: 'unreachable',
      cause,
    });
  });

  it('omits the cause when none is given', () => {
    expect(infraError('bridge.spawn', 'missing binary').cause).toBeUndefined();
  });
});
