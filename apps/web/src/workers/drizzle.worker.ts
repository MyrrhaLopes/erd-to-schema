/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { ParseOutcome } from '@erd/model/formats/common';
import { parseDrizzle } from '@erd/model/formats/drizzle/parse';

// Este worker executa o código TypeScript do usuário (transpilado com sucrase)
// contra o drizzle-orm real. Não tem acesso ao DOM; o `require` só resolve
// drizzle-orm. Loops infinitos são encerrados pelo timeout do cliente (terminate).
const api = {
  async parse(_format: 'drizzle', text: string): Promise<ParseOutcome> {
    return parseDrizzle(text);
  },
  async warmup() {
    return true;
  },
};

export type DrizzleApi = typeof api;
Comlink.expose(api);
