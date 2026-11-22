import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Script assertions run in a Worker built from out/, which a fresh clone does not have.
    // The setup compiles it once so `npx vitest run` works without a separate build step.
    globalSetup: ['test/setup/buildWorker.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ['default'],
    coverage: { reporter: ['text', 'html'], include: ['src/**/*.ts'] }
  },
  resolve: {
    alias: {
      // Unit/integration tests import compiled-free sources; the `vscode` module is aliased to the
      // stub so services that reference the type-only import keep working.
      vscode: new URL('./src/testing/vscodeStub.ts', import.meta.url).pathname
    }
  }
});
