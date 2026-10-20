import { defineConfig } from 'tsdown';

/** Bundle autocontido que roda no isolate: tudo dentro, nada importado em runtime */
export default defineConfig({
  entry: { isolate: 'src/isolate-entry.ts' },
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: false,
  clean: true,
  minify: true,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  // `lilconfig` (do prisma-ast) nunca é usado pelo parse do Drizzle; o shim evita puxar o fs
  alias: { lilconfig: new URL('./src/shims/lilconfig.ts', import.meta.url).pathname },
});
