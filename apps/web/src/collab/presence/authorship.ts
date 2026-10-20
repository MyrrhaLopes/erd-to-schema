import * as Y from 'yjs';
import { create } from 'zustand';
import { roots } from '@erd/crdt';
import type { Id } from '@erd/model/types';
import type { Session } from '../session';
import { personOf } from './index';

/** Chave de uma entidade ou de uma coluna (`tabela:coluna`) */
export const colKey = (tableId: Id, colId: Id) => `${tableId}:${colId}`;

export interface Mark {
  userId?: string;
  name: string;
  color: string;
  at: number;
}

/** Rastro recente (§5.5, camada 1): o que outra pessoa acabou de mudar acende na cor dela */
export const useRecent = create<{ items: Map<string, Mark> }>(() => ({ items: new Map() }));

/** Autoria persistente (§5.5, camada 2): `_by`/`_at` de cada entidade e coluna, lidos só com "Mostrar autoria" ligado */
export const useStamps = create<{ items: Map<string, { by: string; at?: number }> }>(() => ({ items: new Map() }));

export const RECENT_MS = 8000;

const ENTITY_ROOTS = ['tables', 'enums', 'notes', 'relationships'] as const;

/** Quem escreveu a transação: o `_by` da entidade, ou o cliente Yjs cujo relógio avançou → mapa `clients` */
function authorOf(doc: Y.Doc, tr: Y.Transaction, entity: Y.Map<unknown> | undefined): string | undefined {
  const by = entity?.get('_by');
  if (typeof by === 'string') return by;
  const clients = roots(doc).clients;
  for (const [client, clock] of tr.afterState) if (clock > (tr.beforeState.get(client) ?? 0)) return clients.get(String(client));
  return undefined;
}

export function bindRecent(session: Session): () => void {
  const doc = session.doc;
  const r = roots(doc);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const light = (keys: string[], userId: string | undefined) => {
    if (!keys.length || !userId || userId === session.userId) return;
    const p = personOf(userId);
    const mark: Mark = { userId, name: p?.name ?? 'Alguém', color: p?.color ?? '#64748b', at: Date.now() };
    useRecent.setState((s) => {
      const items = new Map(s.items);
      for (const k of keys) items.set(k, mark);
      return { items };
    });
    const t = setTimeout(() => {
      timers.delete(t);
      useRecent.setState((s) => {
        const items = new Map(s.items);
        for (const k of keys) if (items.get(k) === mark) items.delete(k);
        return { items };
      });
    }, RECENT_MS);
    timers.add(t);
  };

  const offs = ENTITY_ROOTS.map((name) => {
    const root = r[name] as Y.Map<Y.Map<unknown>>;
    const fn = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
      if (tr.local) return;
      const byAuthor = new Map<string | undefined, Set<string>>();
      const add = (key: string, entity: Y.Map<unknown> | undefined) => {
        const a = authorOf(doc, tr, entity);
        if (!byAuthor.has(a)) byAuthor.set(a, new Set());
        byAuthor.get(a)!.add(key);
      };
      for (const e of events) {
        const path = e.path as (string | number)[];
        if (path.length === 0) {
          // entidades criadas ou removidas
          for (const k of (e as Y.YMapEvent<unknown>).keysChanged) if (root.has(k)) add(k, root.get(k));
          continue;
        }
        const id = String(path[0]);
        const entity = root.get(id);
        if (!entity) continue;
        if (name === 'tables' && path[1] === 'columns') {
          if (path.length === 2) for (const k of (e as Y.YMapEvent<unknown>).keysChanged) add(colKey(id, k), entity);
          else add(colKey(id, String(path[2])), entity);
        }
        add(id, entity);
      }
      for (const [a, keys] of byAuthor) light([...keys], a);
    };
    root.observeDeep(fn);
    return () => root.unobserveDeep(fn);
  });

  return () => {
    offs.forEach((off) => off());
    timers.forEach(clearTimeout);
    useRecent.setState({ items: new Map() });
  };
}

function readStamps(doc: Y.Doc) {
  const items = new Map<string, { by: string; at?: number }>();
  const r = roots(doc);
  const take = (key: string, y: Y.Map<unknown>) => {
    const by = y.get('_by');
    if (typeof by === 'string') items.set(key, { by, at: y.get('_at') as number | undefined });
  };
  for (const name of ['tables', 'enums', 'notes'] as const)
    r[name].forEach((y, id) => {
      take(id, y);
      const cols = y.get('columns');
      if (name === 'tables' && cols instanceof Y.Map) (cols as Y.Map<Y.Map<unknown>>).forEach((c, cid) => take(colKey(id, cid), c));
    });
  return items;
}

/** Lê os carimbos enquanto o modo "Mostrar autoria" estiver ligado */
export function bindStamps(session: Session): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => useStamps.setState({ items: readStamps(session.doc) });
  const onUpdate = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  refresh();
  session.doc.on('update', onUpdate);
  return () => {
    clearTimeout(timer);
    session.doc.off('update', onUpdate);
    useStamps.setState({ items: new Map() });
  };
}

export function relTimeShort(at?: number) {
  if (!at) return '';
  const d = (Date.now() - at) / 1000;
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.floor(d / 60)} min`;
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  return new Date(at).toLocaleDateString('pt-BR');
}
