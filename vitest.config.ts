import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    globalSetup: ['test/integration/global-setup.ts'],
    coverage: { include: ['src/**'], exclude: ['src/server.ts'] },
  },
});
