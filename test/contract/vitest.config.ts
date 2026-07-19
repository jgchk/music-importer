import { defineConfig } from 'vitest/config';

/**
 * The contract test tier: frozen, recorded beets-bridge JSON validated against the same zod
 * schemas the runtime adapter enforces — no Python, no network, no containers at test time. It
 * gates every commit as its own step (`pnpm test:contract`, wired into `check` and CI). The
 * fixtures are re-recorded (test/contract/record-bridge-fixtures.sh) only when the pinned beets
 * version changes, making an upgrade a deliberate, verified event. The `src/` schema modules the
 * tier leans on are covered by the unit run; this tier verifies fixture fidelity, so it carries
 * no coverage thresholds of its own.
 */
export default defineConfig({
  test: {
    include: ['test/contract/**/*.contract.test.ts'],
    testTimeout: 20_000,
  },
});
