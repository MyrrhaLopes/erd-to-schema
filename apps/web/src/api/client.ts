import { hc } from 'hono/client';
import { createAuthClient } from 'better-auth/react';
import type { ApiType } from '@erd/api';

/**
 * A web fala com a API pela mesma origem (o Caddy, ou o proxy do Vite em dev, encaminha
 * /api): sem CORS, cookie de sessão first-party, e nenhuma variável VITE_* — a mesma
 * imagem serve staging e produção.
 */
const base = () => (typeof location !== 'undefined' ? location.origin : 'http://localhost');

export const api = hc<ApiType>(`${base()}/api`, { init: { credentials: 'include' } });

export const authClient = createAuthClient({ baseURL: base(), basePath: '/api/auth' });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Corpo das respostas de sucesso de uma rota (o cliente tipado devolve a união de todas) */
type OkJson<R> = R extends { ok: false } ? never : R extends { json(): Promise<infer T> } ? T : never;

/** Desembrulha uma resposta do cliente tipado: erro HTTP vira exceção com a mensagem da API */
export async function ok<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(p: Promise<R>): Promise<OkJson<R>> {
  const r = await p;
  if (!r.ok) {
    let msg = `Erro ${r.status}`;
    try {
      const body = (await r.json()) as unknown as { error?: string; message?: string };
      msg = body.error ?? body.message ?? msg;
    } catch {
      /* sem corpo */
    }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<OkJson<R>>;
}

/** Rotas binárias (estado e updates Yjs) */
export async function getState(canvasId: string): Promise<Uint8Array> {
  const r = await fetch(`/api/canvases/${canvasId}/state`, { credentials: 'include' });
  if (!r.ok) throw new ApiError(r.status, `Falha ao carregar o canvas (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function postUpdate(canvasId: string, update: Uint8Array): Promise<void> {
  const r = await fetch(`/api/canvases/${canvasId}/updates`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/octet-stream' },
    body: update as BodyInit,
  });
  if (!r.ok) throw new ApiError(r.status, `Falha ao salvar (${r.status})`);
}

export const toBase64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
