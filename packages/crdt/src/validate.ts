import { z } from 'zod';
import { REF_ACTIONS } from '@erd/model/types';

/**
 * Validação defensiva da projeção (§4.2 item 4): um editor malicioso ou um bug pode
 * escrever lixo no Y.Doc. Cada entidade é validada ao ser lida; as inválidas são puladas
 * em vez de quebrar o render de todo mundo.
 */
const id = z.string().min(1).max(200);
const name = z.string().max(500);
const ids = z.array(id).max(1000);
const opt = <T extends z.ZodType>(t: T) => t.optional();

export const ColumnTypeZ = z.object({
  base: z.string().min(1).max(200),
  args: opt(z.array(z.number()).max(10)),
  array: opt(z.boolean()),
});

export const ColumnZ = z.object({
  id,
  name,
  type: ColumnTypeZ,
  nullable: z.boolean(),
  default: opt(z.string().max(10_000)),
  unique: opt(z.boolean()),
  identity: opt(z.enum(['always', 'by-default'])),
  comment: opt(z.string().max(10_000)),
});

export const UniqueZ = z.object({ id, name: opt(name), columns: ids });
export const IndexZ = z.object({ id, name: opt(name), columns: ids, unique: z.boolean(), where: opt(z.string().max(10_000)), method: opt(z.string().max(100)) });
export const CheckZ = z.object({ id, name: opt(name), expr: z.string().max(10_000) });

export const TableZ = z.object({
  id,
  name,
  schema: opt(name),
  columns: z.array(ColumnZ).max(2000),
  primaryKey: ids,
  primaryKeyName: opt(name),
  uniques: z.array(UniqueZ).max(500),
  indexes: z.array(IndexZ).max(500),
  checks: z.array(CheckZ).max(500),
  comment: opt(z.string().max(10_000)),
});

export const EnumZ = z.object({ id, name, schema: opt(name), values: z.array(z.string().max(500)).max(5000) });

const Card = z.enum(['1:1', 'N:1', '1:N', 'N:N', '0:1', '0:N']);
export const RelationshipZ = z.object({
  id,
  kind: z.enum(['fk', 'note']),
  name: opt(name),
  fromTable: id,
  fromColumns: ids,
  toTable: id,
  toColumns: ids,
  onDelete: opt(z.enum(REF_ACTIONS as [string, ...string[]])),
  onUpdate: opt(z.enum(REF_ACTIONS as [string, ...string[]])),
  cardinality: opt(Card),
  label: opt(z.string().max(1000)),
  showReverse: opt(z.boolean()),
  reverseLabel: opt(z.string().max(1000)),
  reverseCardinality: opt(Card),
});

const finite = z.number().refine(Number.isFinite);
export const LayoutZ = z.object({ x: finite, y: finite, w: opt(finite), h: opt(finite), collapsed: opt(z.boolean()) });

export const EntityMetaZ = z.object({
  tags: opt(z.array(z.string().max(100)).max(100)),
  suppressedTags: opt(z.array(z.string().max(100)).max(100)),
  provenance: opt(
    z.union([z.object({ kind: z.literal('pivot'), a: id, b: id, implicit: opt(z.literal('prisma')) }), z.object({ kind: z.literal('manual') })]),
  ),
  formatNames: opt(
    z.object({
      prisma: opt(name),
      drizzle: opt(name),
      prismaFrom: opt(name),
      prismaTo: opt(name),
      prismaRelation: opt(name),
    }),
  ),
});

export const NoteZ = z.object({ id, title: z.string().max(1000), content: z.string().max(1_000_000), color: opt(z.string().max(50)) });

/**
 * Valida e devolve a própria entidade (não a cópia do zod, para não mudar a ordem das
 * chaves de que comparações por JSON dependem), ou `undefined` (com aviso) quando inválida.
 */
export function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T | undefined {
  const r = schema.safeParse(value);
  if (r.success) return value as T;
  if (typeof console !== 'undefined') console.warn(`[crdt] ${what} inválido ignorado:`, r.error.issues[0]?.message);
  return undefined;
}
