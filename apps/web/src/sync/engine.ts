import { create } from 'zustand';
import type { Format, Project } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';
import type { Diagnostic, ParsedSchema } from '@erd/model/formats/common';
import { columnSql, generateSql } from '@erd/model/formats/sql/generate';
import { generatePrisma, prismaColumnSignature } from '@erd/model/formats/prisma/generate';
import { drizzleColumnSignature, generateDrizzle } from '@erd/model/formats/drizzle/generate';
import { reconcile, type ColumnSignature } from '@erd/model/reconcile';
import { getProject, useProjectStore } from '../store/useProjectStore';
import { parseInWorker } from './parserClient';

export type PanelStatus = 'synced' | 'editing' | 'parsing' | 'error';

export interface PanelState {
  text: string;
  status: PanelStatus;
  /** O modelo mudou por outra via enquanto este painel tinha edição pendente/erro */
  conflict: boolean;
  diagnostics: Diagnostic[];
  baseRev: number;
}

interface PanelsStore {
  panels: Record<Format, PanelState>;
  /** Parse bem-sucedido aguardando decisão do usuário por causa de conflito */
  pending: Partial<Record<Format, ParsedSchema>>;
}

const initialPanel = (): PanelState => ({ text: '', status: 'synced', conflict: false, diagnostics: [], baseRev: -1 });

export const usePanels = create<PanelsStore>(() => ({
  panels: { sql: initialPanel(), prisma: initialPanel(), drizzle: initialPanel() },
  pending: {},
}));

export const GENERATORS: Record<Format, (p: Pick<Project, 'schema' | 'meta'>) => string> = {
  sql: generateSql,
  prisma: generatePrisma,
  drizzle: generateDrizzle,
};

const SIGNATURES: Record<Format, ColumnSignature> = {
  sql: columnSql,
  prisma: prismaColumnSignature,
  drizzle: drizzleColumnSignature,
};

const DEBOUNCE_MS = 400;
const timers: Partial<Record<Format, ReturnType<typeof setTimeout>>> = {};
const seqs: Record<Format, number> = { sql: 0, prisma: 0, drizzle: 0 };

function patch(f: Format, p: Partial<PanelState>) {
  usePanels.setState((s) => ({ panels: { ...s.panels, [f]: { ...s.panels[f], ...p } } }));
}

export function regenerate(f: Format) {
  clearTimeout(timers[f]);
  seqs[f]++;
  const text = GENERATORS[f](getProject());
  patch(f, { text, status: 'synced', conflict: false, diagnostics: [], baseRev: useProjectStore.getState().rev });
  usePanels.setState((s) => ({ pending: { ...s.pending, [f]: undefined } }));
}

/** Edição local vinda do editor (nunca de uma transação remota) */
export function onLocalEdit(f: Format, text: string) {
  patch(f, { text, status: 'editing' });
  clearTimeout(timers[f]);
  timers[f] = setTimeout(() => void parseNow(f), DEBOUNCE_MS);
}

/** Ctrl+S / blur: aplica sem esperar o debounce */
export function flush(f: Format) {
  const st = usePanels.getState().panels[f].status;
  if (st === 'editing') {
    clearTimeout(timers[f]);
    void parseNow(f);
  }
}

async function parseNow(f: Format) {
  const seq = ++seqs[f];
  const text = usePanels.getState().panels[f].text;
  patch(f, { status: 'parsing' });
  const result = await parseInWorker(f, text);
  // resultado desatualizado (houve nova digitação ou regeneração) → descarta
  if (seq !== seqs[f] || usePanels.getState().panels[f].text !== text) return;
  if (!result.ok) {
    patch(f, { status: 'error', diagnostics: result.diagnostics });
    return;
  }
  if (usePanels.getState().panels[f].conflict) {
    usePanels.setState((s) => ({ pending: { ...s.pending, [f]: result.parsed } }));
    patch(f, { status: 'editing', diagnostics: result.parsed.warnings });
    return;
  }
  apply(f, result.parsed);
}

export function apply(f: Format, parsed: ParsedSchema) {
  const project = getProject();
  const r = reconcile(project, parsed, f, SIGNATURES[f]);
  usePanels.setState((s) => ({ pending: { ...s.pending, [f]: undefined } }));
  const same =
    generateSql(r) === generateSql(project) &&
    stable(r.meta) === stable(project.meta) &&
    GENERATORS[f](r) === GENERATORS[f](project);
  patch(f, { status: 'synced', conflict: false, diagnostics: parsed.warnings, baseRev: useProjectStore.getState().rev });
  if (same) return;
  useProjectStore.getState().commit(
    (d) => {
      d.schema = r.schema;
      // meta de notas e outras entidades fora do schema já foi preservada pelo reconcile
      d.meta = r.meta;
    },
    f,
    r.changes.length ? r.changes : ['Schema atualizado'],
  );
}

/** Resolve conflito: aplica o texto do painel (sobrescreve o modelo) */
export function applyPending(f: Format) {
  const parsed = usePanels.getState().pending[f];
  patch(f, { conflict: false });
  if (parsed) apply(f, parsed);
  else void parseNow(f);
}

/** Resolve conflito: descarta a edição local e recarrega do modelo */
export function discardLocal(f: Format) {
  regenerate(f);
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );
}

/** Liga o motor: todo commit regenera os painéis sincronizados que não são a origem */
export function startSyncEngine() {
  for (const f of FORMATS) regenerate(f);
  return useProjectStore.subscribe((s, prev) => {
    if (s.doc.schema === prev.doc.schema && s.doc.meta === prev.doc.meta) return;
    const origin = s.lastOrigin;
    for (const f of FORMATS) {
      const p = usePanels.getState().panels[f];
      if (f === origin) {
        patch(f, { baseRev: s.rev });
        continue;
      }
      if (p.status === 'synced' && !p.conflict) regenerate(f);
      else patch(f, { conflict: true });
    }
  });
}
