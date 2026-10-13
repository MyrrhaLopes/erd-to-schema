/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import wasmUrl from 'libpg-query/wasm/libpg-query.wasm?url';
import type { Format } from '../model/types';
import type { ParseOutcome } from '../formats/common';
import { parseSql, type PgParse } from '../formats/sql/parse';
import { parsePrisma } from '../formats/prisma/parse';

// O módulo emscripten do libpg-query busca o .wasm relativo à URL do worker;
// redirecionamos para a URL do asset gerada pelo Vite.
const originalFetch = self.fetch.bind(self);
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('libpg-query.wasm')) return originalFetch(wasmUrl, init);
  return originalFetch(input, init);
};

let pg: Promise<PgParse> | null = null;
const loadPg = () => (pg ??= import('libpg-query').then((m) => m.parse as unknown as PgParse));

const api = {
  async parse(format: Format, text: string): Promise<ParseOutcome> {
    if (format === 'sql') return parseSql(text, await loadPg());
    if (format === 'prisma') return parsePrisma(text);
    throw new Error('formato não suportado neste worker: ' + format);
  },
  async warmup() {
    await loadPg();
    return true;
  },
};

export type ParserApi = typeof api;
Comlink.expose(api);
