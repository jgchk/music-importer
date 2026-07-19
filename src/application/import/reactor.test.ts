import { errAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY,
  POLICY,
  candidate,
  requested,
} from '../../domain/import/__fixtures__/import-fixtures.js';
import type { ImportEvent } from '../../domain/import/events.js';
import { infraError } from '../ports/errors.js';
import {
  FakeCheckpointStore,
  FakeEventBus,
  FakeEventStore,
  fixedClock,
  silentLogger,
} from '../__fixtures__/fakes.js';
import { applyCommand } from './command-handler.js';
import type { EffectPorts } from './interpreter.js';
import { interpretEffect } from './interpreter.js';
import { REACTOR_CONSUMER, Reactor } from './reactor.js';
import type { EffectInterpreter } from './reactor.js';

let store: FakeEventStore;
let checkpoints: FakeCheckpointStore;
let bus: FakeEventBus;

beforeEach(() => {
  store = new FakeEventStore();
  checkpoints = new FakeCheckpointStore();
  bus = new FakeEventBus();
  store.bus = bus;
});

function realInterpret(ports: EffectPorts): EffectInterpreter {
  const deps = { store, clock: fixedClock(), ports };
  return (importId, effect) => interpretEffect(deps, importId, effect);
}

function reactor(interpret: EffectInterpreter): Reactor {
  return new Reactor({ store, checkpoints, bus, logger: silentLogger(), interpret });
}

/** Seed history without publishing: detach the bus for the append, as a pre-start backlog. */
async function seed(history: readonly ImportEvent[]): Promise<void> {
  store.bus = undefined;
  await store.append('imp-1', 0, history, { importId: 'imp-1', occurredAt: 't' });
  store.bus = bus;
}

describe('Reactor', () => {
  it('drains the backlog on start and checkpoints the last processed event', async () => {
    await seed([requested()]);
    const interpret = vi.fn(() => okAsync([]));
    await reactor(interpret).start();

    expect(interpret).toHaveBeenCalledWith('imp-1', expect.objectContaining({ type: 'Propose' }));
    expect(checkpoints.peek(REACTOR_CONSUMER)).toBe(1);
  });

  it('resumes past the checkpoint without re-firing already-dispatched effects', async () => {
    await seed([requested()]);
    await checkpoints.save(REACTOR_CONSUMER, 1);
    const interpret = vi.fn(() => okAsync([]));
    await reactor(interpret).start();

    expect(interpret).not.toHaveBeenCalled();
  });

  it('drives a submission through propose, auto-apply, and applied end to end', async () => {
    const ports: EffectPorts = {
      tagger: {
        propose: vi.fn(() =>
          okAsync({
            kind: 'proposal' as const,
            candidates: [candidate({ distance: 0.01 })],
            duplicates: [],
          }),
        ),
        apply: vi.fn(() =>
          okAsync({ kind: 'applied' as const, location: '/library/Artist/Album', failures: [] }),
        ),
        validate: vi.fn(),
      },
      intake: { deleteRelease: vi.fn() },
    };
    const r = reactor(realInterpret(ports));
    await r.start();

    await applyCommand({ store, clock: fixedClock() }, 'imp-1', {
      type: 'SubmitImport',
      directory: DIRECTORY,
      policy: POLICY,
    });
    await vi.waitFor(() => {
      expect(store.all().map((entry) => entry.type)).toEqual([
        'ImportRequested',
        'CandidatesProposed',
        'AutoApplySelected',
        'ImportApplied',
      ]);
    });
    expect(ports.tagger.apply).toHaveBeenCalledWith(DIRECTORY, {
      kind: 'candidate',
      ref: candidate().ref,
    });
    r.stop();
  });

  it('tolerates stop() before start()', () => {
    expect(() => reactor(vi.fn(() => okAsync([]))).stop()).not.toThrow();
  });

  it('deduplicates an already-processed event under at-least-once redelivery', async () => {
    await seed([requested()]);
    const interpret = vi.fn(() => okAsync([]));
    const r = reactor(interpret);
    await r.start();
    expect(interpret).toHaveBeenCalledTimes(1);

    await r.process(store.all()[0]!); // redelivery of the already-checkpointed event
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it('stops following live events after stop()', async () => {
    const interpret = vi.fn(() => okAsync([]));
    const r = reactor(interpret);
    await r.start();
    expect(bus.subscriberCount()).toBe(1);
    r.stop();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('leaves the checkpoint unadvanced on a retryable effect failure', async () => {
    await seed([requested()]);
    const interpret = vi.fn(() => errAsync(infraError('bridge.propose', 'spawn failed')));
    await reactor(interpret).start();

    expect(checkpoints.peek(REACTOR_CONSUMER)).toBeUndefined();
  });

  it('advances past a follow-on the domain rejected as stale/illegal', async () => {
    await seed([requested()]);
    const interpret = vi.fn(() => errAsync({ kind: 'NoOpenReview' as const }));
    await reactor(interpret).start();

    expect(checkpoints.peek(REACTOR_CONSUMER)).toBe(1);
  });

  it('treats a concurrency conflict as retryable', async () => {
    await seed([requested()]);
    const interpret = vi.fn(() =>
      errAsync({ kind: 'ConcurrencyConflict' as const, streamId: 'imp-1', expectedVersion: 0 }),
    );
    await reactor(interpret).start();

    expect(checkpoints.peek(REACTOR_CONSUMER)).toBeUndefined();
  });

  it('skips reacting when the stream read fails, leaving the checkpoint put', async () => {
    await seed([requested()]);
    store.failReads = true;
    const interpret = vi.fn(() => okAsync([]));
    await reactor(interpret).start();

    expect(interpret).not.toHaveBeenCalled();
    expect(checkpoints.peek(REACTOR_CONSUMER)).toBeUndefined();
  });

  it('logs and carries on when the backlog read fails', async () => {
    store.failReadAll = true;
    const interpret = vi.fn(() => okAsync([]));
    const r = reactor(interpret);
    await r.start();

    expect(bus.subscriberCount()).toBe(1); // still follows live events
    r.stop();
  });

  it('checkpoints record-only events without firing effects', async () => {
    await seed([
      requested(),
      { type: 'CandidatesProposed', candidates: [], duplicates: [] },
      { type: 'ReviewRequired', cause: { kind: 'no-match' } },
    ]);
    const interpret = vi.fn(() => okAsync([]));
    await reactor(interpret).start();

    // Propose fires once (for ImportRequested); the record-only events just advance the checkpoint.
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(checkpoints.peek(REACTOR_CONSUMER)).toBe(3);
  });
});
