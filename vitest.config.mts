import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Las pruebas del núcleo no tocan la red ni la base: si alguna tarda esto, es un bug.
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
