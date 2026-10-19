# ERD Builder

Canvas interativo de ERD em que **canvas, SQL (Postgres), Prisma e Drizzle são quatro vistas do mesmo modelo**. Editar qualquer uma atualiza as outras três, e o canvas se redesenha sozinho. Implementado a partir de [`docs/erd-builder-plan.md`](docs/erd-builder-plan.md).

Monorepo pnpm + Turborepo (plano de evolução em [`docs/fullstack-collab-plan.md`](docs/fullstack-collab-plan.md)).

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # unitários + round-trip baseados em propriedade (vitest + fast-check)
pnpm build
pnpm e2e           # @playwright/test (sobe o Vite sozinho; URL=... roda contra outro servidor)
pnpm verify        # lint + typecheck + test + build (rodar antes de abrir PR)
pnpm prod:local    # as imagens Docker reais (as mesmas do Railway)
```

## O que dá para fazer

- **Sync bidirecional completo.** Edite o SQL, o Prisma ou o Drizzle, ou mexa no canvas: as outras vistas se atualizam depois de 400 ms de pausa na digitação (ou na hora, com Ctrl+S ou ao sair do editor). Quando o parse falha, o editor mostra o erro na linha certa e o modelo não muda.
- **Canvas** (React Flow): tabelas com handles por coluna, enums e blocos de nota. Arraste entre colunas para criar uma FK; o lado que recebe a FK é deduzido automaticamente (a PK vira o destino).
- **Arestas distintas:**
  - FK: linha sólida com pé-de-galinha, com a cardinalidade derivada do schema (FK única = 1:1).
  - Relação-nota: linha tracejada roxa.
  - N:N com o pivot oculto: linha pontilhada.
- **N:N** sempre cria uma tabela pivot real, com PK composta e *provenance*.
- **Detecção automática** de tabelas pivot e de histórico (por pontuação). As tags também podem ser adicionadas ou removidas à mão; a escolha manual sempre vence o detector.
- **Filtros de visualização:** relações-nota, notas, enums, pivots, tabelas de histórico e tags personalizadas.
- **Notas em Markdown:** cada nota exporta como `.md`, e as notas visíveis exportam juntas num `.zip`.
- **Export PNG/PDF** da seleção ou do diagrama inteiro.
- **Projeto `.zip`** com `project.json`, `notes/*.md`, `schema.sql`, `schema.prisma` e `schema.ts`. Ao reimportar, os `.md` são a fonte da verdade, e `.md` novos viram notas novas. O app também importa `.sql`, `.prisma`, `.ts` e `.md` soltos.
- **Autosave** em IndexedDB e undo/redo global.

### Atalhos (estilo Excalidraw/Eraser)

| Tecla | Ação |
|---|---|
| V / 1 | Seleção |
| H, Espaço (segurar) | Mão / pan |
| R / 2 | Tabela (clique no canvas) |
| A / 3 | Relação (clique na origem e depois no destino, ou arraste entre colunas). Modo FK, Nota ou N:N na barra |
| T / 4 | Nota |
| E / 0 | Borracha (arraste por cima; Esc cancela; tudo vira uma entrada de undo) |
| **Ctrl + Seta** | Nova tabela na direção, com FK para a selecionada |
| **Ctrl + Shift + Seta** | Idem, com relação-nota |
| Ctrl + D | Duplicar tabela |
| Enter / duplo clique | Renomear ou editar |
| Delete / Backspace | Excluir, em cascata (relações e pivots órfãos) |
| Ctrl + Z / Ctrl + Shift + Z | Undo/redo global. Dentro de um editor de código, vale o histórico local do editor |
| Shift + 1 | Enquadrar tudo |
| ? | Ajuda |

Os atalhos ficam desativados quando o foco está num input ou num editor (no Windows, Ctrl+Seta é navegação por palavra).

## Arquitetura

```
packages/model/src/          tipos canônicos + capability matrix, reconcile(), tags, layout, .zip do projeto
packages/model/src/formats/  sql | prisma | drizzle: generate.ts (modelo → texto) e parse.ts (texto → modelo)
apps/web/src/sync/         motor de sync (status por painel, seq, debounce, conflitos) + cliente dos workers
apps/web/src/workers/      parser.worker (libpg-query WASM + prisma-ast), drizzle.worker (sandbox)
apps/web/src/store/        zustand + immer + zundo (undo de schema/layout/meta/notas) e ações do canvas
apps/web/src/canvas/       React Flow: nodes, edges (pé-de-galinha), toolbar, inspector, atalhos, borracha
apps/web/src/persistence/  IndexedDB, .zip do projeto, notas .md, salvar arquivo (File System Access API)
apps/web/src/export/       PNG/PDF (html-to-image 1.11.11 pinado + jsPDF)
```

- **SQL:** usa o `libpg-query`, que é o parser real do Postgres compilado para WASM e roda num Web Worker. As expressões são reconstruídas com o `pgsql-deparser`. O parser lê `CREATE TABLE/TYPE/INDEX`, `ALTER TABLE` e `COMMENT ON`; outros statements geram um aviso e são ignorados.
- **Prisma:** usa o `@mrleebo/prisma-ast`, com validação semântica própria. Lida com `@map` e `@@map`, nomes de relação gerados automaticamente quando necessário, e M:N implícito (`_AToB`, colunas `A`/`B`), que vira uma tabela pivot real.
- **Drizzle:** o código **é executado, não parseado**. O TypeScript passa pelo `sucrase` e roda num worker contra o `drizzle-orm` real (versão pinada em 0.45.4). O `require` só aceita `drizzle-orm` e `drizzle-orm/pg-core`, e há um timeout de 1,5 s com `terminate()`. Helpers, spreads e loops funcionam.
- **Reconciliação:**
  - Tabelas casam por nome; renames são detectados quando sobra uma tabela de cada lado com ≥60% das colunas em comum. Colunas casam por nome, e renames são detectados por tipo e posição.
  - Relações casam pelas colunas de origem e destino.
  - Tudo o que o formato de origem não consegue expressar é copiado do modelo anterior: CHECKs no Prisma, comentários no Drizzle, índices parciais, nomes de constraint, `serial` versus `integer GENERATED … IDENTITY`.
- **Diretivas `@erd:`:** relações-nota e tags sobrevivem nos três formatos como comentários:
  ```sql
  -- @erd:ref orders(referral_code) -> customers(email) N:1 "indicação"
  -- @erd:tags customers core
  -- @erd:untag order_items pivot
  ```
- **Formatação:** o painel que está sendo editado nunca é sobrescrito. Os outros painéis são regenerados no formato canônico. Se o modelo muda enquanto um painel tem edição pendente ou com erro, aparece um banner com duas opções: aplicar a versão do painel ou recarregar do modelo.
- **Toast de mudanças:** depois de cada sync vindo de um texto, um toast mostra a lista de mudanças aplicadas, para que nada mude em silêncio.

## Diferenças em relação ao plano

- No Drizzle, relações-nota e tags usam a mesma diretiva `// @erd:` dos outros formatos (lida por scan de linhas), e não `relations()`. Isso deixa o formato uniforme e não depende da troca de API do Drizzle 1.0.
- O auto-layout é próprio, em camadas por profundidade de FK (botão **Organizar**). O `elkjs` ficou de fora.
- Os atalhos são tratados diretamente com `keydown`, sem `tinykeys`. A interface usa fontes do sistema, então o export usa `skipFonts` e não sofre com CORS de fontes.
- Índices de expressão ainda não são suportados: geram um aviso e são ignorados.
