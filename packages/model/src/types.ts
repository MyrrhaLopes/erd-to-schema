/**
 * Modelo canônico — fonte única de verdade.
 *
 * `schema` guarda o significado (o que SQL/Prisma/Drizzle expressam);
 * `layout`, `meta`, `notes` e `view` guardam apresentação e conceitos
 * exclusivos do canvas. Os textos nunca escrevem `layout`/`view`.
 */

export type Id = string;

export type Format = 'sql' | 'prisma' | 'drizzle';
export const FORMATS: Format[] = ['sql', 'prisma', 'drizzle'];

/** Tipo de coluna na forma canônica do Postgres, ex.: {base:'varchar', args:[255]} */
export interface ColumnType {
  base: string;
  args?: number[];
  array?: boolean;
}

export interface Column {
  id: Id;
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Expressão SQL do default, ex.: `now()`, `'draft'`, `0` */
  default?: string;
  /** UNIQUE de coluna única (constraints multi-coluna ficam em `Table.uniques`) */
  unique?: boolean;
  identity?: 'always' | 'by-default';
  comment?: string;
}

export interface UniqueConstraint {
  id: Id;
  name?: string;
  columns: Id[];
}

export interface Index {
  id: Id;
  name?: string;
  columns: Id[];
  unique: boolean;
  /** Predicado de índice parcial (sem a palavra WHERE) */
  where?: string;
  method?: string;
}

export interface CheckConstraint {
  id: Id;
  name?: string;
  expr: string;
}

export interface Table {
  id: Id;
  name: string;
  /** Schema do Postgres; ausente = public */
  schema?: string;
  columns: Column[];
  primaryKey: Id[];
  primaryKeyName?: string;
  uniques: UniqueConstraint[];
  indexes: Index[];
  checks: CheckConstraint[];
  comment?: string;
}

export interface EnumType {
  id: Id;
  name: string;
  schema?: string;
  values: string[];
}

export type RefAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
export const REF_ACTIONS: RefAction[] = ['no action', 'restrict', 'cascade', 'set null', 'set default'];

/**
 * Cardinalidade, lida de `from` para `to`. FK: from = filha, to = mãe.
 * As variantes `0:1`/`0:N` marcam o lado "um" como opcional (mínimo 0) em vez de mandatório.
 */
export type Cardinality = '1:1' | 'N:1' | '1:N' | 'N:N' | '0:1' | '0:N';

export interface Relationship {
  id: Id;
  kind: 'fk' | 'note';
  /** Nome da constraint (FK) */
  name?: string;
  fromTable: Id;
  fromColumns: Id[];
  toTable: Id;
  toColumns: Id[];
  onDelete?: RefAction;
  onUpdate?: RefAction;
  /** Só para relações-nota; em FK a cardinalidade é derivada do schema */
  cardinality?: Cardinality;
  label?: string;
  /** Só para relações-nota: exibe também o nome no sentido contrário */
  showReverse?: boolean;
  reverseLabel?: string;
  reverseCardinality?: Cardinality;
}

export interface SchemaModel {
  tables: Table[];
  enums: EnumType[];
  relationships: Relationship[];
}

export interface LayoutEntry {
  x: number;
  y: number;
  w?: number;
  h?: number;
  collapsed?: boolean;
}

export type Provenance =
  | { kind: 'pivot'; a: Id; b: Id; implicit?: 'prisma' }
  | { kind: 'manual' };

export interface FormatNames {
  /** Nome do model Prisma / chave do campo / nome do campo de relação */
  prisma?: string;
  /** Nome da variável/chave TS no Drizzle */
  drizzle?: string;
  /** Relações: nomes dos campos de relação no Prisma */
  prismaFrom?: string;
  prismaTo?: string;
  prismaRelation?: string;
}

export interface EntityMeta {
  /** Tags manuais */
  tags?: string[];
  /** Tags automáticas que o usuário removeu (override manual vence o detector) */
  suppressedTags?: string[];
  provenance?: Provenance;
  formatNames?: FormatNames;
}

export interface NoteBlock {
  id: Id;
  title: string;
  content: string;
  color?: string;
}

export type Tool = 'select' | 'hand' | 'table' | 'relation' | 'note' | 'eraser';

export interface ViewState {
  /** Tags cujas tabelas ficam ocultas (pivot, history, enum, ou custom) */
  hiddenTags: string[];
  showNoteRelations: boolean;
  showNotes: boolean;
  showEnums: boolean;
  cardinalityStyle?: 'look-across' | 'below-label';
}

export interface Project {
  version: 1;
  name: string;
  schema: SchemaModel;
  layout: Record<Id, LayoutEntry>;
  meta: Record<Id, EntityMeta>;
  notes: NoteBlock[];
  view: ViewState;
}

export type Origin = Format | 'canvas' | 'history' | 'load' | 'inspector' | 'remote';

/* ------------------------------------------------------------------ */
/* Capability matrix                                                   */
/* ------------------------------------------------------------------ */

export type Feature =
  | 'checks'
  | 'indexWhere'
  | 'indexMethod'
  | 'tableComments'
  | 'columnComments'
  | 'noteRelations'
  | 'tags'
  | 'refActions'
  | 'constraintNames'
  | 'schemas';

/**
 * O que cada formato consegue expressar. Na reconciliação, todo campo
 * fora da capability do formato que gerou o parse é copiado do modelo
 * anterior em vez de ser descartado.
 */
export const CAPABILITIES: Record<Format, Record<Feature, boolean>> = {
  sql: {
    checks: true,
    indexWhere: true,
    indexMethod: true,
    tableComments: true,
    columnComments: true,
    noteRelations: true, // via `-- @erd:ref`
    tags: true, // via `-- @erd:tags`
    refActions: true,
    constraintNames: true,
    schemas: true,
  },
  prisma: {
    checks: false,
    indexWhere: false,
    indexMethod: false,
    tableComments: true, // `///` doc comments
    columnComments: true,
    noteRelations: true, // via `// @erd:ref`
    tags: true,
    refActions: true,
    constraintNames: false,
    schemas: false,
  },
  drizzle: {
    checks: true,
    indexWhere: true,
    indexMethod: true,
    tableComments: false, // comentários JS se perdem ao executar o código
    columnComments: false,
    noteRelations: true, // via `// @erd:ref` (lido por scan de linhas)
    tags: true,
    refActions: true,
    constraintNames: true,
    schemas: false,
  },
};

export const FORMAT_LABEL: Record<Format, string> = {
  sql: 'SQL (Postgres)',
  prisma: 'Prisma',
  drizzle: 'Drizzle',
};

export const BUILTIN_TAGS = ['pivot', 'history', 'enum'] as const;
