import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://localhost:8080';
// dev e preview com a mesma origem da produção: o Caddy faz o mesmo proxy de /api e /collab
const proxy = {
  '/api': { target: API, changeOrigin: false },
  '/collab': { target: API.replace(/^http/, 'ws'), ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // prisma-ast importa lilconfig (Node fs) para ler config; no browser não há config
      lilconfig: fileURLToPath(new URL('./src/shims/lilconfig.ts', import.meta.url)),
    },
  },
  server: { proxy },
  preview: { proxy },
  build: { target: 'es2022', sourcemap: 'hidden', outDir: 'dist' },
  worker: { format: 'es' },
  optimizeDeps: { include: ['libpg-query'] },
});
