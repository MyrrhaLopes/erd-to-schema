import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    // testes de integração com Postgres real: um banco novo por arquivo
    fileParallelism: false,
  },
});
