import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, UpcasterRegistry } from './upcaster.js';

describe('UpcasterRegistry', () => {
  it('is pass-through when nothing is registered (the MVP)', () => {
    const registry = new UpcasterRegistry();
    const data = { type: 'ImportApplied', location: '/library/album' };

    expect(registry.upcast('ImportApplied', 1, data)).toEqual({
      type: 'ImportApplied',
      location: '/library/album',
    });
  });

  it('chains registered upcasters from the stored version to the latest shape', () => {
    const registry = new UpcasterRegistry()
      .register('Widened', 1, (data) => ({ ...data, two: true }))
      .register('Widened', 2, (data) => ({ ...data, three: true }));

    const result = registry.upcast('Widened', 1, { type: 'Widened', one: true }) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({ type: 'Widened', one: true, two: true, three: true });
  });

  it('starts the chain at the stored version, skipping already-applied steps', () => {
    const registry = new UpcasterRegistry().register('Widened', 1, (data) => ({
      ...data,
      two: true,
    }));

    // Stored at version 2: no upcaster registered for v2, so it is already current.
    const result = registry.upcast('Widened', 2, { type: 'Widened', two: true }) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({ type: 'Widened', two: true });
  });

  it('stamps new events at the current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
