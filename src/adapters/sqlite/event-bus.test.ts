import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { infraError } from '../../application/ports/errors.js';
import type { StoredEvent } from '../../application/ports/event-store-port.js';
import { InProcessEventBus, pollCatchUp } from './event-bus.js';

function storedAt(globalSeq: number): StoredEvent {
  return {
    globalSeq,
    streamId: 'imp-1',
    version: globalSeq - 1,
    type: 'ImportApplied',
    event: { type: 'ImportApplied', location: '/library/album' },
    metadata: { importId: 'imp-1', occurredAt: '2026-07-03T12:00:00.000Z' },
  };
}

describe('InProcessEventBus', () => {
  it('fans committed events out to every subscriber', () => {
    const bus = new InProcessEventBus();
    const seen: number[] = [];
    bus.subscribe((event) => seen.push(event.globalSeq));
    bus.subscribe((event) => seen.push(event.globalSeq * 10));

    bus.publish([storedAt(1), storedAt(2)]);

    expect(seen).toEqual([1, 10, 2, 20]);
  });

  it('stops delivering once a subscriber unsubscribes', () => {
    const bus = new InProcessEventBus();
    const seen: number[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.globalSeq));

    bus.publish([storedAt(1)]);
    unsubscribe();
    bus.publish([storedAt(2)]);

    expect(seen).toEqual([1]);
  });
});

describe('pollCatchUp', () => {
  it('drains events after the cursor and returns the new cursor', async () => {
    const store = { readAll: vi.fn().mockReturnValue(okAsync([storedAt(3), storedAt(4)])) };
    const seen: number[] = [];

    const result = await pollCatchUp(store, 2, (event) => {
      seen.push(event.globalSeq);
    });

    expect(store.readAll).toHaveBeenCalledWith(2);
    expect(seen).toEqual([3, 4]);
    expect(result._unsafeUnwrap()).toBe(4);
  });

  it('awaits an async handler for each event', async () => {
    const store = { readAll: vi.fn().mockReturnValue(okAsync([storedAt(1)])) };
    const seen: number[] = [];

    const result = await pollCatchUp(store, 0, async (event) => {
      await Promise.resolve();
      seen.push(event.globalSeq);
    });

    expect(seen).toEqual([1]);
    expect(result._unsafeUnwrap()).toBe(1);
  });

  it('returns the unchanged cursor when there is nothing new', async () => {
    const store = { readAll: vi.fn().mockReturnValue(okAsync([])) };

    const result = await pollCatchUp(store, 7, () => undefined);

    expect(result._unsafeUnwrap()).toBe(7);
  });

  it('surfaces an infrastructure fault from the store', async () => {
    const store = { readAll: vi.fn().mockReturnValue(errAsync(infraError('readAll', 'boom'))) };

    const result = await pollCatchUp(store, 0, () => undefined);

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: 'InfraError', operation: 'readAll' });
  });
});
