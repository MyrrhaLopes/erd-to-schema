import type { NoteBlock, Project } from './types';
import type { ParseOutcome } from './formats/common';
import { emptyProject, NOTE_H, NOTE_W, placeNewEntities } from './project';
import { reconcile } from './reconcile';
import { columnSql } from './formats/sql/generate';

export const SAMPLE_SQL = `CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku varchar(32) NOT NULL UNIQUE,
  title text NOT NULL,
  price_cents integer NOT NULL,
  CONSTRAINT products_price_positive CHECK (price_cents >= 0)
);

CREATE TABLE categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  parent_id integer
);

CREATE TABLE product_categories (
  product_id integer NOT NULL,
  category_id integer NOT NULL,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id integer NOT NULL,
  status order_status NOT NULL DEFAULT 'pending',
  placed_at timestamptz DEFAULT now(),
  referral_code text
);

CREATE TABLE order_items (
  order_id bigint NOT NULL,
  product_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE orders_history (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL,
  status order_status NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);

ALTER TABLE categories ADD CONSTRAINT categories_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE;
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers (id);
ALTER TABLE order_items ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE;
ALTER TABLE order_items ADD CONSTRAINT order_items_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products (id);
ALTER TABLE orders_history ADD CONSTRAINT orders_history_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE;

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE UNIQUE INDEX orders_referral_code_key ON orders (referral_code) WHERE referral_code IS NOT NULL;

COMMENT ON TABLE orders IS 'Pedidos feitos pelos clientes';
COMMENT ON COLUMN products.price_cents IS 'Preço em centavos';

-- Conceitos do canvas (relações-nota e tags)
-- @erd:ref orders(referral_code) -> customers(email) N:1 "indicação (resolvida na aplicação)"
-- @erd:tags customers core
`;

export const SAMPLE_NOTES: Omit<NoteBlock, 'id'>[] = [
  {
    title: 'Como usar',
    color: 'yellow',
    content: `**Canvas, SQL, Prisma e Drizzle são vistas do mesmo modelo.** Edite qualquer uma.

- **R** tabela · **A** relação · **T** nota · **E** borracha
- **Ctrl + Seta** cria tabela relacionada (FK)
- **Ctrl + Shift + Seta** cria com relação-nota
- Dois cliques renomeiam / editam
- **?** mostra todos os atalhos`,
  },
];

/** Projeto de exemplo a partir do SQL (o parse é injetado: worker no browser, WASM direto no servidor) */
export async function buildSampleProject(parse: (sql: string) => Promise<ParseOutcome>, newNoteId: () => string): Promise<Project> {
  const p = emptyProject('Exemplo — loja');
  const r = await parse(SAMPLE_SQL);
  if (r.ok) {
    const rec = reconcile(p, r.parsed, 'sql', columnSql);
    p.schema = rec.schema;
    p.meta = rec.meta;
  }
  for (const n of SAMPLE_NOTES) {
    const id = newNoteId();
    p.notes.push({ id, ...n });
    p.layout[id] = { x: -340, y: 0, w: NOTE_W + 20, h: NOTE_H + 70 };
  }
  placeNewEntities(p);
  return p;
}
