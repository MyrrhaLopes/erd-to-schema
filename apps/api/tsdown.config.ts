import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };

/**
 * Bundle do servidor: os pacotes internos (@erd/*) entram no bundle, então não precisam
 * de build próprio em runtime. Todo o resto (inclusive módulos nativos e o .wasm do
 * libpg-query, que carrega da própria pasta) fica externo e chega via `pnpm deploy --prod`.
 */
export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/migrate.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  dts: false,
  clean: true,
  // o build falha se o bundle importar um pacote que não está em `dependencies` (não chegaria na imagem)
  deps: { neverBundle: true, alwaysBundle: [/^@erd\//], onlyImport: Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@erd/')) },
  copy: [{ from: '../../packages/db/migrations', to: 'dist' }],
  fixedExtension: false,
});
