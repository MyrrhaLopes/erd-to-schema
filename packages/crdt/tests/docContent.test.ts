import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { emptyDocContent } from '@erd/model/docContent';
import type { DocContent } from '@erd/model/types';
import { applyDiff, emptyProjectDoc, fromProject, invalidEntities, LOCAL_ORIGIN, projectDoc, roots, type ProjectDoc } from '../src';

const content = (): DocContent => ({
  ...emptyDocContent(),
  cover: { title: 'Modelo de Dados', subtitle: 'CESS', edition: '{projeto} — versão {versao}', scope: 'Escopo' },
  intro: 'Convenções usadas',
  conventions: { detected: { pk: { goal: 'Identidade estável' } }, extra: [{ name: 'Soft delete', pattern: 'deleted_at', goal: 'Auditoria' }] },
  tables: { t1: { rules: ['Uma regra', 'Outra'] } },
  relationships: { r1: { fromSide: 'pertence a', toSide: 'tem' } },
  typeStyle: 'sql',
  fileName: 'Modelo.docx',
});

const docFrom = (p: ProjectDoc) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, fromProject(p));
  return d;
};

describe('raiz doc (formulário do documento)', () => {
  it('ida e volta', () => {
    const p: ProjectDoc = { ...emptyProjectDoc('X'), doc: content() };
    expect(projectDoc(docFrom(p)).doc).toEqual(content());
  });

  it('documento sem formulário projeta sem `doc`', () => {
    expect(projectDoc(docFrom(emptyProjectDoc('X'))).doc).toBeUndefined();
  });

  it('campos diferentes editados ao mesmo tempo convergem sem perder nenhum', () => {
    const base = docFrom({ ...emptyProjectDoc('X'), doc: content() });
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    const pa = projectDoc(a);
    const pb = projectDoc(b);
    a.transact(() => applyDiff(a, pa, { ...pa, doc: { ...pa.doc!, intro: 'de A' } }), LOCAL_ORIGIN);
    b.transact(() => applyDiff(b, pb, { ...pb, doc: { ...pb.doc!, cover: { ...pb.doc!.cover, title: 'de B' } } }), LOCAL_ORIGIN);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(projectDoc(a).doc).toEqual(projectDoc(b).doc);
    expect(projectDoc(a).doc!.intro).toBe('de A');
    expect(projectDoc(a).doc!.cover.title).toBe('de B');
  });

  it('esvaziar remove as chaves', () => {
    const d = docFrom({ ...emptyProjectDoc('X'), doc: content() });
    const p = projectDoc(d);
    d.transact(() => applyDiff(d, p, { ...p, doc: undefined }), LOCAL_ORIGIN);
    expect(roots(d).docContent.size).toBe(0);
  });

  it('campo inválido aparece em invalidEntities', () => {
    const d = new Y.Doc();
    roots(d).docContent.set('typeStyle', 'outro');
    expect(invalidEntities(d)).toContain('doc:typeStyle');
  });
});
