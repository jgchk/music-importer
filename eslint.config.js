import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

/**
 * The dependency rule: domain <- application <- {adapters, interfaces} <- composition.
 * A layer may import from itself and inner layers only. Encoded as forbidden (target, from)
 * pairs for `import/no-restricted-paths`; a violation fails lint and therefore CI.
 */
const layerBoundaryZones = [
  // domain imports nothing outward — the pure core depends on no other layer.
  { target: './src/domain', from: './src/application' },
  { target: './src/domain', from: './src/adapters' },
  { target: './src/domain', from: './src/interfaces' },
  { target: './src/domain', from: './src/composition' },
  // application depends only on domain.
  { target: './src/application', from: './src/adapters' },
  { target: './src/application', from: './src/interfaces' },
  { target: './src/application', from: './src/composition' },
  // adapters depend on application + domain, never on interfaces or composition.
  { target: './src/adapters', from: './src/interfaces' },
  { target: './src/adapters', from: './src/composition' },
  // interfaces depend on application + domain, never on adapters or composition.
  { target: './src/interfaces', from: './src/adapters' },
  { target: './src/interfaces', from: './src/composition' },
];

/**
 * The import decider internals — the folded state, `decide`, and `react` — are private to the
 * aggregate. Only `src/domain/import/*` may import them; every other layer goes through the
 * `Import` facade (`import.js`), which re-exports the public types. A violation fails lint and
 * therefore CI.
 */
const importDeciderInternals = [
  './src/domain/import/state.ts',
  './src/domain/import/decide.ts',
  './src/domain/import/react.ts',
];
const aggregateExternalConsumers = [
  './src/application',
  './src/adapters',
  './src/interfaces',
  './src/composition',
];
const aggregateEncapsulationZones = aggregateExternalConsumers.flatMap((target) =>
  importDeciderInternals.map((from) => ({
    target,
    from,
    message:
      'Import decider internals are private to the aggregate — import the Import facade from domain/import/import.js instead.',
  })),
);

export default tseslint.config(
  {
    // test/e2e, test/contract, and scripts/ (release tooling) are out-of-src suites verified by
    // execution (Docker-driven e2e; frozen-fixture contract tests; version:prep unit tests), not
    // part of the src-scoped TypeScript project (tsconfig `include: ["src"]`); keep them out of
    // the type-checked lint.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.e2e-tmp/**',
      'test/e2e/**',
      'test/contract/**',
      'scripts/**',
      '*.config.ts',
      '*.config.js',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        { zones: [...layerBoundaryZones, ...aggregateEncapsulationZones] },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The pure domain performs no logging: it must not import any logger.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pino', message: 'The domain is pure and must not log.' },
            {
              name: 'node:util',
              message: 'The domain is pure and must not perform I/O or logging.',
            },
          ],
          patterns: [
            {
              group: ['**/application/logging', '**/application/logging/*'],
              message: 'The domain is pure and must not import a logger.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // vitest mocks are referenced unbound in assertions (expect(fn).toHaveBeen…).
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
