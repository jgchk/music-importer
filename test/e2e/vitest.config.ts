import { defineConfig } from 'vitest/config';

/**
 * The out-of-process E2E tier. Deliberately SEPARATE from the root `vitest.config.ts`: these
 * specs drive a real running container (real beets, real MusicBrainz) over HTTP and must never be
 * part of the unit run or its 100% coverage measurement. No coverage, generous timeouts (each
 * propose/apply round-trips MusicBrainz), no file parallelism (one shared app instance).
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
