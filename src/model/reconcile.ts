import type { Column, EntityMeta, EnumType, Format, FormatNames, Id, Project, Relationship, SchemaModel, Table } from './types';
import { CAPABILITIES } from './types';
import { tableKey } from './schema';
import type { ParsedSchema } from '../formats/common';

/**
 * Assinatura de uma coluna "aos olhos" de um formato: se a assinatura da
 * coluna anterior é igual à da coluna parseada, o formato não expressou
 * mudança nenhuma e a coluna anterior é mantida integralmente (preserva
 * detalhes que o formato não distingue, ex.: serial vs integer+autoincrement).
 */
export type ColumnSignature = (col: Column, table: Table, schema: SchemaModel) => string;

export interface ReconcileResult {
  schema: SchemaModel;
  meta: Record<Id, EntityMeta>;
  changes: string[];
}

const FORMAT_NAME_KEYS: Record<Format, (keyof FormatNames)[]> = {
  sql: [],
  prisma: ['prisma', 'prismaFrom', 'prismaTo', 'prismaRelation'],
  drizzle: ['drizzle'],
};

function overlap(a: string[], b: string[]) {
  if (!a.length && !b.length) return 1;
  const sb = new Set(b);
  const common = a.filter((x) => sb.has(x)).length;
  return common / Math.max(a.length, b.length);
}

/** Casa itens por chave e depois tenta detectar renames pelas sobras */
function matchByKey<P, N>(
  prev: P[],
  next: N[],
  keyP: (p: P) => string,
  keyN: (n: N) => string,
  renameScore: (p: P, n: N) => number,
  threshold: number,
): Map<N, P> {
  const out = new Map<N, P>();
  const byKey = new Map<string, P>();
  for (const p of prev) byKey.set(keyP(p), p);
  const usedP = new Set<P>();
  for (const n of next) {
    const p = byKey.get(keyN(n));
    if (p && !usedP.has(p)) {
      out.set(n, p);
      usedP.add(p);
    }
  }
  const leftP = prev.filter((p) => !usedP.has(p));
  const leftN = next.filter((n) => !out.has(n));
  if (!leftP.length || !leftN.length) return out;
  const pairs: { p: P; n: N; s: number }[] = [];
  for (const p of leftP) for (const n of leftN) pairs.push({ p, n, s: renameScore(p, n) });
  pairs.sort((a, b) => b.s - a.s);
  const doneN = new Set<N>();
  for (const { p, n, s } of pairs) {
    if (s < threshold || usedP.has(p) || doneN.has(n)) continue;
    out.set(n, p);
    usedP.add(p);
    doneN.add(n);
  }
  return out;
}

export function reconcile(
  prev: Pick<Project, 'schema' | 'meta'>,
  parsed: ParsedSchema,
  format: Format,
  signature?: ColumnSignature,
): ReconcileResult {
  const caps = CAPABILITIES[format];
  const changes: string[] = [];
  const P = prev.schema;
  const N = parsed.schema;

  /* ---------------- tabelas ---------------- */
  const tableMatch = matchByKey(
    P.tables,
    N.tables,
    (t) => tableKey(caps.schemas ? t : { name: t.name }),
    (t) => tableKey(caps.schemas ? t : { name: t.name }),
    (p, n) => {
      const s = overlap(
        p.columns.map((c) => c.name),
        n.columns.map((c) => c.name),
      );
      // sobra 1-para-1 com ≥60% de overlap de nomes de coluna
      return s;
    },
    0.6,
  );

  const tableIdMap = new Map<Id, Id>(); // parsed id -> final id
  const colIdMap = new Map<Id, Id>();
  const tables: Table[] = [];

  for (const nt of N.tables) {
    const pt = tableMatch.get(nt);
    if (!pt) {
      tables.push(nt);
      tableIdMap.set(nt.id, nt.id);
      nt.columns.forEach((c) => colIdMap.set(c.id, c.id));
      changes.push(`Tabela adicionada: ${nt.name}`);
      continue;
    }
    if (pt.name !== nt.name) changes.push(`Tabela renomeada: ${pt.name} → ${nt.name}`);
    tableIdMap.set(nt.id, pt.id);

    // colunas por nome, renames por sobra 1-para-1 com mesmo tipo/posição
    const colMatch = matchByKey(
      pt.columns,
      nt.columns,
      (c) => c.name,
      (c) => c.name,
      (p, n) => {
        const sameType = JSON.stringify(p.type) === JSON.stringify(n.type);
        const samePos = pt.columns.indexOf(p) === nt.columns.indexOf(n);
        return (sameType ? 0.6 : 0) + (samePos ? 0.4 : 0);
      },
      0.6,
    );
    const columns: Column[] = [];
    for (const nc of nt.columns) {
      const pc = colMatch.get(nc);
      if (!pc) {
        colIdMap.set(nc.id, nc.id);
        columns.push(nc);
        changes.push(`Coluna adicionada: ${nt.name}.${nc.name}`);
        continue;
      }
      colIdMap.set(nc.id, pc.id);
      if (pc.name !== nc.name) changes.push(`Coluna renomeada: ${nt.name}.${pc.name} → ${nc.name}`);
      let col: Column;
      if (signature && signature(pc, pt, P) === signature(nc, nt, N)) {
        col = { ...pc, name: nc.name };
      } else {
        col = { ...nc, id: pc.id };
        if (JSON.stringify(pc.type) !== JSON.stringify(nc.type)) changes.push(`Tipo alterado: ${nt.name}.${nc.name}`);
      }
      if (!caps.columnComments) col.comment = pc.comment;
      columns.push(col);
    }
    for (const pc of pt.columns) if (![...colMatch.values()].includes(pc)) changes.push(`Coluna removida: ${pt.name}.${pc.name}`);

    const t: Table = { ...nt, id: pt.id, columns };
    if (!caps.schemas) t.schema = pt.schema;
    if (!caps.tableComments) t.comment = pt.comment;
    if (!caps.constraintNames) t.primaryKeyName = pt.primaryKeyName;
    tables.push(t);
  }
  for (const pt of P.tables) if (![...tableMatch.values()].includes(pt)) changes.push(`Tabela removida: ${pt.name}`);

  const mapCols = (ids: Id[]) => ids.map((c) => colIdMap.get(c) ?? c);
  const prevById = new Map(P.tables.map((t) => [t.id, t]));
  for (const t of tables) {
    t.primaryKey = mapCols(t.primaryKey);
    t.uniques = t.uniques.map((u) => ({ ...u, columns: mapCols(u.columns) }));
    t.indexes = t.indexes.map((i) => ({ ...i, columns: mapCols(i.columns) }));
    const pt = prevById.get(t.id);
    if (!pt) continue;
    const sameCols = (a: Id[], b: Id[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    // reaproveita IDs e campos não expressáveis de índices/uniques/checks
    t.indexes = t.indexes.map((i) => {
      const pi = pt.indexes.find((x) => sameCols(x.columns, i.columns) && x.unique === i.unique);
      if (!pi) return i;
      return {
        ...i,
        id: pi.id,
        name: caps.constraintNames ? i.name : pi.name,
        where: caps.indexWhere ? i.where : pi.where,
        method: caps.indexMethod ? i.method : pi.method,
      };
    });
    if (!caps.indexWhere) {
      // índices parciais que o formato não enxerga continuam existindo
      for (const pi of pt.indexes) if (pi.where && !t.indexes.some((i) => i.id === pi.id)) {
        if (pi.columns.every((c) => t.columns.some((x) => x.id === c))) t.indexes.push(pi);
      }
    }
    t.uniques = t.uniques.map((u) => {
      const pu = pt.uniques.find((x) => sameCols(x.columns, u.columns));
      return pu ? { ...u, id: pu.id, name: caps.constraintNames ? u.name : pu.name } : u;
    });
    if (format === 'prisma') {
      // Prisma não distingue UNIQUE constraint de índice único: volta ao que era
      const sameSet = (a: Id[], b: Id[]) => a.length === b.length && a.every((x) => b.includes(x));
      for (const pi of pt.indexes) {
        if (!pi.unique || pi.where || t.indexes.some((i) => i.id === pi.id)) continue;
        if (!pi.columns.every((c) => t.columns.some((x) => x.id === c))) continue;
        const ui = t.uniques.findIndex((u) => sameSet(u.columns, pi.columns));
        if (ui >= 0 && !pt.uniques.some((u) => sameSet(u.columns, pi.columns))) {
          t.uniques.splice(ui, 1);
          t.indexes.push(pi);
        } else if (pi.columns.length === 1) {
          const c = t.columns.find((x) => x.id === pi.columns[0]);
          const before = pt.columns.find((x) => x.id === pi.columns[0]);
          if (c?.unique && !before?.unique) {
            t.columns = t.columns.map((x) => (x === c ? { ...x, unique: undefined } : x));
            t.indexes.push(pi);
          }
        }
      }
    }
    if (!caps.checks) t.checks = pt.checks;
    else
      t.checks = t.checks.map((k) => {
        const pk = pt.checks.find((x) => (x.name && x.name === k.name) || x.expr === k.expr);
        return pk ? { ...k, id: pk.id } : k;
      });
  }

  /* ---------------- enums ---------------- */
  const enumMatch = matchByKey(
    P.enums,
    N.enums,
    (e) => e.name,
    (e) => e.name,
    (p, n) => overlap(p.values, n.values),
    0.6,
  );
  const enums: EnumType[] = N.enums.map((ne) => {
    const pe = enumMatch.get(ne);
    if (!pe) {
      changes.push(`Enum adicionado: ${ne.name}`);
      return ne;
    }
    if (pe.name !== ne.name) changes.push(`Enum renomeado: ${pe.name} → ${ne.name}`);
    if (pe.values.join() !== ne.values.join()) changes.push(`Valores alterados: enum ${ne.name}`);
    tableIdMap.set(ne.id, pe.id);
    return { ...ne, id: pe.id, schema: caps.schemas ? ne.schema : pe.schema };
  });
  for (const pe of P.enums) if (![...enumMatch.values()].includes(pe)) changes.push(`Enum removido: ${pe.name}`);
  // rename de enum propaga para o tipo das colunas que o usam
  for (const ne of N.enums) {
    const pe = enumMatch.get(ne);
    if (!pe || pe.name === ne.name) continue;
    for (const t of tables) for (const c of t.columns) if (c.type.base === pe.name) c.type = { ...c.type, base: ne.name };
  }

  /* ---------------- relações ---------------- */
  const relKey = (r: Relationship, mapT: (id: Id) => Id, mapC: (ids: Id[]) => Id[]) =>
    [r.kind, mapT(r.fromTable), mapC(r.fromColumns).join(','), mapT(r.toTable), mapC(r.toColumns).join(',')].join('|');
  const prevRels = new Map(P.relationships.map((r) => [relKey(r, (x) => x, (x) => x), r]));
  const usedRel = new Set<Relationship>();
  const relationships: Relationship[] = [];
  for (const nr of N.relationships) {
    const mapped: Relationship = {
      ...nr,
      fromTable: tableIdMap.get(nr.fromTable) ?? nr.fromTable,
      toTable: tableIdMap.get(nr.toTable) ?? nr.toTable,
      fromColumns: mapCols(nr.fromColumns),
      toColumns: mapCols(nr.toColumns),
    };
    const pr = prevRels.get(relKey(mapped, (x) => x, (x) => x));
    if (pr && !usedRel.has(pr)) {
      usedRel.add(pr);
      mapped.id = pr.id;
      if (!caps.constraintNames) mapped.name = pr.name;
      if (!caps.refActions) {
        mapped.onDelete = pr.onDelete;
        mapped.onUpdate = pr.onUpdate;
      }
      if ((pr.onDelete ?? 'no action') !== (mapped.onDelete ?? 'no action') || (pr.onUpdate ?? 'no action') !== (mapped.onUpdate ?? 'no action'))
        changes.push(`Ações da FK alteradas: ${pr.name ?? ''}`.trim());
      if (pr.label !== mapped.label || pr.cardinality !== mapped.cardinality) changes.push('Relação-nota alterada');
    } else {
      changes.push(nr.kind === 'fk' ? 'Relação FK adicionada' : 'Relação-nota adicionada');
    }
    relationships.push(mapped);
  }
  const finalTableIds = new Set(tables.map((t) => t.id));
  for (const pr of P.relationships) {
    if (usedRel.has(pr)) continue;
    if (pr.kind === 'note' && !caps.noteRelations && finalTableIds.has(pr.fromTable) && finalTableIds.has(pr.toTable)) {
      relationships.push(pr);
      continue;
    }
    changes.push(pr.kind === 'fk' ? 'Relação FK removida' : 'Relação-nota removida');
  }

  /* ---------------- meta ---------------- */
  const meta: Record<Id, EntityMeta> = {};
  const parsedMetaFor = (parsedId: Id) => parsed.meta[parsedId];
  const reverse = new Map<Id, Id>();
  for (const [pid, fid] of tableIdMap) reverse.set(fid, pid);
  for (const r of N.relationships) reverse.set(relationships[N.relationships.indexOf(r)]?.id ?? r.id, r.id);
  for (const [pid, fid] of colIdMap) reverse.set(fid, pid);

  const keepIds = new Set<Id>([
    ...tables.map((t) => t.id),
    ...tables.flatMap((t) => t.columns.map((c) => c.id)),
    ...enums.map((e) => e.id),
    ...relationships.map((r) => r.id),
  ]);
  for (const id of keepIds) {
    const pm = prev.meta[id];
    const nm = parsedMetaFor(reverse.get(id) ?? id);
    if (!pm && !nm) continue;
    const m: EntityMeta = { ...(pm ?? {}) };
    if (caps.tags && finalTableIds.has(id)) {
      m.tags = nm?.tags?.length ? nm.tags : undefined;
      m.suppressedTags = nm?.suppressedTags?.length ? nm.suppressedTags : undefined;
    }
    if (nm?.provenance?.kind === 'pivot')
      m.provenance = {
        ...nm.provenance,
        a: tableIdMap.get(nm.provenance.a) ?? nm.provenance.a,
        b: tableIdMap.get(nm.provenance.b) ?? nm.provenance.b,
      };
    const fn: FormatNames = { ...(pm?.formatNames ?? {}) };
    for (const k of FORMAT_NAME_KEYS[format]) {
      if (nm?.formatNames?.[k] !== undefined) fn[k] = nm.formatNames[k];
      else delete fn[k];
    }
    m.formatNames = Object.keys(fn).length ? fn : undefined;
    for (const k of Object.keys(m) as (keyof EntityMeta)[]) if (m[k] === undefined) delete m[k];
    if (Object.keys(m).length) meta[id] = m;
  }
  // meta de notas/outros itens não-schema continua
  for (const [id, m] of Object.entries(prev.meta)) if (!keepIds.has(id) && !isSchemaId(P, id)) meta[id] = m;

  return { schema: { tables, enums, relationships }, meta, changes };
}

function isSchemaId(s: SchemaModel, id: Id) {
  return (
    s.tables.some((t) => t.id === id || t.columns.some((c) => c.id === id)) ||
    s.enums.some((e) => e.id === id) ||
    s.relationships.some((r) => r.id === id)
  );
}
