import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';
import type { Format, Id, Project } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';
import type { Diagnostic, ParseOutcome, ParsedSchema } from '@erd/model/formats/common';
import { columnSql, generateSql } from '@erd/model/formats/sql/generate';
import { generatePrisma, prismaColumnSignature } from '@erd/model/formats/prisma/generate';
import { drizzleColumnSignature, generateDrizzle } from '@erd/model/formats/drizzle/generate';
import { reconcile, type ColumnSignature } from '@erd/model/reconcile';
import { sanitizeSchema } from '@erd/model/schema';
import { placeNewEntities } from '@erd/model/project';
import { nanoid } from 'nanoid';
import { applyDiff, codeText, isBotOrigin, Projector, roots, type BotOrigin, type ProjectDoc } from '@erd/crdt';
import { blockIds, nameIndex, splitBlocks, type Block } from './blocks';
import {
  authorAt,
  hashText,
  readSync,
  relRange,
  resolveRange,
  writeSync,
  type BlockRef,
  type Divergence,
  type FormatSync,
  type SyncDiagnostic,
} from './state';

export const GENERATORS: Record<Format, (p: Pick<Project, 'schema' | 'meta'>) => string> = {
  sql: generateSql,
  prisma: generatePrisma,
  drizzle: generateDrizzle,
};

export const SIGNATURES: Record<Format, ColumnSignature> = {
  sql: columnSql,
  prisma: prismaColumnSignature,
  drizzle: drizzleColumnSignature,
};

export type ParseFn = (format: Format, text: string) => Promise<ParseOutcome>;

export interface SyncBotOptions {
  parse: ParseFn;
  formats?: Format[];
  /** Espera depois da última digitação antes de traduzir o texto (o Ctrl+S antecipa) */
  debounceMs?: number;
  now?: () => number;
  /** Erros inesperados do próprio bot (não de parse) */
  onError?: (e: unknown) => void;
  /** Métricas: tempo de parse por formato, patches que não encaixaram */
  onMetric?: (name: 'parse' | 'divergent' | 'conflict-retry', format: Format, value: number) => void;
}

/** Os tipos do diff-match-patch declaram o patch como a classe, não a instância */
interface Patch {
  start1: number | null;
  start2: number | null;
  length1: number;
  length2: number;
}

const botOrigin = (format: Format | null, changes?: string[]): BotOrigin => ({ kind: 'sync-bot', format, changes });

/** Segmentos do texto composto (original com blocos substituídos) → offsets originais */
interface Composed {
  text: string;
  segs: { cFrom: number; cTo: number; oFrom: number; block?: number }[];
}

function compose(text: string, blocks: Block[], subst: Map<number, string>): Composed {
  const segs: Composed['segs'] = [];
  let out = '';
  let pos = 0;
  for (const i of [...subst.keys()].sort((a, b) => a - b)) {
    const b = blocks[i];
    segs.push({ cFrom: out.length, cTo: out.length + (b.from - pos), oFrom: pos });
    out += text.slice(pos, b.from);
    const rep = subst.get(i)!;
    segs.push({ cFrom: out.length, cTo: out.length + rep.length, oFrom: b.from, block: i });
    out += rep;
    pos = b.to;
  }
  segs.push({ cFrom: out.length, cTo: out.length + (text.length - pos), oFrom: pos });
  out += text.slice(pos);
  return { text: out, segs };
}

function toOriginal(c: Composed, at: number): { pos: number } | { block: number } {
  for (const s of c.segs) {
    if (at < s.cTo || (s === c.segs[c.segs.length - 1] && at <= s.cTo)) {
      if (at < s.cFrom) continue;
      return s.block !== undefined ? { block: s.block } : { pos: s.oFrom + (at - s.cFrom) };
    }
  }
  const last = c.segs[c.segs.length - 1];
  return { pos: last.oFrom + (last.cTo - last.cFrom) };
}

/** Bloco que contém `pos`, ou o anterior mais próximo (erros "no fim do input" caem fora) */
function blockAt(blocks: Block[], pos: number): number {
  let best = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].from <= pos) best = i;
    if (pos >= blocks[i].from && pos <= blocks[i].to) return i;
  }
  return best >= 0 ? best : blocks.length ? 0 : -1;
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to || (a.from === a.to && a.from >= b.from && a.from <= b.to);

/**
 * O sync bot (§4.6): o **único** tradutor texto ⇄ modelo de um documento. Os clientes só
 * escrevem o que o usuário fez (digitação nos `Y.Text`, edições do canvas no modelo); tudo
 * o que é derivado é escrito aqui, com origem `sync-bot`, que nunca entra no undo de ninguém.
 *
 * - Fluxo 1 (texto → modelo): debounce de 400 ms, parse por bloco (um bloco quebrado fica
 *   congelado e não impede os outros), reconcile e `applyDiff` numa transação só, que também
 *   aplica os patches nos outros textos.
 * - Fluxo 2 (modelo → texto): patch do diff `gerar(antes)` → `gerar(depois)` sobre o texto
 *   atual, que pode ter formatação e comentários próprios. Trecho que não encaixa vira bloco
 *   divergente, nunca uma escrita às cegas.
 *
 * Isomórfico: roda no servidor de colaboração e, no modo local, no próprio browser.
 */
export class SyncBot {
  readonly formats: Format[];
  private readonly projector: Projector;
  private readonly texts: Record<Format, Y.Text>;
  private readonly dmp = new DiffMatchPatch();
  private timers: Partial<Record<Format, ReturnType<typeof setTimeout>>> = {};
  private pending = new Set<Format>();
  private running = false;
  private flow2Scheduled = false;
  private modelRev = 0;
  private stopped = false;
  private authors: Record<Format, number[]> = { sql: [], prisma: [], drizzle: [] };
  private lastSchema: ProjectDoc['schema'];
  private lastMeta: ProjectDoc['meta'];
  private readonly onTx = (tr: Y.Transaction) => this.afterTransaction(tr);

  constructor(
    readonly doc: Y.Doc,
    private readonly opts: SyncBotOptions,
  ) {
    this.formats = opts.formats ?? FORMATS;
    this.projector = new Projector(doc);
    this.texts = Object.fromEntries(FORMATS.map((f) => [f, codeText(doc, f)])) as Record<Format, Y.Text>;
    this.dmp.Diff_Timeout = 0.5;
    this.dmp.Match_Threshold = 0.35;
    this.dmp.Patch_Margin = 8;
    const cur = this.projector.current;
    this.lastSchema = cur.schema;
    this.lastMeta = cur.meta;
  }

  private get debounce() {
    return this.opts.debounceMs ?? 400;
  }
  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** Liga o bot: confere o estado salvo e passa a observar o documento */
  start() {
    this.doc.on('afterTransaction', this.onTx);
    this.runFlow2();
    for (const f of this.formats) {
      const st = readSync(this.doc, f);
      if (st && hashText(this.texts[f].toString()) !== st.textHash) this.schedule(f, 0);
    }
    return this;
  }

  stop() {
    this.stopped = true;
    this.doc.off('afterTransaction', this.onTx);
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this.pending.clear();
  }

  /** Ctrl+S: traduz agora, sem esperar o debounce */
  flush(f: Format) {
    this.schedule(f, 0);
  }

  /** Resolve um bloco divergente: o texto vence no próximo parse, ou o bloco é regenerado do diagrama */
  resolve(f: Format, divergenceId: string, choice: 'text' | 'diagram') {
    const st = readSync(this.doc, f);
    const d = st?.divergent.find((x) => x.id === divergenceId);
    if (!st || !d) return;
    this.doc.transact(() => {
      if (choice === 'diagram') {
        const r = resolveRange(this.doc, d);
        const model = this.projector.current;
        const rep = this.genDefs(f, model, new Set(d.ids));
        if (r && rep) {
          const t = this.texts[f];
          t.delete(r.from, r.to - r.from);
          t.insert(r.from, rep);
        }
      }
      writeSync(this.doc, f, { ...st, divergent: st.divergent.filter((x) => x.id !== divergenceId), textHash: '' });
    }, botOrigin(null));
    this.schedule(f, 0);
  }

  /** Depois de "Formatar": o texto inteiro voltou ao canônico, nenhum bloco diverge mais */
  clearDivergent(f: Format) {
    const st = readSync(this.doc, f);
    if (!st?.divergent.length) return;
    this.doc.transact(() => writeSync(this.doc, f, { ...st, divergent: [], textHash: '' }), botOrigin(null));
    this.schedule(f, 0);
  }

  /** Para testes e para o desligamento: espera filas, timers e parses terminarem */
  async whenIdle(opts: { flushTimers?: boolean } = {}) {
    for (let i = 0; i < 2000; i++) {
      if (opts.flushTimers) for (const f of Object.keys(this.timers) as Format[]) this.schedule(f, 0);
      const busy = this.running || this.pending.size || this.flow2Scheduled || Object.keys(this.timers).length;
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /* ---------------------------------------------------------------- */

  private afterTransaction(tr: Y.Transaction) {
    if (this.stopped) return;
    this.projector.update(tr);
    const cur = this.projector.current;
    const modelChanged = cur.schema !== this.lastSchema || cur.meta !== this.lastMeta;
    this.lastSchema = cur.schema;
    this.lastMeta = cur.meta;
    if (isBotOrigin(tr.origin)) return;
    for (const f of this.formats) {
      if (!tr.changed.has(this.texts[f] as unknown as Y.AbstractType<Y.YEvent<Y.Text>>)) continue;
      for (const [client, clock] of tr.afterState) if ((tr.beforeState.get(client) ?? 0) < clock) this.authors[f].push(client);
      this.schedule(f, this.debounce);
    }
    if (modelChanged) {
      this.modelRev++;
      if (!this.flow2Scheduled) {
        this.flow2Scheduled = true;
        queueMicrotask(() => {
          if (!this.flow2Scheduled || this.stopped) return;
          this.flow2Scheduled = false;
          this.runFlow2();
        });
      }
    }
  }

  private schedule(f: Format, ms: number) {
    if (this.stopped || !this.formats.includes(f)) return;
    clearTimeout(this.timers[f]);
    if (ms <= 0) {
      delete this.timers[f];
      this.pending.add(f);
      void this.kick();
      return;
    }
    this.timers[f] = setTimeout(() => {
      delete this.timers[f];
      this.pending.add(f);
      void this.kick();
    }, ms);
  }

  /** Fila serial: um parse por vez por documento */
  private async kick() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size && !this.stopped) {
        const f = this.pending.values().next().value as Format;
        this.pending.delete(f);
        try {
          await this.textToModel(f);
        } catch (e) {
          this.opts.onError?.(e);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /* ---------------- fluxo 2: modelo → texto ---------------- */

  private runFlow2() {
    const model = this.projector.current;
    try {
      this.doc.transact(() => {
        for (const f of this.formats) this.modelToText(f, model);
      }, botOrigin(null));
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  private freshState(f: Format, text: string, model: ProjectDoc, base: string, textHash: string): FormatSync {
    return {
      v: 1,
      status: 'synced',
      textHash,
      base,
      baseMap: this.baseMap(f, base, model),
      blocks: this.mapBlocks(f, text, model),
      diagnostics: [],
      divergent: [],
    };
  }

  private baseMap(f: Format, base: string, model: Pick<Project, 'schema' | 'meta'>) {
    const idx = nameIndex(f, model);
    return splitBlocks(f, base).map((b) => ({ from: b.from, to: b.to, ids: blockIds(f, b, idx) }));
  }

  private mapBlocks(f: Format, text: string, model: Pick<Project, 'schema' | 'meta'>): BlockRef[] {
    const idx = nameIndex(f, model);
    return splitBlocks(f, text).map((b) => ({ ...relRange(this.texts[f], b.from, b.to), ids: blockIds(f, b, idx) }));
  }

  /** Definições canônicas (CREATE TABLE/TYPE, model, enum) das entidades dadas */
  private genDefs(f: Format, model: Pick<Project, 'schema' | 'meta'>, ids: Set<Id>, gen = GENERATORS[f](model)): string {
    if (f === 'drizzle') return ids.size ? gen : '';
    const idx = nameIndex(f, model);
    return splitBlocks(f, gen)
      .filter((b) => b.def && blockIds(f, b, idx).some((id) => ids.has(id)))
      .map((b) => gen.slice(b.from, b.to))
      .join('\n\n');
  }

  private writeTextDiff(t: Y.Text, cur: string, next: string) {
    if (cur === next) return;
    const diffs = this.dmp.diff_main(cur, next);
    this.dmp.diff_cleanupEfficiency(diffs);
    let pos = 0;
    for (const [op, s] of diffs) {
      if (op === 0) pos += s.length;
      else if (op === -1) t.delete(pos, s.length);
      else {
        t.insert(pos, s);
        pos += s.length;
      }
    }
  }

  private aliveDivergences(st: FormatSync, model: ProjectDoc): Divergence[] {
    const exists = new Set([...model.schema.tables.map((t) => t.id), ...model.schema.enums.map((e) => e.id)]);
    return st.divergent.filter((d) => {
      const r = resolveRange(this.doc, d);
      return r && r.to > r.from && d.ids.some((id) => exists.has(id));
    });
  }

  /** Deve rodar dentro de uma transação do bot */
  private modelToText(f: Format, model: ProjectDoc) {
    const t = this.texts[f];
    const cur = t.toString();
    const gen = GENERATORS[f](model);
    const st = readSync(this.doc, f);
    if (!st) {
      if (!cur.trim()) {
        t.delete(0, cur.length);
        t.insert(0, gen);
        writeSync(this.doc, f, this.freshState(f, gen, model, gen, hashText(gen)));
      } else {
        // texto sem estado (ex.: import de um .sql solto): o texto é a fonte, o próximo parse decide
        writeSync(this.doc, f, this.freshState(f, cur, model, gen, ''));
        this.schedule(f, 0);
      }
      return;
    }
    if (gen === st.base) return;
    const pendingEdit = hashText(cur) !== st.textHash;
    let next = gen;
    const failed: Patch[] = [];
    if (cur !== st.base) {
      const patches = this.dmp.patch_make(st.base, gen);
      const [patched, ok] = this.dmp.patch_apply(patches, cur);
      next = patched;
      (patches as unknown as Patch[]).forEach((p, i) => !ok[i] && failed.push(p));
    }
    this.writeTextDiff(t, cur, next);

    const divergent = this.aliveDivergences(st, model);
    if (failed.length) {
      this.opts.onMetric?.('divergent', f, failed.length);
      const oldBlocks = st.blocks.map((b) => ({ r: resolveRange(this.doc, b), ids: b.ids }));
      const curBlocks = splitBlocks(f, next);
      for (const p of failed) {
        const pFrom = p.start1 ?? 0;
        const pRange = { from: pFrom, to: pFrom + (p.length1 ?? 0) };
        const ids = [...new Set(st.baseMap.filter((b) => overlaps(b, pRange)).flatMap((b) => b.ids))];
        // onde o bloco dessas entidades está agora (o trecho pode ter sido reescrito inteiro:
        // a âncora antiga cai no lugar dele) → o bloco atual naquele ponto
        const anchor = oldBlocks.find((b) => b.r && b.ids.some((id) => ids.includes(id)))?.r?.from ?? p.start2 ?? pFrom;
        const bi = blockAt(curBlocks, Math.max(0, Math.min(next.length, anchor)));
        if (bi < 0) continue;
        const range = curBlocks[bi];
        const already = divergent.find((d) => {
          const r = resolveRange(this.doc, d);
          return r && overlaps(r, range);
        });
        const names = ids.map((id) => model.schema.tables.find((x) => x.id === id)?.name ?? model.schema.enums.find((x) => x.id === id)?.name).filter(Boolean);
        const message = `Este bloco difere do diagrama: ${names.length ? names.join(', ') : 'o modelo'} mudou no canvas enquanto o texto estava em edição.`;
        if (already) {
          already.ids = [...new Set([...already.ids, ...ids])];
          already.message = message;
        } else divergent.push({ id: nanoid(8), ...relRange(t, range.from, range.to), ids, message });
      }
    }
    writeSync(this.doc, f, {
      ...st,
      base: gen,
      baseMap: this.baseMap(f, gen, model),
      textHash: pendingEdit ? st.textHash : hashText(next),
      blocks: pendingEdit ? st.blocks : this.mapBlocks(f, next, model),
      divergent,
    });
  }

  /* ---------------- fluxo 1: texto → modelo ---------------- */

  private invalidated(f: Format, text: string, rev: number) {
    return this.stopped || this.texts[f].toString() !== text || this.modelRev !== rev;
  }

  private async textToModel(f: Format) {
    // um patch modelo → texto pendente vai antes: ele pode marcar blocos divergentes
    // que este parse precisa congelar
    if (this.flow2Scheduled) {
      this.flow2Scheduled = false;
      this.runFlow2();
    }
    const t = this.texts[f];
    const text = t.toString();
    const h = hashText(text);
    let st = readSync(this.doc, f);
    if (st && h === st.textHash) return;
    const rev = this.modelRev;
    const model = this.projector.current;
    if (!st) st = this.freshState(f, text, model, GENERATORS[f](model), '');

    const blocks = splitBlocks(f, text);
    const ranges = blocks.map((b) => relRange(t, b.from, b.to));
    const old = st.blocks.map((b) => ({ r: resolveRange(this.doc, b), ids: b.ids }));
    const divs = this.aliveDivergences(st, model).map((d) => resolveRange(this.doc, d)!);
    const idx0 = nameIndex(f, model);
    const frozenOf = (b: Block): Set<Id> => {
      const ids = new Set<Id>();
      for (const o of old) if (o.r && overlaps(o.r, b)) o.ids.forEach((id) => ids.add(id));
      if (!ids.size) blockIds(f, b, idx0).forEach((id) => ids.add(id));
      // no Drizzle (arquivo inteiro) congelar = não mexer em nada
      return ids;
    };
    const gen0 = GENERATORS[f](model);
    const subst = new Map<number, string>();
    const broken = new Map<number, Diagnostic[]>();
    blocks.forEach((b, i) => {
      if (divs.some((d) => overlaps(d, b))) subst.set(i, b.def ? this.genDefs(f, model, frozenOf(b), gen0) : '');
    });

    let parsed: ParsedSchema | undefined;
    let comp: Composed = compose(text, blocks, subst);
    let lastDiags: Diagnostic[] = [];
    for (let iter = 0; iter <= blocks.length + 1; iter++) {
      comp = compose(text, blocks, subst);
      const t0 = this.now();
      const r = await this.opts.parse(f, comp.text);
      this.opts.onMetric?.('parse', f, this.now() - t0);
      if (this.invalidated(f, text, rev)) {
        this.opts.onMetric?.('conflict-retry', f, 1);
        if (!this.timers[f]) this.pending.add(f);
        return;
      }
      if (r.ok) {
        parsed = r.parsed;
        break;
      }
      lastDiags = r.diagnostics;
      const errs = r.diagnostics.filter((d) => d.severity === 'error');
      if (f === 'drizzle' || !errs.length) break;
      let progressed = false;
      for (const e of errs) {
        const o = toOriginal(comp, e.from);
        if ('block' in o) {
          // a versão do modelo também não parseia aqui: cai para o bloco em branco
          if (subst.get(o.block)) {
            subst.set(o.block, '');
            progressed = true;
          }
          continue;
        }
        let bi = blockAt(blocks, o.pos);
        // erro no primeiro token de um bloco (ex.: `syntax error at or near "CREATE"`):
        // quem não terminou foi o bloco anterior
        if (bi > 0 && o.pos <= blocks[bi].from) bi--;
        while (bi >= 0 && subst.has(bi)) bi--;
        if (bi < 0) continue;
        const b = blocks[bi];
        subst.set(bi, b.def ? this.genDefs(f, model, frozenOf(b), gen0) : '');
        const len = Math.max(1, e.to - e.from);
        broken.set(bi, [...(broken.get(bi) ?? []), { ...e, from: o.pos, to: Math.min(text.length, o.pos + len) }]);
        progressed = true;
      }
      if (!progressed) break;
    }

    if (!parsed) {
      // não deu para isolar o erro: nada muda no modelo, só o diagnóstico
      const diagnostics = this.mapDiagnostics(f, text, comp, lastDiags);
      this.doc.transact(() => writeSync(this.doc, f, { ...(readSync(this.doc, f) ?? st!), status: 'error', textHash: h, diagnostics }), botOrigin(null));
      return;
    }

    const frozen = new Set<Id>();
    for (const i of subst.keys()) frozenOf(blocks[i]).forEach((id) => frozen.add(id));
    const rec = reconcile(model, parsed, f, SIGNATURES[f], { frozen });
    const after: ProjectDoc = { ...model, schema: rec.schema, meta: rec.meta, layout: { ...model.layout } };
    sanitizeSchema(after.schema);
    placeNewEntities(after);

    // blocos do texto atual → IDs finais
    const pIdx = nameIndex(f, parsed);
    const mapId = (id: Id) => rec.idMap.get(id) ?? id;
    const blockRefs: BlockRef[] = blocks.map((b, i) => ({
      ...ranges[i],
      ids: subst.has(i) ? [...frozenOf(b)] : f === 'drizzle' ? blockIds(f, b, nameIndex(f, after)) : blockIds(f, b, pIdx).map(mapId),
    }));
    const diagnostics: SyncDiagnostic[] = [];
    for (const errs of broken.values()) for (const e of errs) diagnostics.push(this.diag(t, e));
    diagnostics.push(...this.mapDiagnostics(f, text, comp, parsed.warnings));

    const author = this.lastAuthor(f);
    const changes = rec.changes;
    this.doc.transact(() => {
      applyDiff(this.doc, model, after, { by: author, at: this.now() });
      const gen = GENERATORS[f](after);
      const stNow = readSync(this.doc, f) ?? st!;
      writeSync(this.doc, f, {
        ...stNow,
        status: broken.size ? 'error' : 'synced',
        textHash: h,
        base: gen,
        baseMap: this.baseMap(f, gen, after),
        blocks: blockRefs,
        diagnostics,
        divergent: this.aliveDivergences(stNow, after),
        change: changes.length ? { id: nanoid(8), items: changes, by: author, at: this.now() } : stNow.change,
      });
      for (const g of this.formats) if (g !== f) this.modelToText(g, after);
    }, botOrigin(f, changes));
  }

  private lastAuthor(f: Format): string | undefined {
    const clients = roots(this.doc).clients;
    const list = this.authors[f];
    this.authors[f] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const u = clients.get(String(list[i]));
      if (u) return u;
    }
    return undefined;
  }

  private diag(t: Y.Text, d: Diagnostic): SyncDiagnostic {
    const from = Math.max(0, Math.min(t.length, d.from));
    const to = Math.max(from, Math.min(t.length, d.to));
    return { ...relRange(t, from, to), severity: d.severity, message: d.message, author: authorAt(this.doc, t, from) };
  }

  private mapDiagnostics(f: Format, _text: string, comp: Composed, ds: Diagnostic[]): SyncDiagnostic[] {
    const out: SyncDiagnostic[] = [];
    for (const d of ds) {
      const a = toOriginal(comp, d.from);
      if ('block' in a) continue;
      const b = toOriginal(comp, Math.max(d.from, d.to));
      const to = 'pos' in b ? b.pos : a.pos + 1;
      out.push(this.diag(this.texts[f], { ...d, from: a.pos, to }));
    }
    return out;
  }
}
