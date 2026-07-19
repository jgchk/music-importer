import { okAsync } from 'neverthrow';
import { POLICY } from '../../domain/import/__fixtures__/import-fixtures.js';
import { FakeEventStore, fixedClock, silentLogger } from '../../application/__fixtures__/fakes.js';
import type { EffectPorts } from '../../application/import/interpreter.js';
import { interpretEffect } from '../../application/import/interpreter.js';
import type { UseCaseDeps } from '../../application/import/use-cases.js';
import { ImportStatusProjection } from '../../application/projections/read-models.js';
import type { ProposeOutcome } from '../../application/ports/outbound-ports.js';
import type { Effect } from '../../domain/import/import.js';

/**
 * A minimal in-memory wiring of the use-case dependencies for interface tests. `sync()` pumps the
 * store into the status projection, standing in for the reactor/projection catch-up so a query
 * reflects a just-submitted import. `react(importId)` replays the reflex for the stream's last
 * event through a stubbed tagger, standing in for the reactor's effect dispatch.
 */
export interface TestWiring {
  readonly deps: UseCaseDeps;
  readonly store: FakeEventStore;
  readonly status: ImportStatusProjection;
  readonly sync: () => void;
  readonly dispatch: (importId: string, effect: Effect) => Promise<void>;
  readonly ports: EffectPorts;
  /** Swap what the stubbed tagger proposes next. */
  setProposal: (outcome: ProposeOutcome) => void;
}

export function testWiring(): TestWiring {
  const store = new FakeEventStore();
  const status = new ImportStatusProjection();
  let proposal: ProposeOutcome = { kind: 'proposal', candidates: [], duplicates: [] };
  const ports: EffectPorts = {
    tagger: {
      propose: () => okAsync(proposal),
      apply: () => okAsync({ kind: 'applied', location: '/library/x', failures: [] }),
      validate: () =>
        okAsync({
          beetsVersion: '2.12.0',
          libraryDatabase: '/beets/library.db',
          libraryDirectory: '/music/library',
          plugins: ['musicbrainz'],
          overlay: {},
        }),
    },
    intake: { deleteRelease: () => okAsync(undefined) },
  };
  const deps: UseCaseDeps = {
    store,
    clock: fixedClock(),
    status,
    policy: POLICY,
  };
  return {
    deps,
    store,
    status,
    ports,
    sync: () => status.rebuild(store.all()),
    dispatch: async (importId, effect) => {
      await interpretEffect({ store, clock: fixedClock(), ports }, importId, effect);
      status.rebuild(store.all());
    },
    setProposal: (outcome) => {
      proposal = outcome;
    },
  };
}

export { silentLogger };
