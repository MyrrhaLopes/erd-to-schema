import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import * as Y from 'yjs';
import { Hocuspocus, type Connection, type Document, type Extension } from '@hocuspocus/server';
import crossws from 'crossws/adapters/node';
import { jwtVerify } from 'jose';
import { parse as pgParse } from 'libpg-query';
import { CollabClaimsZ, StatelessZ, type CollabClaims, type PermissionChanged, type Role } from '@erd/contracts';
import { roots } from '@erd/crdt';
import { parseSql } from '@erd/model/formats/sql/parse';
import { parsePrisma } from '@erd/model/formats/prisma/parse';
import type { Format } from '@erd/model/types';
import type { ParseOutcome } from '@erd/model/formats/common';
import { SyncBot } from '@erd/sync';
import { createDrizzleSandbox, type DrizzleSandbox } from '@erd/sandbox';
import type { CanvasStore } from './store';

export const docName = (canvasId: string) => `canvas:${canvasId}`;
export const canvasIdOf = (name: string) => (name.startsWith('canvas:') ? name.slice(7) : null);

/** Limites por conexão (§6.1): update grande demais ou rajada de mensagens derrubam a conexão */
export const MAX_UPDATE_BYTES = 1024 * 1024;
const RATE_WINDOW_MS = 1000;
const RATE_MAX_MESSAGES = 400;

export interface CollabContext {
  user: { id: string; name: string; role: Role; color: number };
  projectId: string;
  canvasId: string;
  rate?: { start: number; n: number };
}

export interface CollabLogger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface CollabMetrics {
  documents: number;
  connections: number;
  parses: Record<Format, { count: number; totalMs: number }>;
  sandboxTimeouts: number;
  sandboxCrashes: number;
  divergentPatches: number;
  rejectedUpdates: number;
  storedBytes: number;
}

export interface CollabOptions {
  store: CanvasStore;
  jwtSecret: string;
  log: CollabLogger;
  /** Confere no banco se a pessoa ainda tem acesso (o token é curto, mas a mudança de papel é imediata) */
  currentRole?: (projectId: string, userId: string) => Promise<Role | null>;
  sandbox?: DrizzleSandbox;
  debounceMs?: number;
  maxDebounceMs?: number;
  botDebounceMs?: number;
  /** Extensões extras (ex.: Redis na fase 7) */
  extensions?: Extension[];
}

/**
 * O servidor de colaboração (§6): salas por documento (`canvas:<id>`), autenticação por
 * JWT curto emitido pela API, conexões read-only para viewers, persistência no Postgres
 * (log de updates + compactação) e o sync bot de cada documento carregado.
 */
export function createCollab(o: CollabOptions) {
  const key = new TextEncoder().encode(o.jwtSecret);
  const sandbox =
    o.sandbox ??
    createDrizzleSandbox({
      onEvent: (e) => {
        if (e.type === 'timeout') metrics.sandboxTimeouts++;
        if (e.type === 'crash' || e.type === 'memory') metrics.sandboxCrashes++;
        o.log.warn({ sandbox: e }, 'sandbox do drizzle');
      },
    });
  const bots = new Map<string, SyncBot>();
  const lastStored = new Map<string, Uint8Array>();
  const metrics: CollabMetrics = {
    documents: 0,
    connections: 0,
    parses: { sql: { count: 0, totalMs: 0 }, prisma: { count: 0, totalMs: 0 }, drizzle: { count: 0, totalMs: 0 } },
    sandboxTimeouts: 0,
    sandboxCrashes: 0,
    divergentPatches: 0,
    rejectedUpdates: 0,
    storedBytes: 0,
  };

  const parse = (f: Format, text: string): Promise<ParseOutcome> =>
    f === 'sql' ? parseSql(text, pgParse as never) : f === 'prisma' ? Promise.resolve(parsePrisma(text)) : sandbox.parse(text);

  /** Grava o que mudou desde o último store (update incremental) e compacta quando passa da conta */
  async function persist(document: Document) {
    const canvasId = canvasIdOf(document.name);
    if (!canvasId) return;
    const prev = lastStored.get(document.name);
    const sv = Y.encodeStateVector(document);
    const update = prev ? Y.encodeStateAsUpdate(document, prev) : Y.encodeStateAsUpdate(document);
    // update vazio (só cabeçalho) não vai para o log
    if (update.byteLength > 2) {
      await o.store.append(canvasId, update);
      metrics.storedBytes += update.byteLength;
    }
    lastStored.set(document.name, sv);
    if (await o.store.shouldCompact(canvasId)) await o.store.compact(canvasId, document);
  }

  /** Autoria (§5.5): o `clientID` do Yjs de cada conexão → o usuário, escrito pelo servidor */
  function recordAuthors(document: Document, update: Uint8Array, userId: string) {
    let clients: number[];
    try {
      clients = [...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))];
    } catch {
      return;
    }
    const map = roots(document).clients;
    const missing = clients.filter((c) => map.get(String(c)) !== userId);
    if (!missing.length) return;
    queueMicrotask(() => document.transact(() => missing.forEach((c) => map.set(String(c), userId)), { source: 'local' }));
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'erd-collab',
    quiet: true,
    debounce: o.debounceMs ?? 2000,
    maxDebounce: o.maxDebounceMs ?? 10_000,
    yDocOptions: { gc: true, gcFilter: () => true },
    unloadImmediately: false,
    extensions: o.extensions ?? [],

    async onAuthenticate({ token, documentName, connectionConfig }) {
      let claims: CollabClaims;
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
        claims = CollabClaimsZ.parse(payload);
      } catch {
        throw new Error('token inválido ou expirado');
      }
      if (documentName !== docName(claims.canvasId)) throw new Error('token de outro canvas');
      let role = claims.role;
      if (o.currentRole) {
        const now = await o.currentRole(claims.projectId, claims.sub);
        if (!now) throw new Error('sem acesso a este projeto');
        role = now;
      }
      // viewer: os updates que essa conexão mandar são descartados; a awareness continua
      if (role === 'viewer') connectionConfig.readOnly = true;
      return {
        user: { id: claims.sub, name: claims.name, role, color: claims.color },
        projectId: claims.projectId,
        canvasId: claims.canvasId,
      } satisfies CollabContext;
    },

    async onLoadDocument({ document, documentName }) {
      const canvasId = canvasIdOf(documentName);
      if (!canvasId) throw new Error('documento desconhecido');
      const state = await o.store.load(canvasId);
      if (state) Y.applyUpdate(document, state, { source: 'local', skipStoreHooks: true });
      lastStored.set(documentName, Y.encodeStateVector(document));
      return document;
    },

    async afterLoadDocument({ document, documentName }) {
      metrics.documents = hocuspocus.getDocumentsCount();
      const bot = new SyncBot(document, {
        parse,
        debounceMs: o.botDebounceMs,
        onError: (e) => o.log.error({ err: e, documentName }, 'sync bot'),
        onMetric: (name, format, value) => {
          if (name === 'parse') {
            metrics.parses[format].count++;
            metrics.parses[format].totalMs += value;
          } else if (name === 'divergent') metrics.divergentPatches += value;
        },
      });
      bots.set(documentName, bot.start());
    },

    async beforeHandleMessage({ connection, update, context }) {
      if (update.byteLength > MAX_UPDATE_BYTES) {
        metrics.rejectedUpdates++;
        throw new Error('mensagem grande demais');
      }
      const now = Date.now();
      const r = (context.rate ??= { start: now, n: 0 });
      if (now - r.start > RATE_WINDOW_MS) {
        r.start = now;
        r.n = 0;
      }
      if (++r.n > RATE_MAX_MESSAGES) {
        metrics.rejectedUpdates++;
        o.log.warn({ userId: context.user.id, socket: connection.socketId }, 'limite de taxa por conexão');
        throw new Error('muitas mensagens');
      }
    },

    async onChange({ document, update, context, connection }) {
      if (connection && context?.user) recordAuthors(document, update, context.user.id);
    },

    async onStoreDocument({ document }) {
      await persist(document);
    },

    async onStateless({ connection, document, payload }) {
      const ctx = connection.context as CollabContext;
      let msg;
      try {
        msg = StatelessZ.parse(JSON.parse(payload));
      } catch {
        return;
      }
      if (connection.readOnly) return;
      const bot = bots.get(document.name);
      if (!bot) return;
      if (msg.type === 'flush') bot.flush(msg.format);
      else if (msg.type === 'resolve') bot.resolve(msg.format, msg.id, msg.choice);
      else if (msg.type === 'clear-divergent') bot.clearDivergent(msg.format);
      o.log.info({ userId: ctx.user.id, canvasId: ctx.canvasId, msg: msg.type }, 'stateless');
    },

    async onConnect() {
      metrics.connections = hocuspocus.getConnectionsCount() + 1;
    },

    async onDisconnect() {
      metrics.connections = hocuspocus.getConnectionsCount();
    },

    async beforeUnloadDocument({ documentName }) {
      // o bot termina o que estiver traduzindo antes do último store
      const bot = bots.get(documentName);
      if (bot) await bot.whenIdle({ flushTimers: true });
    },

    async afterUnloadDocument({ documentName }) {
      bots.get(documentName)?.stop();
      bots.delete(documentName);
      lastStored.delete(documentName);
      metrics.documents = hocuspocus.getDocumentsCount();
    },
  });

  const ws = crossws({
    hooks: {
      open(peer) {
        const conn = hocuspocus.handleConnection(peer.websocket as never, peer.request as Request);
        (peer as unknown as { _hp: typeof conn })._hp = conn;
        (peer.websocket as unknown as { on?: (e: string, f: () => void) => void }).on?.('pong', () => conn.touch());
      },
      message(peer, message) {
        (peer as unknown as { _hp?: { handleMessage(d: Uint8Array): void } })._hp?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (peer as unknown as { _hp?: { handleClose(e: { code?: number; reason?: string }): void } })._hp?.handleClose({ code: event.code, reason: event.reason });
      },
      error(peer, error) {
        o.log.warn({ err: error, peer: peer.id }, 'erro no WebSocket');
      },
    },
  });

  /** Conexões abertas de um usuário num projeto (para mudança de papel ao vivo) */
  function connectionsOf(projectId: string, userId: string): Connection<CollabContext>[] {
    const out: Connection<CollabContext>[] = [];
    for (const d of hocuspocus.documents.values())
      for (const c of d.connections.keys()) {
        const ctx = c.context as CollabContext;
        if (ctx?.projectId === projectId && ctx.user.id === userId) out.push(c as Connection<CollabContext>);
      }
    return out;
  }

  return {
    hocuspocus,
    metrics,
    sandbox,
    bots,

    /** Liga o WebSocket ao servidor HTTP da API (mesmo processo, mesma porta) */
    attach(server: HttpServer, path = '/collab') {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== path && !url.pathname.startsWith(path + '/')) return;
        void ws.handleUpgrade(req, socket, head);
      });
    },

    /** Escrita vinda da API (import, restauração de versão): no documento vivo, se houver */
    writer: {
      async apply(canvasId: string, update: Uint8Array) {
        const name = docName(canvasId);
        if (hocuspocus.documents.has(name)) {
          const dc = await hocuspocus.openDirectConnection(name);
          await dc.transact((doc) => Y.applyUpdate(doc, update));
          await dc.disconnect();
          return;
        }
        await o.store.append(canvasId, update);
        if (await o.store.shouldCompact(canvasId)) await o.store.compact(canvasId);
      },
      async read(canvasId: string) {
        const doc = hocuspocus.documents.get(docName(canvasId));
        if (doc) return Y.encodeStateAsUpdate(doc);
        return o.store.load(canvasId);
      },
    },

    /** Mudança de papel (§3): avisa as conexões abertas; sem papel, fecha a conexão */
    permissionChanged(e: PermissionChanged) {
      for (const c of connectionsOf(e.projectId, e.userId)) {
        c.sendStateless(JSON.stringify({ type: 'permission-changed', role: e.role }));
        if (e.role === null) c.close({ code: 4403, reason: 'acesso removido' } as CloseEvent);
        else {
          // rebaixar vale na hora; promover exige reconectar com um token novo (o cliente faz isso)
          if (e.role === 'viewer') c.readOnly = true;
          (c.context as CollabContext).user.role = e.role;
        }
      }
    },

    /** Avisa os clientes de um canvas (ex.: versão restaurada) */
    broadcast(canvasId: string, payload: object) {
      const d = hocuspocus.documents.get(docName(canvasId));
      if (d) for (const c of d.connections.keys()) c.sendStateless(JSON.stringify(payload));
    },

    /**
     * Desligamento (§15.2): grava os documentos pendentes (o store tem debounce de até 10 s,
     * e perder isso seria perder edições) e fecha os WebSockets com "reconecte" — os clientes
     * Yjs reconectam no container novo e reenviam o que faltar.
     */
    async shutdown() {
      for (const bot of bots.values()) await bot.whenIdle({ flushTimers: true });
      for (const d of hocuspocus.documents.values()) await persist(d);
      hocuspocus.closeConnections();
      for (const bot of bots.values()) bot.stop();
      await sandbox.close();
    },
  };
}

export type Collab = ReturnType<typeof createCollab>;
