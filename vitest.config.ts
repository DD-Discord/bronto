import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'modules/*/src/**/*.test.ts', 'modules/*/test/**/*.test.ts', 'examples/*/src/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    globalSetup: ['packages/core/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
