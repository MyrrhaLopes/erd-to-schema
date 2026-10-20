import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { roots } from '@erd/crdt';
import { personOf } from '../collab/presence';

/**
 * Decorações de colaboração nos editores de texto (painéis e notas), §5.4 e §5.5:
 * - rastro de digitação: o que outra pessoa acabou de digitar fica com fundo na cor dela e desbota;
 * - "Mostrar autoria": cada trecho pintado com a cor de quem o escreveu.
 * As cores vêm da awareness (o `clientID` do Yjs é o mesmo da awareness) e, para quem já saiu,
 * do mapa `clients` do documento → diretório de pessoas do projeto.
 */

/** Cor de quem escreveu com um dado `clientID` */
export function colorOfClient(doc: Y.Doc, awareness: Awareness | null | undefined, client: number): string | undefined {
  const st = awareness?.getStates().get(client) as { user?: { color?: string } } | undefined;
  if (st?.user?.color) return st.user.color;
  const userId = roots(doc).clients.get(String(client));
  return personOf(userId)?.color;
}

/* ------------------------------ rastro ------------------------------ */

const TRAIL_MS = 3000;
const addTrail = StateEffect.define<{ id: number; from: number; to: number; color: string }[]>();
const dropTrail = StateEffect.define<number>();

const trailField = StateField.define<{ deco: DecorationSet; ids: Map<number, { from: number; to: number }> }>({
  create: () => ({ deco: Decoration.none, ids: new Map() }),
  update(v, tr) {
    let deco = v.deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addTrail)) {
        const ranges: Range<Decoration>[] = e.value
          .filter((r) => r.to > r.from)
          .map((r) =>
            Decoration.mark({ class: 'erd-typing-trail', attributes: { style: `--erd-c:${r.color}40`, 'data-trail': String(r.id) } }).range(r.from, Math.min(r.to, tr.state.doc.length)),
          );
        deco = deco.update({ add: ranges, sort: true });
      } else if (e.is(dropTrail)) {
        const id = String(e.value);
        deco = deco.update({ filter: (_f, _t, d) => d.spec.attributes?.['data-trail'] !== id });
      }
    }
    return { deco, ids: v.ids };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

let trailSeq = 0;

/** Liga o rastro de digitação: observa os deltas remotos do Y.Text e acende o trecho inserido */
export function bindTypingTrail(view: EditorView, ytext: Y.Text, awareness: Awareness | null | undefined): () => void {
  const doc = ytext.doc!;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const fn = (e: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.local) return;
    let client: number | undefined;
    for (const [c, clock] of tr.afterState) if (clock > (tr.beforeState.get(c) ?? 0)) client = c;
    if (client === undefined) return;
    const color = colorOfClient(doc, awareness, client);
    if (!color) return; // o sync bot (servidor) não acende rastro
    const ranges: { id: number; from: number; to: number; color: string }[] = [];
    let pos = 0;
    for (const d of e.delta) {
      if (d.retain) pos += d.retain;
      else if (typeof d.insert === 'string') {
        ranges.push({ id: ++trailSeq, from: pos, to: pos + d.insert.length, color });
        pos += d.insert.length;
      }
    }
    if (!ranges.length) return;
    // o y-codemirror registrou o observador antes: o CodeMirror já tem o texto novo aqui
    if (view.state.doc.length !== ytext.length) return;
    view.dispatch({ effects: addTrail.of(ranges) });
    const t = setTimeout(() => {
      timers.delete(t);
      for (const r of ranges) view.dispatch({ effects: dropTrail.of(r.id) });
    }, TRAIL_MS);
    timers.add(t);
  };
  ytext.observe(fn);
  return () => {
    ytext.unobserve(fn);
    timers.forEach(clearTimeout);
  };
}

/* ----------------------------- autoria ----------------------------- */

const setAuthorship = StateEffect.define<{ from: number; to: number; color: string }[] | null>();
const authorshipField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setAuthorship)) continue;
      if (!e.value) return Decoration.none;
      const len = tr.state.doc.length;
      deco = Decoration.set(
        e.value
          .filter((r) => r.from < len && r.to > r.from)
          .map((r) => Decoration.mark({ class: 'erd-authored', attributes: { style: `background-color:${r.color}2e` } }).range(r.from, Math.min(r.to, len))),
        true,
      );
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Trechos do texto por autor: cada item do Y.Text guarda o `clientID` de quem o inseriu */
export function authorRuns(ytext: Y.Text, colorFor: (client: number) => string | undefined) {
  const out: { from: number; to: number; color: string }[] = [];
  let item = ytext._start;
  let pos = 0;
  while (item) {
    if (!item.deleted && item.countable) {
      const color = colorFor(item.id.client);
      const last = out[out.length - 1];
      if (color) {
        if (last && last.to === pos && last.color === color) last.to += item.length;
        else out.push({ from: pos, to: pos + item.length, color });
      }
      pos += item.length;
    }
    item = item.right;
  }
  return out;
}

/** Liga/desliga a pintura de autoria e a mantém atualizada enquanto ligada */
export function bindAuthorship(view: EditorView, ytext: Y.Text, awareness: Awareness | null | undefined): () => void {
  const doc = ytext.doc!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => view.dispatch({ effects: setAuthorship.of(authorRuns(ytext, (c) => colorOfClient(doc, awareness, c))) });
  const fn = () => {
    clearTimeout(timer);
    timer = setTimeout(paint, 250);
  };
  paint();
  ytext.observe(fn);
  return () => {
    clearTimeout(timer);
    ytext.unobserve(fn);
    view.dispatch({ effects: setAuthorship.of(null) });
  };
}

export const collabDecorations: Extension = [trailField, authorshipField];
