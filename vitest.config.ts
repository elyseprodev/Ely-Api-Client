import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
