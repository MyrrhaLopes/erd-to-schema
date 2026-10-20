import { create } from 'zustand';
import type * as Y from 'yjs';
import type { Format } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';
import type { Diagnostic } from '@erd/model/formats/common';
import { codeText, roots } from '@erd/crdt';
import { GENERATORS, hashText, readSync, resolveRange } from '@erd/sync';
import type { Session } from '../collab/session';
import { parseInWorker } from './parserClient';

export type PanelStatus = 'synced' | 'editing' | 'error';

export interface PanelDiagnostic extends Diagnostic {
  author?: string;
}

export interface DivergentBlock {
  id: string;
  from: number;
  to: number;
  message: string;
}

export interface PanelState {
  status: PanelStatus;
  /** Diagnósticos do texto atual: o lint local enquanto há edição pendente, os do bot depois */
  diagnostics: PanelDiagnostic[];
  divergent: DivergentBlock[];
}

interface PanelsStore {
  panels: Record<Format, PanelState>;
}

const initial = (): PanelState => ({ status: 'synced', diagnostics: [], divergent: [] });

export const usePanels = create<PanelsStore>(() => ({
  panels: { sql: initial(), prisma: initial(), drizzle: initial() },
}));

const LINT_MS = 200;

/**
 * Estado dos painéis a partir do documento: status e diagnósticos que o bot escreveu em
 * `sync.<formato>`, mais o **lint local instantâneo** (§4.6): enquanto alguém digita, o worker
 * local mostra os erros sem esperar o bot e sem escrever nada no documento.
 */
export function bindPanels(session: Session): () => void {
  const doc = session.doc;
  const lint: Partial<Record<Format, { hash: string; diagnostics: Diagnostic[] }>> = {};
  const timers: Partial<Record<Format, ReturnType<typeof setTimeout>>> = {};
  let alive = true;

  const recompute = (f: Format) => {
    const text = codeText(doc, f).toString();
    const h = hashText(text);
    const st = readSync(doc, f);
    const pending = !!st && h !== st.textHash;
    const divergent: DivergentBlock[] = [];
    for (const d of st?.divergent ?? []) {
      const r = resolveRange(doc, d);
      if (r && r.to > r.from) divergent.push({ id: d.id, ...r, message: d.message });
    }
    let diagnostics: PanelDiagnostic[] = [];
    let status: PanelStatus = 'synced';
    if (pending) {
      status = 'editing';
      const l = lint[f];
      if (l?.hash === h) {
        diagnostics = l.diagnostics;
        if (l.diagnostics.some((d) => d.severity === 'error')) status = 'error';
      }
    } else if (st) {
      for (const d of st.diagnostics) {
        const r = resolveRange(doc, d);
        if (r) diagnostics.push({ from: r.from, to: Math.max(r.to, r.from), severity: d.severity, message: d.message, author: d.author });
      }
      status = st.status === 'error' ? 'error' : 'synced';
    }
    usePanels.setState((s) => ({ panels: { ...s.panels, [f]: { status, diagnostics, divergent } } }));
  };

  const scheduleLint = (f: Format) => {
    clearTimeout(timers[f]);
    timers[f] = setTimeout(async () => {
      const text = codeText(doc, f).toString();
      const h = hashText(text);
      const st = readSync(doc, f);
      if (st && st.textHash === h) return recompute(f);
      const r = await parseInWorker(f, text);
      if (!alive) return;
      lint[f] = { hash: h, diagnostics: r.ok ? r.parsed.warnings : r.diagnostics };
      recompute(f);
    }, LINT_MS);
  };

  const texts = FORMATS.map((f) => [f, codeText(doc, f)] as const);
  const observers = texts.map(([f, t]) => {
    const fn = () => {
      recompute(f);
      scheduleLint(f);
    };
    t.observe(fn);
    return () => t.unobserve(fn);
  });
  const sync = roots(doc).sync;
  const onSync = (e: Y.YMapEvent<unknown>) => {
    for (const k of e.keysChanged) if ((FORMATS as string[]).includes(k)) recompute(k as Format);
  };
  sync.observe(onSync);
  FORMATS.forEach(recompute);

  return () => {
    alive = false;
    observers.forEach((off) => off());
    sync.unobserve(onSync);
    for (const t of Object.values(timers)) clearTimeout(t);
    usePanels.setState({ panels: { sql: initial(), prisma: initial(), drizzle: initial() } });
  };
}

/** Texto canônico do modelo atual (para "Formatar") */
export function canonicalText(f: Format, model: Parameters<(typeof GENERATORS)['sql']>[0]) {
  return GENERATORS[f](model);
}
