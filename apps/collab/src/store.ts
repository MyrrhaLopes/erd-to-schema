import * as Y from 'yjs';
import { and, asc, canvases, canvasState, canvasUpdates, canvasVersions, count, type Db, desc, eq, gt, isNull, lt, lte, projects, sql } from '@erd/db';
import { nanoid } from 'nanoid';
import { Projector } from '@erd/crdt';

export interface CompactionPolicy {
  /** Compacta depois de N updates no log... */
  maxUpdates: number;
  /** ...ou quando o mais antigo passa desta idade (ms) */
  maxAgeMs: number;
}

const DEFAULT_POLICY: CompactionPolicy = { maxUpdates: 200, maxAgeMs: 10 * 60_000 };

/**
 * Persistência de um canvas (§6.1): estado compactado em `canvas_state` + log append-only
 * de updates em `canvas_updates`. Carregar = estado + updates posteriores à compactação.
 * Compactar = gravar o estado inteiro, apagar o log já incluído e recalcular o
 * `json_snapshot` (a projeção via @erd/crdt) usado na listagem e nos exports.
 */
export class CanvasStore {
  /** Tamanho do estado de cada canvas na última compactação (métrica) */
  readonly lastSize = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly policy: CompactionPolicy = DEFAULT_POLICY,
  ) {}

  /** Estado completo do canvas como um update Yjs, ou `null` se nunca foi gravado */
  async load(canvasId: string): Promise<Uint8Array | null> {
    const doc = await this.loadDoc(canvasId);
    if (!doc) return null;
    const u = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return u;
  }

  async loadDoc(canvasId: string): Promise<Y.Doc | null> {
    const [state] = await this.db.select().from(canvasState).where(eq(canvasState.canvasId, canvasId));
    const updates = await this.db
      .select({ update: canvasUpdates.update })
      .from(canvasUpdates)
      .where(and(eq(canvasUpdates.canvasId, canvasId), gt(canvasUpdates.id, state?.lastUpdateId ?? 0)))
      .orderBy(asc(canvasUpdates.id));
    if (!state && !updates.length) return null;
    const doc = new Y.Doc({ gc: true });
    doc.transact(() => {
      if (state) Y.applyUpdate(doc, state.state);
      for (const u of updates) Y.applyUpdate(doc, u.update);
    });
    return doc;
  }

  /** Acrescenta um update incremental ao log (e marca o canvas e o projeto como atualizados) */
  async append(canvasId: string, update: Uint8Array) {
    await this.db.transaction(async (tx) => {
      await tx.insert(canvasUpdates).values({ canvasId, update });
      const [c] = await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvasId)).returning({ projectId: canvases.projectId });
      if (c) await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, c.projectId));
    });
  }

  /** Precisa compactar? (N updates ou o mais antigo velho demais) */
  async shouldCompact(canvasId: string): Promise<boolean> {
    const [st] = await this.db.select({ last: canvasState.lastUpdateId }).from(canvasState).where(eq(canvasState.canvasId, canvasId));
    const after = gt(canvasUpdates.id, st?.last ?? 0);
    const [r] = await this.db
      .select({ n: count(), oldest: sql<Date | null>`min(${canvasUpdates.createdAt})` })
      .from(canvasUpdates)
      .where(and(eq(canvasUpdates.canvasId, canvasId), after));
    if (!r || r.n === 0) return false;
    if (r.n >= this.policy.maxUpdates) return true;
    return !!r.oldest && Date.now() - new Date(r.oldest).getTime() > this.policy.maxAgeMs;
  }

  /**
   * Grava o estado inteiro de `doc` e apaga do log o que ele já inclui. Só apaga updates
   * até o último lido antes da gravação: um update que chegou durante a compactação fica.
   */
  async compact(canvasId: string, doc?: Y.Doc) {
    const [last] = await this.db
      .select({ id: sql<number>`max(${canvasUpdates.id})` })
      .from(canvasUpdates)
      .where(eq(canvasUpdates.canvasId, canvasId));
    const upTo = Number(last?.id ?? 0);
    const own = !doc;
    const d = doc ?? (await this.loadDoc(canvasId));
    if (!d) return;
    let state = Y.encodeStateAsUpdate(d);
    let merged: Y.Doc | null = null;
    if (doc && upTo > 0) {
      // com várias réplicas, outra instância pode ter gravado no log um update que este
      // documento ainda não recebeu: o estado gravado inclui o log antes de apagá-lo
      const [prev] = await this.db.select({ last: canvasState.lastUpdateId }).from(canvasState).where(eq(canvasState.canvasId, canvasId));
      const pending = await this.db
        .select({ update: canvasUpdates.update })
        .from(canvasUpdates)
        .where(and(eq(canvasUpdates.canvasId, canvasId), gt(canvasUpdates.id, prev?.last ?? 0), lte(canvasUpdates.id, upTo)));
      if (pending.length) {
        state = Y.mergeUpdates([state, ...pending.map((p) => p.update)]);
        merged = new Y.Doc({ gc: true });
        Y.applyUpdate(merged, state);
      }
    }
    this.lastSize.set(canvasId, state.byteLength);
    const stateVector = Y.encodeStateVector(merged ?? d);
    const snapshot = new Projector(merged ?? d).current;
    merged?.destroy();
    if (own) d.destroy();
    await this.db.transaction(async (tx) => {
      const [prev] = await tx.select({ last: canvasState.lastUpdateId }).from(canvasState).where(eq(canvasState.canvasId, canvasId));
      const lastUpdateId = Math.max(prev?.last ?? 0, upTo);
      await tx
        .insert(canvasState)
        .values({ canvasId, state, stateVector, jsonSnapshot: snapshot, lastUpdateId, compactedAt: new Date() })
        .onConflictDoUpdate({ target: canvasState.canvasId, set: { state, stateVector, jsonSnapshot: snapshot, lastUpdateId, compactedAt: new Date() } });
      if (upTo > 0) await tx.delete(canvasUpdates).where(and(eq(canvasUpdates.canvasId, canvasId), lte(canvasUpdates.id, upTo)));
    });
  }

  /** Estado inicial de um canvas novo (import, exemplo, "enviar para a nuvem") */
  async initialize(canvasId: string, update: Uint8Array) {
    const doc = new Y.Doc({ gc: true });
    Y.applyUpdate(doc, update);
    await this.compact(canvasId, doc);
    doc.destroy();
  }

  /** Uma versão nomeada (§6.3): o estado inteiro do documento naquele momento */
  async createVersion(canvasId: string, label: string, state: Uint8Array, createdBy: string | null) {
    const id = `v_${nanoid(12)}`;
    await this.db.insert(canvasVersions).values({ id, canvasId, label, state, createdBy });
    return id;
  }

  /**
   * Snapshot automático diário (§6.3): no máximo um por canvas a cada 24 h, gravado quando
   * o documento é salvo. Os automáticos com mais de 30 dias são apagados (os nomeados ficam).
   */
  async maybeDailyVersion(canvasId: string, doc: Y.Doc, now = new Date()): Promise<boolean> {
    const [last] = await this.db
      .select({ at: canvasVersions.createdAt })
      .from(canvasVersions)
      .where(and(eq(canvasVersions.canvasId, canvasId), isNull(canvasVersions.createdBy)))
      .orderBy(desc(canvasVersions.createdAt))
      .limit(1);
    if (last && now.getTime() - last.at.getTime() < 24 * 3600_000) return false;
    const label = `Automática — ${now.toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`;
    await this.createVersion(canvasId, label, Y.encodeStateAsUpdate(doc), null);
    await this.db
      .delete(canvasVersions)
      .where(and(eq(canvasVersions.canvasId, canvasId), isNull(canvasVersions.createdBy), lt(canvasVersions.createdAt, new Date(now.getTime() - 30 * 86400_000))));
    return true;
  }

  async snapshot(canvasId: string) {
    const [st] = await this.db.select({ json: canvasState.jsonSnapshot }).from(canvasState).where(eq(canvasState.canvasId, canvasId));
    return st?.json ?? null;
  }
}
