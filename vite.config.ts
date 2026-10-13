/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // prisma-ast importa lilconfig (Node fs) para ler config; no browser não há config
      lilconfig: fileURLToPath(new URL('./src/shims/lilconfig.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { include: ['libpg-query'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
