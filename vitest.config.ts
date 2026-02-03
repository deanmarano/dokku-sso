import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,  // Integration tests can be slow
    hookTimeout: 120000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],  // E2E uses Playwright
  },
});
