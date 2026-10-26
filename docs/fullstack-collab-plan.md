# EasiER → plataforma colaborativa: plano de arquitetura

> Plano para transformar o mini-app local (Vite + React, estado em zustand, autosave em IndexedDB) numa aplicação fullstack em monorepo, com contas de usuário, múltiplos projetos, compartilhamento com permissões e edição colaborativa em tempo real no canvas. Escrito a partir do código atual (`src/store`, `src/sync`, `src/model`) e pensado para ser executado em fases, cada uma entregável e testável.

## Pedido (resumo)

1. **Fullstack em monorepo**, com múltiplos usuários e múltiplos projetos.
2. Um **projeto** contém o diagrama ER e, no futuro, um **segundo canvas de fluxos de usuário** (só planejar agora).
3. **Compartilhamento** com outros usuários, com permissão de **edição** ou **somente visualização**. Quem só visualiza pode **pedir acesso de edição**.
4. **Colaboração em tempo real** no canvas, estilo Google Docs: as edições de cada pessoa ficam visíveis, com **uma cor de destaque por usuário** nos blocos que ela está mexendo e nas mudanças que fez.
5. **Painéis de código (SQL/Prisma/Drizzle) também com digitação compartilhada** estilo Docs: várias pessoas no mesmo texto, com cursores coloridos (pedido na revisão do plano).

## Decisões principais (TL;DR)

| Tema | Escolha | Por quê |
|---|---|---|
| Monorepo | **pnpm workspaces + Turborepo** | Cache de build/test por pacote; pnpm resolve bem os pacotes internos `workspace:*`. |
| Modelo de colaboração | **CRDT com Yjs** | Merge automático sem servidor de transformação (OT); funciona offline e reconecta sozinho; ecossistema maduro (awareness, undo, bindings de CodeMirror). |
| Servidor de tempo real | **Hocuspocus** (servidor Yjs open source, do time do Tiptap) | Já traz autenticação por documento, conexões *read-only*, persistência plugável e extensão Redis para escalar horizontalmente. Ver §6.0. |
| Painéis de código | **Texto compartilhado** (`Y.Text` por formato) + **sync bot no servidor** | Edição simultânea estilo Docs no SQL/Prisma/Drizzle, com cursores coloridos. Um único escritor (o bot) traduz texto ⇄ modelo, então não há duplicação. Ver §4.6. |
| API | **Hono** (Node) + **zod** | Parecido com o Express, mas TypeScript-first: o cliente RPC tipado elimina a duplicação de tipos entre a API e a web. **Decidido.** Ver §7.0. |
| Banco | **Postgres + Drizzle ORM** | O app já gera Drizzle; usar o mesmo ORM no backend faz *dogfooding* e permite validar o próprio gerador. |
| Auth | **Better Auth** (adaptador Drizzle) | Biblioteca, não serviço: as tabelas ficam no seu Postgres, no seu schema Drizzle. Evita reimplementar hash de senha, sessões, reset, verificação de e-mail e OAuth. **Decidido.** Ver §7.0. |
| Deploy | **Railway**: `web` (Caddy, único domínio público) + `server` (rede privada) + Postgres | Mesma origem para o SPA, a API e o WebSocket; os Dockerfiles são os mesmos do `prod:local`. Ver §15. |
| E-mail | **Resend** + **React Email**; **Mailpit** em dev | API simples, templates em JSX, plano gratuito suficiente para começar. Alternativas: Postmark, Amazon SES. Ver §7.2. |
| Front | O app atual vira `apps/web`; entra **TanStack Router** + **TanStack Query** | Rotas tipadas (dashboard, projeto, canvas) e cache das chamadas REST. |
| Fonte da verdade no cliente | **Y.Doc** (zustand vira projeção somente-leitura) | Toda a lógica de ações atual (`actions.ts`, Inspector, reconcile) continua escrevendo via `commit()`; só o que está por baixo do `commit` muda. |
| Undo/redo | **`Y.UndoManager`** com `trackedOrigins` locais | Desfaz só as *suas* mudanças, como no Google Docs. O `zundo` sai. |

```mermaid
flowchart LR
  subgraph Browser
    UI[React + React Flow] -->|commit| Bind[@erd/crdt binding]
    Bind <--> YD[(Y.Doc)]
    YD --> Proj[projeção zustand]
    Proj --> UI
    YD <--> IDB[(y-indexeddb offline)]
    Panels[Painéis SQL/Prisma/Drizzle<br/>y-codemirror sobre Y.Text] <--> YD
    Workers[[Workers: lint local, só leitura]] --- Panels
  end
  YD <-->|WebSocket: updates + awareness| HP[apps/collab Hocuspocus]
  HP --- Bot[[sync bot: texto ⇄ modelo<br/>parse, reconcile, patch]]
  UI -->|HTTPS REST| API[apps/api Hono]
  API --> PG[(Postgres)]
  API --> Mail[Resend]
  HP -->|onAuthenticate: token| API
  HP -->|load/store updates| PG
  API -. eventos de permissão .-> HP
```

---

## 1. Estrutura do monorepo

```
erd-to-schema/
├─ apps/
│  ├─ web/            # o app atual (Vite + React), agora com rotas, auth e colaboração
│  ├─ api/            # Hono: auth, projetos, membros, convites, pedidos de acesso, exports
│  └─ collab/         # Hocuspocus: WebSocket Yjs, auth por documento, persistência, hospeda o sync bot
├─ packages/
│  ├─ model/          # hoje em src/model + src/formats: tipos canônicos, reconcile, geradores e parsers SQL/Prisma
│  ├─ crdt/           # schema do Y.Doc, Project ⇄ Y.Doc, diff→ops, projeção, validação defensiva
│  ├─ sync/           # sync bot isomórfico: Y.Text ⇄ modelo (parse por bloco, reconcile, patch de texto)
│  ├─ sandbox/        # execução isolada do Drizzle (isolate V8 no servidor, worker no browser)
│  ├─ emails/         # templates React Email (convite, pedido de acesso, aprovação, reset de senha)
│  ├─ canvas-kinds/   # contrato comum de "tipo de canvas" (erd, flow) — ver §8
│  ├─ db/             # schema Drizzle do backend, migrações (drizzle-kit), cliente
│  ├─ contracts/      # schemas zod compartilhados entre api e web (DTOs, papéis, eventos)
│  └─ config/         # tsconfig base, eslint, prettier, vitest preset
├─ e2e/               # Playwright: cenários multi-usuário (dois contextos de browser)
├─ docker-compose.yml # postgres, mailpit (+ redis opcional) para dev
├─ turbo.json
└─ pnpm-workspace.yaml
```

Fronteiras importantes:

- **`packages/model` é isomórfico** (roda no browser e no Node). O backend usa para gerar `schema.sql`/`schema.prisma` em exports e snapshots. O parser SQL (`libpg-query`) tem build WASM que roda nos dois lados.
- **O servidor passa a executar o Drizzle**, porque é o sync bot (§4.6) que traduz o texto compartilhado em modelo. O parse de Drizzle *executa* o código do usuário (sucrase + `drizzle-orm`), então no servidor ele roda num **isolate V8 sem nenhuma API do Node** (`isolated-vm`), com limite de memória (~64 MB) e de tempo (1,5 s, como hoje), dentro de um `worker_thread` separado: se travar, o collab não cai. Plano B, se o `isolated-vm` der problema de manutenção: um pool de processos filhos com o *permission model* do Node (`--permission`, sem fs, rede nem `child_process`). Detalhes em `packages/sandbox`.
- **`packages/crdt` e `packages/sync` não dependem de React.** Dá para testar convergência e o sync bot em Node com fast-check (já usado em `tests/roundtrip.property.test.ts`).
- Os workers do browser (`parser.worker.ts`, `drizzle.worker.ts`) ficam em `apps/web` e passam a servir para duas coisas: **lint local instantâneo** (erros aparecem enquanto você digita, sem esperar o servidor, mas sem escrever nada no documento) e o **sync bot do modo local** (§10).

---

## 2. Modelo de dados do backend (Postgres)

```
users                 (Better Auth) id, name, email, image, created_at
sessions / accounts   (Better Auth)

projects              id, name, owner_id → users, created_at, updated_at, deleted_at
                      settings jsonb  -- ex.: { editorsCanShare: false, linkSharing: 'off' | 'view' }

project_members       project_id, user_id, role ('owner' | 'editor' | 'viewer'),
                      color (índice na paleta, estável por projeto), added_by, created_at
                      PK (project_id, user_id)

invitations           id, project_id, email, role, token_hash, invited_by, expires_at, accepted_at
                      -- convite para e-mail que ainda não tem conta

access_requests       id, project_id, requester_id, requested_role ('editor'), message,
                      status ('pending' | 'approved' | 'denied' | 'cancelled'),
                      decided_by, decided_at, created_at
                      UNIQUE (project_id, requester_id) WHERE status = 'pending'

canvases              id, project_id, kind ('erd' | 'flow'), name, position,
                      created_at, updated_at, deleted_at

canvas_updates        id bigserial, canvas_id, update bytea, created_at
                      -- log append-only de updates Yjs; compactado periodicamente
canvas_state          canvas_id PK, state bytea (estado Yjs compactado), state_vector bytea,
                      json_snapshot jsonb (Project projetado, para listagem/export/busca),
                      thumbnail_url, compacted_at
canvas_versions       id, canvas_id, label, state bytea, created_by, created_at
                      -- "versões nomeadas"/histórico (fase posterior)

notifications         id, user_id, type, payload jsonb, read_at, created_at
audit_log             id, project_id, actor_id, action, payload jsonb, created_at
```

Por que um **canvas** separado do **projeto**: cada canvas é um `Y.Doc` independente (nome do documento no Hocuspocus = `canvas:<id>`). O canvas de fluxos vai carregar e sincronizar sem arrastar o ERD inteiro, e o ERD continua leve. A permissão fica no nível do projeto e vale para todos os canvases dele.

`project.json` (o formato atual do `.zip`) continua sendo o formato de import/export: `json_snapshot` guarda o mesmo `Project` projetado a partir do Y.Doc.

---

## 3. Permissões e compartilhamento

### Papéis

| Ação | owner | editor | viewer |
|---|:-:|:-:|:-:|
| Ver canvas, painéis de código, presença dos outros | ✔ | ✔ | ✔ |
| Exportar (.zip, PNG/PDF, SQL…) | ✔ | ✔ | ✔ |
| Editar canvas/painéis/notas | ✔ | ✔ | ✘ (read-only) |
| Convidar / mudar papéis / remover membros | ✔ | só se `editorsCanShare` | ✘ |
| Aprovar pedidos de acesso | ✔ | só se `editorsCanShare` | ✘ |
| Renomear / excluir / transferir projeto | ✔ | renomear | ✘ |
| Pedir acesso de edição | — | — | ✔ |

A regra de autorização vive num lugar só, `@erd/contracts` (`can(role, action)`), e é usada por API, collab e UI. A UI só esconde botões; quem garante são a API e o servidor de colaboração.

### Fluxos

- **Compartilhar:** diálogo "Compartilhar" (estilo Google Drive) → e-mail + papel. Se o e-mail tem conta, vira `project_members` direto e gera uma notificação. Se não tem, vira `invitations` com link assinado; ao criar conta pelo link, o convite é aceito.
- **Link de visualização** (opcional, `linkSharing: 'view'`): qualquer usuário logado com o link entra como viewer. Assim o pedido de edição funciona mesmo para quem chegou pelo link.
- **Pedido de acesso de edição:**
  1. O viewer vê um banner "Você está no modo visualização" com o botão **Pedir acesso de edição** (mensagem opcional).
  2. `POST /projects/:id/access-requests`. Só pode haver um pedido pendente por pessoa; o botão vira "Pedido enviado" e dá para cancelar.
  3. Quem pode aprovar recebe uma notificação in-app (sininho + badge no projeto) e um e-mail.
  4. **Aprovar** → `role = 'editor'` numa transação + `audit_log` + evento `permission-changed`. **Negar** → notificação para quem pediu.
- **Mudança de papel com a sessão aberta:** a API publica `permission-changed {projectId, userId, role}` (Postgres `LISTEN/NOTIFY` no começo; Redis pub/sub quando houver várias instâncias). O collab recebe, encontra as conexões daquele usuário naquele projeto e manda uma *stateless message*. O cliente reconecta com um token novo, e o editor sai do read-only sem recarregar a página. Se o papel foi removido, a conexão é fechada e a UI volta ao dashboard com um aviso.

### Autenticação no WebSocket

1. A web pede `POST /canvases/:id/collab-token` → a API confere a sessão e o papel e devolve um JWT curto (5 min) com `{ sub, canvasId, projectId, role, color, name }`.
2. O Hocuspocus, em `onAuthenticate`, valida a assinatura e confere que `documentName === 'canvas:' + canvasId`. Se `role === 'viewer'`, marca `connection.readOnly = true`: os updates do documento que essa conexão mandar são descartados pelo servidor, mas a *awareness* (cursor, seleção) continua funcionando.
3. Antes de expirar, o provider renova o token sozinho (`token` como função).

---

## 4. O núcleo: o modelo canônico como CRDT

Esta é a parte mais delicada. O modelo atual (`Project` em `src/model/types.ts`) usa **arrays** (`tables`, `columns`, `notes`...) e é sempre substituído em bloco: o `commit(recipe)` com immer e o `apply()` do sync engine, que troca o `schema` inteiro depois do reconcile. Para dois usuários editarem ao mesmo tempo sem se atropelar, cada **campo** precisa virar uma unidade de merge independente.

### 4.1 Forma do Y.Doc

Tudo é indexado por **ID estável** (o modelo já usa `newId('t_')`, `newId('c_')`...). A ordem vira um campo de **índice fracionário** (`fractional-indexing`) e deixa de ser a posição num array. Reordenar com `Y.Array` exige apagar e reinserir, o que duplica itens quando duas pessoas movem a mesma coluna ao mesmo tempo. Com o índice fracionário, o pior caso é um empate de posição, resolvido por desempate determinístico pelo ID.

```
Y.Doc
├─ meta: Y.Map            { name, modelVersion }
├─ tables: Y.Map<TableId, Y.Map>
│    { name, schema?, comment?, order, primaryKey (JSON), primaryKeyName?,
│      columns: Y.Map<ColumnId, Y.Map{ name, type (JSON), nullable, default?, unique?,
│                                       identity?, comment?, order, _by, _at }>,
│      uniques: Y.Map<Id, JSON>, indexes: Y.Map<Id, JSON>, checks: Y.Map<Id, JSON>,
│      _by, _at }
├─ enums: Y.Map<EnumId, Y.Map{ name, schema?, values: Y.Array<string>, order, _by, _at }>
├─ relationships: Y.Map<RelId, Y.Map{ kind, fromTable, fromColumns, toTable, ..., _by, _at }>
├─ layout: Y.Map<EntityId, Y.Map{ x, y, w?, h?, collapsed? }>
├─ entityMeta: Y.Map<EntityId, Y.Map{ tags (JSON), suppressedTags (JSON), provenance, formatNames }>
├─ notes: Y.Map<NoteId, Y.Map{ title, content: Y.Text, color?, order, _by, _at }>
├─ code: Y.Map<Format, Y.Text>        # texto compartilhado de cada painel (sql, prisma, drizzle) — §4.6
├─ sync: Y.Map<Format, JSON>          # escrito SÓ pelo sync bot: status, diagnósticos (com autor), modelRev
└─ clients: Y.Map<clientID, userId>   # mapeia o clientID do Yjs para o usuário (autoria)
```

Como os conflitos se resolvem:

- **Campos escalares** (nome, tipo, nullable...): *last-writer-wins* por campo. Se A renomeia a tabela enquanto B muda o tipo de uma coluna dela, as duas mudanças sobrevivem.
- **Valores pequenos e atômicos** (`type`, `primaryKey`, um índice): ficam como JSON e são substituídos inteiros. Mesclar metade de um índice não faz sentido.
- **Conteúdo das notas:** `Y.Text`, com merge caractere a caractere e cursores remotos (ver §5.3).
- **Valores de enum:** `Y.Array<string>`. Inserções concorrentes se intercalam, o que é aceitável para listas de valores.
- **`view` (filtros, estilo de cardinalidade) sai do documento compartilhado.** É preferência de cada pessoa e vai para `localStorage`/preferências do usuário. Hoje está dentro do `Project`, então o `.zip` passa a carregar só um *default*.

### 4.2 Invariantes depois do merge

Um CRDT garante convergência, não validade. Merges concorrentes podem produzir estados que nenhum dos dois usuários criou:

- A apaga a tabela `orders` enquanto B cria uma FK para `orders.id`.
- A e B criam ao mesmo tempo uma tabela chamada `nova_tabela`.
- A apaga uma coluna que está na PK enquanto B a renomeia.

Estratégia:

1. **A projeção é tolerante.** `@erd/crdt/project.ts` converte Y.Doc → `Project` descartando referências penduradas (FK para coluna que não existe, layout de entidade apagada). É o papel que `sanitizeSchema` já cumpre hoje, só que agora roda na leitura, sem escrever no documento.
2. **Nada de "conserto automático" concorrente.** Se cada cliente corrigisse invariantes ao receber um update, dois clientes poderiam corrigir a mesma coisa de formas diferentes (duas tabelas renomeadas para `nova_tabela_2`). A correção só acontece **como parte da intenção local**. Exemplo: quem apaga uma tabela já apaga em cascata as relações que conhece (`removeTableCascade`); o que chegar depois fica pendurado e a projeção ignora.
3. **Conflitos semânticos viram diagnóstico, não erro.** Nomes duplicados geram um aviso nos painéis ("2 tabelas chamadas `nova_tabela`") e destaque no canvas, e o usuário resolve. O gerador SQL precisa continuar gerando algo mesmo com duplicata.
4. **Validação defensiva com zod.** Um editor malicioso pode escrever lixo no Y.Doc. A projeção valida cada entidade e pula as inválidas, em vez de quebrar o render de todo mundo.

### 4.3 Como o código atual passa a escrever no Y.Doc (sem reescrever as ações)

O ponto de entrada de toda escrita hoje é `useProjectStore.getState().commit(recipe, origin, changes)`, usado por `actions.ts`, pelo Inspector, pelo `apply()` do sync engine e pelo `loadProject`. O plano é **manter essa assinatura** e trocar a implementação. (O `apply()` do sync engine sai do cliente e vai para o sync bot, §4.6, que usa o mesmo `applyDiff`.)

```ts
commit(recipe, origin, changes) {
  const before = projection;                       // snapshot imutável atual
  const after = produce(before, recipe);           // as ações continuam iguais (immer)
  sanitize + placeNewEntities(after);              // mesmas regras de hoje
  ydoc.transact(() => applyDiff(ydoc, before, after, { by: userId }), LOCAL_ORIGIN);
  // a projeção é atualizada pelo observer do Y.Doc, não aqui
}
```

`applyDiff` (em `@erd/crdt`) compara `before` e `after` **por ID** e emite só as operações mínimas: `set` nos campos que mudaram, `delete` nas entidades que sumiram, novas `Y.Map` nas entidades criadas, e recálculo de `order` só quando a posição relativa mudou. Como o immer preserva as referências do que não mudou, dá para pular sub-árvores inteiras por `===`, então o custo é proporcional ao que mudou.

**Por que diff e não os patches do immer:** os patches do immer usam índices de array (`['schema','tables',3,'columns',2,'name']`), e o `apply()` do sync engine troca o `schema` inteiro, o que gera um único patch "substituir tudo". O diff por ID serve aos dois casos com um código só.

**Projeção (Y.Doc → zustand):** `ydoc.on('afterTransaction')` reconstrói só as entidades tocadas (`transaction.changed`) e preserva a referência das outras. Assim o React Flow só re-renderiza os nós que mudaram. Os seletores atuais (`s.doc.schema`, `s.doc.layout`...) continuam funcionando.

**Origem das mudanças:** `lastOrigin` passa a sair de `transaction.origin`. Updates remotos chegam com a origem do provider e são tratados como `'remote'`; os escritos pelo sync bot, como `'sync-bot'`.

### 4.4 Undo/redo

- `Y.UndoManager` sobre os tipos do modelo, com `trackedOrigins = new Set([LOCAL_ORIGIN])`. Ctrl+Z desfaz só as suas mudanças, nunca as do colega.
- Dentro de um painel de código, vale o undo do próprio editor (o `y-codemirror.next` tem um `UndoManager` por `Y.Text`). Ele desfaz a *sua digitação*, e o sync bot reaplica o resultado no modelo. É a mesma divisão de hoje (o editor tem histórico local; o canvas, o global).
- As escritas do sync bot nunca entram no undo de ninguém. Se você desfaz uma edição no canvas, o bot atualiza os textos de novo; se desfaz uma digitação no SQL, o bot atualiza o modelo.
- `batch()` (hoje usado pela borracha) vira `undoManager.stopCapturing()` antes e depois do bloco. Os `captureTimeout` agrupam digitação.
- Os metadados de seleção (`stack-item-added`/`popped`) restauram a seleção e o viewport junto com o undo.
- O `zundo` e o `temporal` saem do store.
- **Comportamento novo para documentar:** desfazer pode não restaurar o estado exato se alguém editou o mesmo campo depois. É a semântica do Google Docs e o comportamento esperado.

### 4.5 Arrastar nós sem inundar a rede

Mover uma tabela gera dezenas de eventos por segundo. Gravar cada um no Y.Doc infla o histórico e o log do servidor. Então:

- **Durante o arrasto:** a posição vai pela **awareness** (efêmera, ~30 Hz, com throttle). Os outros veem o nó se mover suave, na cor de quem arrasta.
- **No `onNodeDragStop`** (que já existe em `Canvas.tsx`): um único `commit` grava a posição final. Uma entrada de undo, um update persistido.
- Para redimensionar nota ou tabela, a mesma regra.

### 4.6 Painéis de código com edição compartilhada (estilo Docs)

Objetivo: duas ou mais pessoas digitam no mesmo SQL (ou Prisma, ou Drizzle) ao mesmo tempo, cada uma vendo o cursor e a seleção das outras com nome e cor. Canvas e outros painéis acompanham.

Cada formato tem um `Y.Text` compartilhado (`code.sql`, `code.prisma`, `code.drizzle`), ligado ao CodeMirror pelo `y-codemirror.next`. A digitação em si é o caso fácil: o Yjs mescla caractere a caractere, como nas notas. O difícil é manter quatro vistas (canvas e três textos) coerentes.

**O problema.** Se cada cliente traduzisse texto → modelo e modelo → texto, todos fariam a mesma tradução ao mesmo tempo. A tabela escrita no SQL nasceria N vezes no modelo, uma por cliente, com IDs aleatórios diferentes. O bloco `model Orders { … }` seria inserido N vezes no Prisma. Editar texto não é idempotente.

**A regra: um único tradutor por documento, o _sync bot_.** Ele roda no servidor de colaboração, ao lado do Y.Doc (§6), e é o único participante sempre presente, com permissão de escrita e processamento serial por documento. Os clientes só escrevem **o que o usuário fez**: digitação nos `Y.Text` e edições do canvas e do Inspector no modelo. Tudo o que é **derivado** (o modelo a partir do texto, o texto a partir do modelo, status e diagnósticos em `sync`) é escrito só pelo bot, com origem `sync-bot`. Ele usa o código que já existe: parsers, `reconcile`, geradores e `applyDiff`. No modo local (§10), o mesmo `@erd/sync` roda no browser, onde só há um escritor.

#### Fluxo 1: texto → modelo

1. Alguém digita no painel SQL e todos veem a digitação ao vivo. No cliente, o worker local faz o **lint instantâneo**: mostra os erros sem escrever no documento.
2. O bot espera 400 ms depois da última mudança em `code.sql`. Com Ctrl+S, o cliente manda uma *stateless message* `flush` e o bot processa na hora.
3. **Parse por bloco.** O texto é dividido em blocos de topo: *statements* no SQL, blocos `model`/`enum` no Prisma. Um bloco que não parseia fica **congelado**: as entidades que vieram dele no último parse bem-sucedido mantêm o estado anterior no modelo, em vez de serem apagadas. O bot sabe quais são porque guarda o intervalo de cada bloco com posições relativas do Yjs, que acompanham as edições.
   É isso que torna a digitação simultânea viável: o `CREATE TABLE` pela metade da Ana não impede que a tabela que o Bruno terminou de escrever, três statements abaixo, entre no modelo.
   Mudança necessária no `reconcile`: aceitar um conjunto de entidades "não tocar", além do que ele já faz hoje.
4. Na mesma transação, o bot faz `reconcile(modeloAtual, parsed, formato, { congeladas })` seguido de `applyDiff` no modelo; atualiza `sync.sql` (status e diagnósticos, cada um com o autor da linha); e aplica os patches nos outros dois textos (Fluxo 2). O `_by` das entidades alteradas é o autor das linhas que mudaram, descoberto pelo `clientID` dos itens do `Y.Text` e pelo mapa `clients`.
5. **O texto de origem não é reformatado.** O que a pessoa escreveu fica como ela escreveu, incluindo comentários livres. Hoje eles se perdem na próxima regeneração; com o texto compartilhado, sobrevivem.
6. Se o texto mudar durante o parse (o parse é assíncrono), o resultado é descartado e o bot roda de novo. É a regra do `seq` que já existe no `sync/engine.ts`.

#### Fluxo 2: modelo → texto

1. Dispara quando o modelo muda por uma via que não é o texto daquele formato: canvas, Inspector, outro painel, undo, restauração de versão.
2. Para cada formato, o bot gera o texto canônico de antes e de depois (`gerar(modeloAnterior)` e `gerar(modeloNovo)`) e calcula o diff entre os dois com o `diff-match-patch` (primeiro por linha, depois por caractere).
3. Esse diff é aplicado como **patch** sobre o `Y.Text` atual, que pode estar diferente do canônico (formatação própria, comentários, blocos em edição). Cada trecho é localizado pelo contexto, com *fuzzy match*, como no `git apply`.
   Exemplo: a Ana renomeia `orders` no canvas enquanto o Bruno digita uma coluna nova em `customers` no SQL. A linha `CREATE TABLE orders` muda no texto do Bruno, o que ele está digitando fica intacto, e o cursor dele não pula, porque o `y-codemirror.next` ancora os cursores em posições relativas.
4. **Se um trecho do patch não encaixa** (alguém está reescrevendo justamente aquela região), o bot não força. Ele marca o bloco como **divergente** em `sync.<formato>`, por exemplo: "este bloco difere do diagrama: `orders.total` mudou no canvas enquanto o texto estava em edição". Enquanto o bloco estiver divergente, as entidades dele ficam congeladas no Fluxo 1, para que o texto antigo não desfaça a mudança do canvas sem ninguém perceber. O painel mostra duas ações nesse bloco: **"Usar o texto"** (o texto vence no próximo parse) e **"Usar o diagrama"** (o bot regenera só aquele bloco).
5. **Formatar** (botão e Shift+Alt+F): regenera o texto inteiro no formato canônico, como uma edição normal, com autoria e undo. Não é automático, porque apagaria a formatação e os comentários livres de todo mundo. As diretivas `@erd:` sobrevivem; os comentários comuns, não, e o botão avisa.

#### Drizzle: limitação conhecida

O Drizzle é *executado*, e não parseado. O código pode usar helpers, spreads e loops que atravessam o arquivo inteiro, então não dá para isolar por bloco. Se houver erro em qualquer lugar do texto Drizzle, o modelo não é atualizado a partir desse painel até o erro ser corrigido. O erro aparece na linha certa, na cor de quem a editou. Os patches do Fluxo 2 continuam funcionando normalmente.
Melhoria possível para depois: uma transformação do sucrase que envolva cada `export const` num `try/catch` e aproveite os blocos que executaram.

#### Por que não deixar um cliente "líder" fazer a tradução

Essa alternativa foi considerada e rejeitada:

- A awareness é eventualmente consistente, então há janelas em que dois clientes se acham líderes, e aí o texto sai duplicado.
- O líder pode fechar a aba no meio de uma tradução.
- Se só houver viewers conectados, ninguém tem permissão para escrever.

O custo da escolha pelo servidor é executar o Drizzle no servidor, em sandbox (§1).

#### Latência e modo offline

- **Latência:** o parse no servidor leva poucos ms (WASM) a algumas dezenas de ms (isolate do Drizzle). O tempo da digitação até o canvas atualizar continua dominado pelo debounce de 400 ms, como hoje.
- **Offline:** a digitação continua no `Y.Text` local e o lint local segue funcionando. O modelo só se atualiza a partir do texto quando a conexão volta. O canvas continua editável offline, e os textos recebem os patches ao reconectar. O indicador de conexão avisa: "Offline: os painéis de código sincronizam com o diagrama ao reconectar".

---

## 5. Presença e destaques por usuário (o "estilo Google Docs")

### 5.1 Cor de cada pessoa

- Paleta fixa de ~12 cores acessíveis, com contraste testado contra o fundo do canvas nos temas claro e escuro.
- A cor é **estável por membro dentro do projeto** (`project_members.color`), atribuída no momento da entrada, evitando as cores já usadas. Abrir o projeto amanhã mantém a sua cor, o que faz sentido para o histórico de autoria (§5.5).
- Viewers que entraram por link recebem uma cor por sessão.

### 5.2 Awareness (estado efêmero, não persistido)

Cada cliente publica:

```ts
{
  user: { id, name, avatar, color },
  cursor?: { x, y },                  // coordenadas do canvas (flow), não da tela
  selection?: Id[],                   // nós/arestas selecionados
  editing?: { entityId, field? },     // ex.: renomeando a tabela, editando a coluna X no Inspector
  dragging?: { id: Id; x: number; y: number }[],
  panel?: { format, entityId? },      // está editando o painel SQL na tabela X
  viewport?: { x, y, zoom },          // para o "seguir usuário"
}
```

### 5.3 O que aparece na tela

| Onde | Indicador |
|---|---|
| Canvas | **Cursor remoto** com a etiqueta do nome na cor do usuário (some após ~5 s parado). |
| Nós (tabela/enum/nota) | **Anel na cor** de quem está com o nó selecionado. Com várias pessoas, mostra até 3 mini-avatares no canto do nó. |
| Campo em edição | Se alguém está renomeando a tabela ou editando uma coluna, a linha fica com fundo tingido na cor dele e um selo "Fulana está editando". É um **soft lock**: não bloqueia, só avisa, e se você editar também vale o *last-writer-wins*. |
| Arraste remoto | O nó se move ao vivo com a borda na cor de quem arrasta (via awareness, §4.5). |
| Arestas | Uma aresta selecionada por alguém ganha o traço na cor dele. |
| Notas (Markdown) | `y-codemirror.next` sobre o `Y.Text`: **cursor e seleção remotos** com rótulo e cor, igual ao Google Docs. |
| Painéis SQL/Prisma/Drizzle | O mesmo do Google Docs nas notas: cursor, seleção e nome de cada pessoa digitando, na cor dela (§5.4). |
| Header | Pilha de avatares de quem está online. Clicar num avatar **segue** a pessoa (viewport sincronizado) ou só centraliza nela. |
| Minimap | Pontinhos na cor de cada usuário na posição do viewport dele. |

Os componentes de presença ficam numa camada própria (`apps/web/src/collab/presence/`), sem misturar com `TableNode`/`NoteNode`. Os nós recebem só uma prop derivada `presence: { color, label }[]` vinda de um seletor.

### 5.4 Presença nos painéis de código

Os painéis são texto compartilhado (§4.6), então ganham o pacote completo do Google Docs:

- **Cursores e seleções remotos** com o nome flutuando na cor da pessoa (`yRemoteSelections` do `y-codemirror.next`, alimentado pela awareness). Vale também para quem está em outra aba de formato: o seletor de abas mostra bolinhas coloridas de quem está em SQL, Prisma ou Drizzle.
- **Rastro de digitação:** o texto inserido por outra pessoa fica com fundo na cor dela por alguns segundos e depois desbota (decoração do CodeMirror alimentada pelos *deltas* remotos do `Y.Text`).
- **Erros com dono:** os diagnósticos que o bot escreve em `sync.<formato>` carregam o autor da linha. O sublinhado de erro de um bloco que a Ana está escrevendo aparece para todos como "em edição por Ana", em vez de parecer que o arquivo está quebrado.
- **Ponte com o canvas:** os geradores passam a emitir um **source map** simples (`entityId → intervalo de linhas`), e o parse por bloco devolve o mesmo mapa a partir do texto real. Com ele:
  - a **gutter** mostra uma faixa na cor de quem está selecionando aquela tabela no canvas;
  - uma tabela fica com o anel da cor de quem está com o cursor dentro do `CREATE TABLE` dela;
  - clicar numa tabela no canvas rola o painel até ela, e vice-versa.

### 5.5 Autoria das edições ("quem mudou o quê")

Duas camadas:

1. **Rastro recente (efêmero):** quando chega um update remoto, as entidades tocadas (`transaction.changed`, mapeadas pelo `clients` → usuário) ganham por ~8 s um **realce na cor do autor**, que vai desbotando. Uma coluna nova "acende" na cor de quem criou. É o equivalente ao destaque das edições alheias no Google Docs.
2. **Autoria persistente:** cada entidade guarda `_by` (userId) e `_at` (timestamp), gravados na mesma transação da edição. Quando a edição veio do texto, o bot grava como autor quem escreveu as linhas (§4.6). Um botão **"Mostrar autoria"** pinta a borda de cada tabela, coluna e nota com a cor de quem a editou por último, e mostra um tooltip "editado por Fulana há 3 min". Nas notas e nos painéis de código, o mesmo botão pinta **cada trecho de texto** na cor de quem o escreveu. Cada item de um `Y.Text` carrega o `clientID` do autor, e o mapa `clients` o traduz para o usuário; o `Y.PermanentUserData` cobre o histórico entre sessões.

Mais tarde, com `canvas_versions` (§6.3), dá para ter um modo **"o que mudou desde a versão X"**: tabelas e colunas adicionadas, removidas ou alteradas, coloridas por autor. Esse modo reusa a lógica de mudanças do `reconcile` que hoje alimenta o toast.

---

## 6. Servidor de colaboração (`apps/collab`)

### 6.0 O que é o Hocuspocus e por que usar

O **Yjs** é a biblioteca de CRDT: sabe mesclar edições, mas não sabe nada de rede. Ela define um protocolo de sincronização (troca de *state vectors* e updates binários) e de *awareness* (presença), e alguém precisa transportar isso. O **Hocuspocus** é um servidor WebSocket para Yjs, open source (MIT), mantido pelo time do Tiptap. É ele que dá vida ao "estilo Google Docs" no backend.

O que ele resolve, que de outro jeito seria escrito à mão:

- **Salas por documento:** cada `canvas:<id>` é uma sala. Ele mantém o `Y.Doc` em memória enquanto há alguém conectado, repassa updates e awareness para os outros da sala e descarrega o documento quando todos saem.
- **Hooks no ciclo de vida:** `onAuthenticate` (validar o token e definir read-only), `onLoadDocument` e `onStoreDocument` (persistência no nosso Postgres), `onChange`, `onDisconnect`. Na prática, a integração com o resto do sistema é escrever esses hooks.
- **Conexões read-only** prontas para os viewers.
- **Multiplexação:** um WebSocket por aba, mesmo com vários documentos abertos (ERD e fluxos).
- **Reconexão e sincronização incremental:** ao voltar do offline, o cliente manda só o que falta.
- **Escala horizontal** com a extensão Redis.
- **Stateless messages** para avisos fora do documento (mudança de permissão, `flush` do Ctrl+S).
- No cliente, o `HocuspocusProvider` liga o `Y.Doc` ao servidor.

Alternativas consideradas:

- **`y-websocket`:** o servidor de referência do Yjs. Mínimo demais: autenticação, persistência e read-only teriam que ser escritos à mão.
- **Liveblocks, PartyKit/Cloudflare, Y-Sweet:** gerenciados ou semi-gerenciados. Menos código, mas são pagos, prendem a um fornecedor e deixam o documento fora do seu banco.
- **Socket.io + OT próprio:** é reimplementar o Google Docs do zero. Não.

### 6.1 Ciclo de vida

- **`onAuthenticate`:** valida o JWT (§3) e define `readOnly`.
- **`onLoadDocument`:** lê `canvas_state.state` e aplica, por cima, os `canvas_updates` posteriores à última compactação.
- **`onStoreDocument`** (com debounce de ~2 s e `maxDebounce` de ~10 s): faz append do update incremental em `canvas_updates`. A cada N updates ou T minutos, **compacta**: grava o `Y.encodeStateAsUpdate` em `canvas_state`, apaga os updates antigos, recalcula o `json_snapshot` (projeção via `@erd/crdt`) e atualiza `projects.updated_at`.
- **`onChange`:** valida o tamanho do update (por exemplo, rejeita acima de 1 MB) e aplica limite de taxa por conexão.
- **Garbage collection** do Yjs ligada (`gc: true`). As versões nomeadas guardam snapshots completos, então o histórico fino não é necessário.
- **Sync bot** (§4.6): uma extensão do Hocuspocus que observa cada documento carregado. Mantém uma **fila serial por documento**, roda os parsers SQL e Prisma no próprio processo e manda o Drizzle para um pool de `worker_threads` com o sandbox. Como só escreve com origem `sync-bot`, ignora as próprias transações e não entra em loop. Métricas: tempo de parse por formato, timeouts do sandbox e taxa de patches divergentes.

### 6.2 Escala

- Começo: **uma instância** com API e collab no mesmo processo Node (o Hocuspocus se acopla no servidor HTTP do Hono). É o deploy mais simples.
- Quando precisar: separar os processos e ligar a **extensão Redis** do Hocuspocus, que propaga updates e awareness entre instâncias. Os eventos de permissão passam para o Redis pub/sub. No Railway, isso significa um serviço Redis e `numReplicas` > 1 no `server` (§15.5). Antes do Redis, **nunca** mais de uma réplica.

### 6.3 Versões

- **Snapshot automático diário** e um **"Salvar versão"** manual com nome → `canvas_versions`.
- **Restaurar versão** = calcular o diff entre o estado atual e a versão e aplicá-lo como uma transação normal (via `applyDiff`). Assim a restauração propaga para todos ao vivo e pode ser desfeita, em vez de trocar o documento por baixo dos clientes.

---

## 7. API (`apps/api`)

### 7.0 Por que Hono e Better Auth

> **Decidido:** Hono + Better Auth. Esta seção registra o porquê e as alternativas descartadas (Express 5 e auth manual).

**Hono × Express.** A API do Hono é quase a do Express (`app.get('/projects', handler)`, middlewares em cadeia), então a curva de aprendizado é pequena. A diferença está no que vem de graça num monorepo TypeScript:

| | Hono | Express 5 |
|---|---|---|
| Tipos | TypeScript-first: parâmetros, corpo validado e resposta são inferidos | `req`/`res` pouco tipados; corpo é `any` até você validar |
| Cliente tipado na web | `hc<AppType>()`: a web importa o *tipo* da API e chama `client.projects[':id'].$get(...)` com autocomplete e erro de compilação se o contrato mudar. Sem codegen | Precisa de uma camada extra (tRPC, ts-rest) ou de tipos duplicados à mão |
| Validação | `@hono/zod-validator` integrado ao tipo da rota | Middleware próprio ou biblioteca |
| Async/erros | Nativo | Nativo desde o Express 5 (antes era o problema clássico) |
| Padrão de plataforma | `Request`/`Response` da Web: o mesmo código roda em Node, Bun, Deno ou edge | Só Node |
| Ecossistema | Menor, mas cobre o que precisamos (CORS, cookies, rate limit, WebSocket) | Enorme e muito conhecido |

Escolha: **Hono**, principalmente pelo cliente tipado: ele elimina uma classe inteira de bugs de "a API mudou e a web não". Express 5 + zod + ts-rest seria a alternativa, e foi descartada.

Na prática:
- a API roda em Node com `@hono/node-server`;
- as rotas são agrupadas por recurso (`projects`, `members`, `access-requests`...) com `app.route()`, e o validador de cada rota é o `zValidator` com os schemas de `@erd/contracts`;
- `apps/api` exporta `type AppType = typeof app`, e `apps/web` usa `hc<AppType>(baseUrl)` envolvido em hooks do TanStack Query;
- o Hocuspocus se acopla ao mesmo servidor HTTP via `upgrade` do WebSocket (§6.2), usando o `@hono/node-ws` ou o servidor Node por baixo.

**Better Auth × auth manual.** Login com e-mail e senha "só" parece pequeno. A lista do que precisa estar certo é longa, e cada item é um bug de segurança em potencial:

- hash de senha com argon2id e parâmetros adequados;
- tokens de sessão aleatórios guardados com hash no banco, cookie `HttpOnly`/`Secure`/`SameSite`, rotação e revogação (por exemplo, ao trocar a senha);
- proteção contra CSRF;
- limite de tentativas de login;
- verificação de e-mail e reset de senha com tokens de uso único que expiram, comparados em tempo constante;
- OAuth (GitHub/Google) com `state` e PKCE, e vinculação de contas com o mesmo e-mail.

O **Better Auth é uma biblioteca, não um serviço** (não é um Auth0 ou Clerk). Ele roda dentro da sua API, e as tabelas (`user`, `session`, `account`, `verification`) são geradas **no seu schema Drizzle**, no seu Postgres. Você continua dono dos dados, sem mensalidade e sem lock-in. O envio dos e-mails de verificação e de reset é um callback que chama o nosso `Mailer` (§7.2). Se depois quiser 2FA ou passkeys, são plugins.

Escolha: **Better Auth**. Na prática:
- `auth` é configurado em `apps/api/src/auth.ts` com o `drizzleAdapter` apontando para `@erd/db`;
- as tabelas geradas pela CLI do Better Auth entram no schema Drizzle e nas migrações do drizzle-kit, ao lado de `projects` etc.;
- as rotas são montadas com `app.on(['GET','POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`;
- um middleware Hono chama `auth.api.getSession({ headers })` e põe `user` no contexto de cada rota;
- o mesmo `getSession` é usado ao emitir o token de colaboração (§3);
- `emailAndPassword` com `requireEmailVerification`, `sendVerificationEmail` e `sendResetPassword` chamam o `Mailer` (§7.2), e `socialProviders` cobre GitHub e Google;
- o *rate limit* embutido do Better Auth fica ligado nas rotas de login e reset.

A alternativa descartada era auth manual. Ela só valeria a pena com o objetivo de aprender, e nesse caso a referência seria o guia do Lucia (lucia-auth.com).

### 7.1 Rotas

```
Auth (Better Auth)        /api/auth/*  (signup, login, OAuth GitHub/Google, logout, sessão)

Projetos
  GET    /projects                          ?filter=mine|shared  → lista (nome, papel, updated_at, thumb, membros online)
  POST   /projects                          { name, template?: 'empty'|'sample', importZip? }
  GET    /projects/:id                      → projeto + canvases + meu papel
  PATCH  /projects/:id                      { name, settings }
  DELETE /projects/:id                      (soft delete; owner)
  POST   /projects/:id/transfer             { userId }  (owner)

Canvases
  POST   /projects/:id/canvases             { kind: 'erd'|'flow', name }
  PATCH  /canvases/:id  /  DELETE /canvases/:id
  POST   /canvases/:id/collab-token         → JWT curto para o WebSocket
  GET    /canvases/:id/export?format=zip|sql|prisma|drizzle   (gerado a partir do json_snapshot)
  POST   /canvases/:id/import               (.zip / .sql / .prisma — o cliente parseia e manda um update Yjs)
  GET    /canvases/:id/versions  /  POST /canvases/:id/versions

Membros e compartilhamento
  GET    /projects/:id/members
  POST   /projects/:id/members              { email, role }  → membro ou convite
  PATCH  /projects/:id/members/:userId      { role }
  DELETE /projects/:id/members/:userId      (ou sair do projeto, se for o próprio usuário)
  POST   /invitations/:token/accept

Pedidos de acesso
  POST   /projects/:id/access-requests      { message? }
  GET    /projects/:id/access-requests      (quem pode aprovar)
  POST   /access-requests/:id/approve | /deny | /cancel

Notificações
  GET    /notifications   /  POST /notifications/read
```

- Contratos em `@erd/contracts` (zod), validados na API e reaproveitados pelo cliente Hono RPC na web.
- Testes de integração com Postgres real (Testcontainers ou o Postgres do `docker-compose`), cobrindo **cada regra da tabela de permissões**.

**Import de projeto:** o cliente monta o `Project` a partir do `.zip` (ou de um `.sql`/`.prisma`/`.ts` solto, com os workers locais), converte para um update Yjs (`@erd/crdt/fromProject`) e manda para o canvas novo. O servidor valida a projeção do resultado com zod antes de aceitar. Os `Y.Text` dos painéis vêm vazios, e o sync bot os gera no formato canônico na primeira carga. Num import de texto solto, o texto original vai direto para o `Y.Text` daquele formato, preservando a formatação e os comentários.

### 7.2 E-mail

**Serviço: Resend** em produção, com templates em **React Email** (`packages/emails`, do mesmo time; os e-mails são componentes JSX com preview no browser).

- **Por que Resend:** a API é uma chamada só (`resend.emails.send({ from, to, subject, react })`), o SDK é bom em TypeScript e o plano gratuito basta para começar (na última vez que conferi, 3.000 e-mails/mês e 100/dia, com um domínio; confirmar o preço atual antes de contratar).
- **Alternativas:**
  - **Postmark:** a melhor reputação de entrega para e-mail transacional, mas pago desde o início.
  - **Amazon SES:** o mais barato em volume (centavos por mil e-mails), porém com mais configuração e uma etapa de aprovação para sair do *sandbox*.
  - **Brevo** ou **SendGrid:** com plano gratuito, menos agradáveis de usar.
- **Em dev: Mailpit** no `docker-compose`. É um servidor SMTP falso com interface web (`localhost:8025`) que captura todos os e-mails, para testar convites e resets sem enviar nada de verdade. O e2e lê os links de convite pela API do Mailpit.
- **Interface `Mailer`** com duas implementações: `ResendMailer` (produção) e `SmtpMailer` (Mailpit, via nodemailer). Trocar de provedor depois é trocar uma classe.
- **Envio assíncrono com retentativa:** a requisição não espera o e-mail. A rota grava um job, e um worker envia com *backoff* em caso de falha. A fila é o **pg-boss**, que roda sobre o próprio Postgres (sem Redis só para isso). O worker pode ficar no mesmo processo da API no começo.
- **Domínio:** remetente num subdomínio próprio (por exemplo, `notificacoes@mail.seudominio.com`), com SPF, DKIM e DMARC configurados no DNS. Sem isso, os e-mails caem no spam.

E-mails do sistema:

| E-mail | Disparado por | Pode desligar? |
|---|---|---|
| Verificação de conta | Cadastro | Não |
| Reset de senha | "Esqueci a senha" | Não |
| Convite para projeto | Compartilhar com um e-mail (com ou sem conta) | Não (é o convite) |
| Novo pedido de acesso de edição | Viewer pede acesso → vai para quem pode aprovar | Sim (fica só a notificação in-app) |
| Pedido aprovado / negado | Decisão do owner | Sim |
| Você foi adicionado / mudou de papel | Mudança em `project_members` | Sim |

- **Antiabuso:** compartilhar dispara e-mail para endereços arbitrários, o que vira vetor de spam. Por isso: limite de convites por usuário e por hora, nenhum conteúdo livre do remetente no assunto, e a mensagem opcional do pedido de acesso aparece escapada e truncada.
- **Preferências:** em "Configurações > Notificações", com link de *unsubscribe* nos e-mails desligáveis.

---

## 8. Front-end (`apps/web`)

### 8.1 Rotas

```
/login, /signup, /invite/:token
/                         dashboard: "Meus projetos", "Compartilhados comigo", busca, novo projeto
/p/:projectId             redireciona para o primeiro canvas
/p/:projectId/c/:canvasId o editor (o App.tsx atual, agora por canvas)
/p/:projectId/settings    membros, pedidos de acesso, link de compartilhamento, zona de perigo
/local                    modo local sem conta (o app atual, IndexedDB) — ver §10
```

### 8.2 O editor por canvas

- Abas no topo para os canvases do projeto: **"Diagrama ER"** e **"Fluxos de usuário"** (desabilitada, "em breve", até a fase 8).
- `bootstrap.ts` vira `openCanvas(canvasId)`: cria o `Y.Doc`, liga o `y-indexeddb` (cache local e offline), conecta o `HocuspocusProvider`, cria a projeção e o `UndoManager`, e liga os editores de código aos `Y.Text` (com o lint local; o sync bot só sobe no browser no modo local). `closeCanvas()` desfaz tudo ao trocar de rota. Os stores deixam de ser singletons globais e passam a ser criados por canvas (`createProjectStore(ydoc)` + React context), para evitar vazamento entre projetos.
- **Indicador de conexão** no header: "Salvo", "Sincronizando…", "Offline: as alterações serão enviadas ao reconectar".
- **Modo visualização:** toolbar e Inspector em read-only, editores de código com `EditorState.readOnly`, atalhos de edição desligados (o `keydown` atual passa a checar `can('edit')`), banner com **Pedir acesso de edição**. Exportar continua disponível.
- O autosave em IndexedDB atual sai: o `y-indexeddb` cumpre esse papel.

### 8.3 Contrato de "tipo de canvas" (prepara o canvas de fluxos)

Para o segundo canvas não virar uma cópia do primeiro, o editor passa a falar com uma interface:

```ts
interface CanvasKind<P> {
  kind: 'erd' | 'flow';
  label: string;
  /** schema do Y.Doc + projeção + diff (em @erd/crdt/<kind>) */
  doc: { init(ydoc): void; project(ydoc): P; applyDiff(ydoc, before: P, after: P): void };
  nodeTypes: NodeTypes;  edgeTypes: EdgeTypes;
  derive(p: P, view): { nodes: Node[]; edges: Edge[] };   // hoje: canvas/derive.ts
  Toolbar: FC;  Inspector: FC;  SidePanels?: FC;           // ERD: painéis de código; flow: nenhum/outros
  shortcuts: ShortcutMap;
  exporters: Exporter[];
}
```

**Compartilhado entre os dois tipos:** presença, autoria, undo, conexão, export de imagem, notas, minimap, as regras de arrasto via awareness e a camada de permissões. **Específico de cada tipo:** nós, arestas, toolbar, inspector e painéis laterais.

---

## 9. Canvas de fluxos de usuário (só planejamento)

O objetivo é desenhar jornadas (telas, ações, decisões) e **ligá-las ao modelo de dados**.

- **Nós:** `screen` (tela, com nome, rota e descrição), `action` (o que o usuário faz), `decision` (losango com condições), `start`/`end`, `note` (reaproveitando a nota em Markdown), `group`/raia (por papel de usuário ou por área).
- **Arestas:** transição, com um rótulo de evento ("clicar em Comprar") e uma condição opcional.
- **Ponte com o ERD:** uma tela ou ação pode declarar **quais tabelas e colunas lê e escreve** (`reads`/`writes` com IDs de entidade do ERD). Isso permite:
  - no ERD, filtrar ou realçar as tabelas usadas por um fluxo;
  - no fluxo, avisar quando uma referência quebrou (a tabela foi apagada ou renomeada; o nome é resolvido pelo ID, então renomear não quebra);
  - em fases futuras, gerar esqueletos de queries, de endpoints ou de casos de teste.
- **Referência entre documentos:** como são Y.Docs separados, o fluxo guarda só `{ canvasId, entityId }`. O nome é resolvido lendo o `json_snapshot` do ERD (ou o Y.Doc do ERD, se estiver aberto). Ter as duas abas abertas não exige carregar os dois documentos o tempo todo.
- **Layout automático:** elkjs (camadas, da esquerda para a direita), já cogitado no plano original.
- **Export:** PNG/PDF (reaproveitado) e Mermaid `flowchart` (texto). Mais tarde, um painel de texto bidirecional em Mermaid, no mesmo espírito dos painéis de SQL.

---

## 10. Migração do app atual

- O **modo local** (`/local`) continua existindo sem conta. Ele usa o mesmo Y.Doc com `y-indexeddb` e sem provider, e o **sync bot roda no próprio browser**: é o mesmo `@erd/sync`, com o Drizzle no worker atual em vez do isolate. Com um só usuário há um só escritor, então a regra do §4.6 vale do mesmo jeito. Isso testa o binding CRDT e o bot sem servidor, e mantém o app usável offline e para quem só quer experimentar.
- **"Enviar para a nuvem":** num projeto local, depois do login, cria o projeto no servidor e envia o estado do Y.Doc.
- **Conversão do IndexedDB antigo** (chave `current` com o `Project` em JSON) para o Y.Doc local via `@erd/crdt/fromProject`, na primeira abertura.
- O `.zip` continua igual (`project.json`, `notes/*.md`, os três schemas), então import e export entre local e nuvem funcionam nos dois sentidos.

---

## 11. Testes

| Nível | O que cobrir |
|---|---|
| `@erd/model` | Os testes atuais (`sql`, `prisma`, `drizzle`, `roundtrip.property`...) migram sem mudança. |
| `@erd/crdt` (propriedade, fast-check) | **Convergência:** N réplicas aplicam sequências aleatórias de ações de `actions.ts` em ordens diferentes e terminam com a mesma projeção. **Validade:** toda projeção passa no zod e gera SQL que o `libpg-query` aceita. **Ida e volta:** `project(fromProject(p)) ≡ p`. **Diff mínimo:** `applyDiff(a, a)` não gera nenhuma operação. |
| `@erd/sync` (propriedade + cenários) | **Sem duplicação:** N clientes digitando concorrentemente no mesmo `Y.Text` → o modelo tem cada tabela uma única vez. **Parse por bloco:** um statement quebrado não apaga as entidades dele e não bloqueia os outros blocos. **Patch modelo → texto:** renomear no canvas com o texto reformatado à mão ainda acerta a linha; um patch que não encaixa vira bloco divergente, nunca texto corrompido. **Ponto fixo:** texto canônico → parse → gerar é idempotente, e o bot não entra em loop com as próprias escritas. |
| `@erd/sandbox` | Loop infinito → timeout; alocação gigante → limite de memória; `require('fs')`, `process` e `fetch` indisponíveis; o crash de um isolate não derruba o collab. |
| API | Integração com Postgres real: matriz de permissões completa, convites, pedidos de acesso (incluindo os pendentes duplicados), mudança de papel. |
| Collab | Uma conexão read-only não altera o documento; um token de outro canvas é recusado; a mudança de papel reconecta; a compactação preserva o estado. |
| E-mail | Os templates renderizam (snapshot); o convite chega no Mailpit com um link válido que expira; o limite de convites por hora funciona; com o envio falhando, o job é retentado. |
| E2E (Playwright) | Dois `browserContext`s logados como usuários diferentes: criar uma tabela em A e vê-la em B em menos de 1 s; **A e B digitando no mesmo painel SQL ao mesmo tempo**, com os dois cursores visíveis e o canvas refletindo as duas tabelas; cursor e anel de seleção na cor certa; o viewer não edita e pede acesso; o owner aprova pelo link do e-mail (lido no Mailpit) e o viewer vira editor sem recarregar; offline em A → editar → reconectar → B recebe. Os roteiros atuais (`e2e/*.mjs`) migram para `@playwright/test`. |

A CI (GitHub Actions) roda, via Turborepo e com cache por pacote: lint, typecheck, testes unitários e de propriedade, integração com o serviço Postgres e e2e.

---

## 12. Fases de entrega

Cada fase termina com o app funcionando e os testes verdes. A ordem ataca primeiro o maior risco técnico (o binding CRDT), antes de existir backend.

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0. Monorepo** | pnpm + Turborepo; `src/` vira `apps/web`; `src/model` + `src/formats` viram `packages/model`; `packages/config`; CI; `apps/web/Dockerfile` + `Caddyfile` publicando o app local num serviço `web` de staging no Railway (§15.8). **Nenhuma mudança de comportamento.** | `pnpm build`, `test` e `e2e` passam como hoje. |
| **1. Y.Doc local** | `packages/crdt` (schema, `fromProject`, projeção, `applyDiff`); `commit()` reimplementado por cima do Y.Doc; `Y.UndoManager` no lugar do zundo; `y-indexeddb` no lugar do autosave; `view` separado do documento. **Painéis sobre `Y.Text` + `packages/sync` rodando no browser** (parse por bloco, patch modelo → texto, blocos divergentes), substituindo o `sync/engine.ts`. Ainda sem servidor. | Testes de propriedade do CRDT e do bot; todos os e2e atuais passam; undo e redo com o mesmo comportamento percebido. Dá para simular dois usuários com dois Y.Docs no mesmo processo, antes de existir rede. |
| **2. Backend + contas** | `packages/db`, `apps/api` com Better Auth, `packages/emails` + `Mailer` + Mailpit (verificação de conta e reset de senha já usam e-mail), CRUD de projetos e canvases, dashboard e rotas na web, import do `.zip` e do projeto local. Persistência por enquanto via upload do estado Yjs pela API (sem tempo real). | Criar conta (com o e-mail de verificação chegando no Mailpit), criar e abrir projetos, recarregar e ver o estado salvo. |
| **2B. Conformidade de deploy (Railway)** | Dockerfiles, `Caddyfile`, `railway.json` por serviço, migrações no pre-deploy, `env.ts`, healthchecks, shutdown gracioso, scripts `verify`/`prod:local`, CI com Wait for CI, ambiente de staging no ar (§15). | Um `git push` em `main` publica no staging sem passo manual; `pnpm prod:local` reproduz a produção; um deploy com migração não derruba sessões abertas. |
| **3. Tempo real** | `apps/collab` (Hocuspocus, persistência com log e compactação, token JWT); **o sync bot passa do browser para o servidor**, com `packages/sandbox` para o Drizzle; `HocuspocusProvider` na web; indicador de conexão; arraste via awareness; cursores remotos básicos nos painéis. | E2E com dois usuários editando o mesmo canvas **e o mesmo painel de código**, incluindo offline e reconexão. |
| **4. Compartilhamento** | Membros, convites por e-mail, papéis, modo visualização, pedidos de acesso, notificações in-app e por e-mail (com fila pg-boss e preferências), mudança de papel ao vivo, link de visualização. Conta no Resend e DNS (SPF/DKIM/DMARC) do domínio. | Matriz de permissões coberta por testes de API e e2e. |
| **5. Presença e autoria** | Cores por membro, cursores no canvas, anéis de seleção, soft lock, avatares e "seguir", notas e painéis com rastro de digitação, erros com dono, ponte painel ⇄ canvas via source map, rastro recente, modo "Mostrar autoria" (entidades e trechos de texto). | E2E verificando cor e rótulo; teste manual com 3 a 4 pessoas digitando no mesmo SQL. |
| **6. Produção** | Versões nomeadas e restauração, thumbnails, limites e taxas, observabilidade (logs estruturados, métricas de conexões e tamanho de documentos), ambiente de produção no Railway separado do staging, backups agendados + `pg_dump` externo (§15.6, §15.8). | Produção no ar no Railway; teste de carga no staging com cerca de 20 clientes num documento de 200 tabelas. |
| **7. Escala** (sob demanda) | Separar API e collab; extensão Redis; múltiplas instâncias. | — |
| **8. Fluxos de usuário** | `CanvasKind` "flow" (§9). | — |

O **contrato `CanvasKind`** (§8.3) entra na fase 1 ou 3, quando o editor deixa de ser singleton. Assim a fase 8 só adiciona um tipo novo, sem refatorar o editor.

### Deploy

Tudo roda no **Railway**: um serviço `web` (Caddy) como único domínio público, um `server` (API + collab) na rede privada e o Postgres do Railway. Arquivos, comandos, variáveis e o passo a passo estão no §15.

---

## 13. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Merges que quebram invariantes do schema (FK órfã, nomes duplicados) | Projeção tolerante + diagnósticos nos painéis; correções só como intenção local (§4.2); testes de propriedade com réplicas concorrentes. |
| `applyDiff` lento em diagramas grandes | Pular sub-árvores por referência (`===`) do immer; *benchmark* com 500 tabelas na fase 1. |
| Tradução texto ⇄ modelo duplicando entidades ou texto | Um único escritor (o sync bot) por documento, com fila serial (§4.6); teste de propriedade "sem duplicação". |
| Digitação de um bloqueando a sincronização dos outros | Parse por bloco com entidades congeladas (§4.6). Exceção: o Drizzle continua por arquivo inteiro (limitação documentada). |
| Patch modelo → texto caindo no lugar errado | Patch com contexto (*fuzzy*); na dúvida, o bloco vira divergente com escolha explícita, nunca uma escrita às cegas. |
| Gargalo no sync bot com muitos documentos ativos | Parse barato (WASM); Drizzle num pool de workers; debounce por documento; métricas de fila; se preciso, o bot vira um serviço separado consumindo os documentos via Redis. |
| Crescimento do log de updates | Compactação periódica + GC do Yjs; arraste via awareness. |
| Editor malicioso corrompendo o documento | Validação zod na projeção; limites de tamanho e taxa no collab; versões para restaurar; `audit_log`. |
| Mudança de papel não refletida em sessões abertas | Evento `permission-changed` + JWT curto (5 min) como rede de segurança. |
| Undo surpreendente em colaboração | Documentar a semântica "desfaz só as suas mudanças"; restaurar a seleção junto com o undo. |
| Executar o Drizzle do usuário no servidor | Isolate V8 sem APIs do Node (`isolated-vm`), com limites de memória e tempo, num `worker_thread` separado; plano B com processos filhos e `--permission`; testes de escape no `@erd/sandbox` (§1). |
| E-mails caindo no spam / abuso de convites | SPF, DKIM e DMARC num subdomínio próprio; limite de convites por hora; conteúdo do remetente escapado (§7.2). |

---

## 14. Decisões em aberto (com recomendação)

Já decidido: **Drizzle** no backend; **painéis de código com digitação compartilhada** estilo Docs (§4.6); **Hono** na API e **Better Auth** para autenticação (§7.0); **deploy no Railway** (§15).

1. **Provedores de login:** e-mail/senha + GitHub + Google? (Recomendação: sim, os três.)
2. **Manter o modo local sem conta?** Recomendação: sim. É barato, porque usa o mesmo binding CRDT, e serve de porta de entrada.
3. **Editores podem compartilhar?** Default `editorsCanShare: false`, configurável por projeto.
4. **Fluxo de promoção no Railway:** staging deploya de `develop` e produção de `main`, ou os dois de `main`, com produção promovida manualmente? Recomendação: `main` → staging automático e produção por tag/release, até existirem usuários reais (§15.6).

---

## 15. Conformidade de deploy (Railway)

> Etapa **2B** das fases (§12). Entra assim que existe backend, para que todo o resto do desenvolvimento já seja publicado num ambiente de staging real. Cada fase seguinte tem um item de conformidade no checklist do §15.8.
>
> Os detalhes do Railway mudam rápido. Os pontos marcados com ⚠ devem ser conferidos na documentação ([docs.railway.com](https://docs.railway.com)) no momento de executar a etapa.

### 15.1 Topologia no Railway

Um projeto Railway com dois ambientes: `production` e `staging`. Os *PR environments* ficam opcionais.

```mermaid
flowchart LR
  U[Browser] -->|HTTPS + WSS<br/>domínio público| W
  subgraph Railway project
    W[web<br/>Caddy: estáticos + proxy] -->|http://server.railway.internal:8080<br/>/api, /collab| S[server<br/>Hono + Better Auth + Hocuspocus<br/>+ sync bot + worker de e-mail]
    S --> P[(Postgres<br/>template Railway)]
    S -.fase 7.-> R[(Redis)]
  end
  S --> M[Resend]
```

| Serviço | Origem | Público? | Observações |
|---|---|---|---|
| `web` | `apps/web/Dockerfile` (build do Vite + Caddy) | **Sim**: o único com domínio | Serve o SPA e faz *reverse proxy* de `/api/*` e `/collab` para o `server` pela rede privada. |
| `server` | `apps/api/Dockerfile` | Não | API, Better Auth, Hocuspocus, sync bot, sandbox e worker da fila de e-mail, num processo só. |
| `Postgres` | Template de banco do Railway | Não (a URL pública fica só para manutenção) | Backups agendados (§15.6). |
| `Redis` | Template (só na fase 7) | Não | Extensão Redis do Hocuspocus, quando houver mais de uma réplica do `server`. |

**Por que um único domínio público (o `web` fazendo proxy):**
- **Mesma origem** para o SPA, a API e o WebSocket: sem CORS, e o cookie de sessão do Better Auth é *first-party* (`SameSite=Lax`).
- Se `web` e `server` tivessem cada um o seu domínio `*.up.railway.app`, eles seriam *sites diferentes*, porque `up.railway.app` está na *Public Suffix List* ⚠. O cookie da sessão viraria cookie de terceiros, e os navegadores estão bloqueando esse tipo de cookie.
- O `server` não fica exposto diretamente à internet.
- Na fase 7, separar o collab é só trocar o destino de `/collab` no Caddy para `collab.railway.internal`.

### 15.2 Arquivos novos

```
.node-version                 # 24 (LTS) — lido pelo Railway, pelo CI e pelo fnm/nvm
.npmrc                        # inject-workspace-packages=true (para o `pnpm deploy`)
.dockerignore                 # node_modules, **/dist, .turbo, .git, e2e/artifacts, .env*
.env.example                  # todas as variáveis, com comentário de onde vêm (§15.4)
docker-compose.yml            # dev: postgres + mailpit; profile "prod": as duas imagens reais
turbo.json
pnpm-workspace.yaml
.github/workflows/ci.yml      # verify + e2e contra o "prod:local"

apps/web/Dockerfile
apps/web/Caddyfile
apps/web/railway.json
apps/api/Dockerfile
apps/api/railway.json
apps/api/tsdown.config.ts     # bundle do servidor (ou tsup)
apps/api/src/env.ts           # validação das variáveis com zod (falha no boot)
apps/api/src/health.ts        # /healthz e /readyz
apps/api/src/shutdown.ts      # SIGTERM: drenar WebSockets, salvar documentos, fechar a fila e o pool

packages/db/drizzle.config.ts
packages/db/src/migrate.ts    # migrador programático (roda no preDeploy)
packages/db/migrations/       # SQL gerado pelo drizzle-kit, versionado no git
```

#### `pnpm-workspace.yaml` e `turbo.json`

```yaml
packages: ["apps/*", "packages/*"]
```

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"] },
    "dev":       { "cache": false, "persistent": true },
    "e2e":       { "dependsOn": ["build"], "cache": false }
  }
}
```

#### `apps/api/Dockerfile` (esboço)

`turbo prune --docker` copia só o que o pacote usa, o que mantém o cache de camadas: `pnpm install` só roda de novo quando o lockfile muda.

```dockerfile
FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune @erd/api --docker

FROM base AS builder
# isolated-vm é módulo nativo: precisa de toolchain no build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@erd/api...
RUN pnpm --filter @erd/api deploy --prod /app

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app .
USER node
EXPOSE 8080
# --no-node-snapshot é exigido pelo isolated-vm no Node ≥ 20
CMD ["node", "--no-node-snapshot", "--enable-source-maps", "dist/main.js"]
```

- **Bundle do servidor:** o `tsdown` (ou `tsup`) faz o bundle com `noExternal: [/^@erd\//]`, então os pacotes internos não precisam de build separado em runtime. `isolated-vm`, `libpg-query` (que carrega o `.wasm` da própria pasta) e `pg` ficam como *external* e chegam via `pnpm deploy --prod`.
- A imagem é `bookworm-slim`, e não `alpine`, porque o `isolated-vm` e o `libpg-query` não se dão bem com musl. ⚠ Conferir na fase 3 a compatibilidade do `isolated-vm` com o Node 24.

#### `apps/web/Dockerfile` + `Caddyfile`

```dockerfile
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2 prune @erd/web --docker && cp -r out/json/. /build && cp -r out/full/. /build
WORKDIR /build
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@erd/web

FROM caddy:2
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /build/apps/web/dist /srv
```

```caddyfile
{
	admin off
	auto_https off                       # o TLS termina na borda do Railway
	servers {
		trusted_proxies static private_ranges   # preserva o X-Forwarded-For da borda
	}
}

:{$PORT} {
	encode zstd gzip
	respond /healthz 200

	handle /api/* {
		reverse_proxy {$SERVER_INTERNAL_URL}
	}
	handle /collab* {
		reverse_proxy {$SERVER_INTERNAL_URL}   # upgrade de WebSocket é automático
	}

	handle {
		root * /srv
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		header /index.html Cache-Control "no-cache"
		# o worker do Drizzle executa código do usuário com `new Function` → precisa de unsafe-eval só nele
		header /assets/drizzle.worker-* Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval'"
		try_files {path} /index.html
		file_server
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		# 'wasm-unsafe-eval' é necessário para o libpg-query (WASM) no parser worker
		Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
		-Server
	}
}
```

- `.wasm` precisa sair com `Content-Type: application/wasm`. O Caddy já faz isso, mas vale um teste no e2e de "prod local".
- Ajustar o `img-src` e o `connect-src` se houver avatares do GitHub/Google (`avatars.githubusercontent.com`, `lh3.googleusercontent.com`).

#### `railway.json` de cada serviço

O Railway lê *config as code* de um `railway.json`/`railway.toml`, e os valores do arquivo têm prioridade sobre o painel. Num monorepo, cada serviço aponta para o seu arquivo em **Settings → Config-as-code / Config file path** ⚠ (caminho absoluto a partir da raiz do repo). O schema `https://railway.com/railway.schema.json` dá autocomplete no editor.

`apps/api/railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "apps/api/Dockerfile",
    "watchPatterns": ["apps/api/**", "apps/collab/**", "packages/**", "pnpm-lock.yaml"]
  },
  "deploy": {
    "preDeployCommand": ["node dist/migrate.js"],
    "healthcheckPath": "/readyz",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

`apps/web/railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "apps/web/Dockerfile",
    "watchPatterns": ["apps/web/**", "packages/**", "pnpm-lock.yaml"]
  },
  "deploy": { "healthcheckPath": "/healthz", "restartPolicyType": "ON_FAILURE" }
}
```

- **Root Directory** dos dois serviços = raiz do repo (`/`). O `turbo prune` precisa do workspace inteiro, e o `dockerfilePath` é relativo à raiz.
- Os **watchPatterns** evitam rebuild do `web` quando só a API muda, e vice-versa.
- Por que Dockerfile e não o builder automático (Railpack): o Railpack detecta Node e Vite sozinho, mas o monorepo pnpm com `turbo prune`, o módulo nativo do `isolated-vm` e o Caddy com CSP pedem controle total. O Dockerfile também é o que o `docker compose --profile prod` usa localmente, então o que roda em produção é exatamente o que foi testado.
- O Railway também tem uma DSL TypeScript de infraestrutura (`.railway/railway.ts`) ⚠. Não misturar: escolher **um** dos dois por serviço. A recomendação é ficar com `railway.json`, que é mais simples.

#### `packages/db/drizzle.config.ts` e `migrate.ts`

```ts
// drizzle.config.ts — usado só em dev/CI (drizzle-kit generate | studio)
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',          // inclui as tabelas geradas pelo Better Auth
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
});
```

```ts
// src/migrate.ts — roda no preDeployCommand, sem drizzle-kit na imagem de produção
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const db = drizzle(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await db.$client.end();
```

Regras de migração:
- **Gerar** com `pnpm db:generate` e versionar o SQL. **Nunca** usar `drizzle-kit push` em staging ou produção.
- O `preDeployCommand` roda na imagem nova, com acesso à rede privada, **antes** do novo container receber tráfego. Se a migração falhar, o deploy é abortado e a versão antiga continua no ar.
- Durante o *overlap* (§15.5), a versão antiga e a nova rodam ao mesmo tempo contra o mesmo banco. Por isso as migrações seguem **expand/contract**: primeiro adiciona coluna nullable ou tabela nova; num deploy seguinte, remove o que ficou velho. Nada de `DROP`/`RENAME` no mesmo deploy que muda o código que usa a coluna.

#### `apps/api/src/env.ts`

```ts
import { z } from 'zod';
export const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().default(8080),
  APP_URL: z.string().url(),                   // URL pública (a do serviço web)
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  COLLAB_JWT_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),       // obrigatório se MAIL_DRIVER=resend
  MAIL_DRIVER: z.enum(['resend', 'smtp', 'console']).default('console'),
  SMTP_URL: z.string().optional(),             // mailpit em dev
  EMAIL_FROM: z.string(),
  GITHUB_CLIENT_ID: z.string().optional(), GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(), GOOGLE_CLIENT_SECRET: z.string().optional(),
  REDIS_URL: z.string().url().optional(),      // fase 7
}).parse(process.env);
```

Com variável faltando, o boot falha com uma mensagem clara e o healthcheck não passa. Assim o deploy quebrado nunca recebe tráfego. Um `superRefine` exige `RESEND_API_KEY` quando `NODE_ENV=production`.

#### Saúde e desligamento (`health.ts`, `shutdown.ts`)

- **`/healthz`:** o processo está de pé.
- **`/readyz`:** `select 1` no Postgres e a última migração aplicada confere com a esperada. É o `healthcheckPath` do deploy: o Railway só troca o tráfego quando ele responde 200. O healthcheck **só é usado no deploy**, e não como monitoramento contínuo ⚠.
- **Escutar em `::`:** `serve({ fetch: app.fetch, port: env.PORT, hostname: '::' })`. A rede privada do Railway é IPv6 em ambientes antigos, e IPv4 + IPv6 nos criados depois de out/2025 ⚠. Escutar em `::` cobre os dois casos.
- **`SIGTERM`:** o Railway manda `SIGTERM` para o container antigo e `SIGKILL` depois da janela de *draining*, que **por padrão é 0 s** ⚠. O handler de shutdown:
  1. para de aceitar conexões novas;
  2. chama `hocuspocus` para **gravar todos os documentos pendentes** (o `onStoreDocument` tem debounce de até 10 s, e perder isso seria perder edições);
  3. fecha os WebSockets com um código de "reconecte". Os clientes Yjs reconectam no container novo e reenviam o que faltar, então nada se perde;
  4. `boss.stop({ graceful: true })`, `pool.end()`, `process.exit(0)` (o código de saída 0 importa para o Railway não acusar *crash*).

### 15.3 Arquivos existentes editados

| Arquivo | Mudança |
|---|---|
| `package.json` (raiz) | Vira raiz do workspace: `"private": true`, `"packageManager": "pnpm@10.x"` (o Corepack e o Railway leem esse campo), `"engines": { "node": ">=24 <25" }`, scripts do §15.4. As dependências do app vão para `apps/web/package.json`. |
| `package-lock.json` | **Removido**: o lockfile passa a ser o `pnpm-lock.yaml`. |
| `vite.config.ts` → `apps/web/vite.config.ts` | Alias do `lilconfig` com o caminho novo; `server.proxy` em dev para `/api` (→ `http://localhost:8080`) e `/collab` (`ws: true`), para o dev ter **a mesma origem** que a produção; o mesmo proxy em `preview`; `build: { target: 'es2022', sourcemap: 'hidden', outDir: 'dist' }`; o bloco `test` sai para o `vitest.config.ts` de cada pacote (ou `test.projects` na raiz). `worker.format: 'es'` e `optimizeDeps.include: ['libpg-query']` continuam. |
| `tsconfig.json` | Vira `packages/config/tsconfig.base.json` (as mesmas flags estritas de hoje). Cada app ou pacote estende o base, e a raiz usa *project references*. O `lib` `WebWorker`/`DOM` fica só no `apps/web`. |
| `.gitignore` | Acrescenta `.turbo/`, `**/dist/`, `.env`, `.env.*` (exceto `.env.example`), `playwright-report/`, `test-results/`. |
| `e2e/*.mjs` | Migram para `@playwright/test` com `baseURL` configurável. O mesmo conjunto roda contra `pnpm dev` e contra `pnpm prod:local`. |
| `src/workers/parser.worker.ts` | Sem mudança de lógica: o `?url` do `.wasm` continua funcionando no build. Entra um teste e2e que confirma o carregamento do WASM servido pelo Caddy. |
| `README.md` | Seções "Rodando local (com backend)", "Variáveis de ambiente" e "Deploy no Railway" (resumo do §15.7). |

Quando a fase 2 criar o `packages/db`, o `drizzle.config.ts` nasce já no formato do §15.2. Não existe um arquivo hoje para editar.

### 15.4 Comandos e variáveis

**Scripts da raiz (`package.json`):**

```jsonc
{
  "scripts": {
    "infra:up":    "docker compose up -d postgres mailpit",
    "infra:down":  "docker compose down",
    "dev":         "turbo run dev",                       // web (vite :5173) + api (tsx watch :8080)
    "build":       "turbo run build",
    "typecheck":   "turbo run typecheck",
    "lint":        "turbo run lint",
    "test":        "turbo run test",
    "e2e":         "turbo run e2e",
    "db:generate": "pnpm --filter @erd/db exec drizzle-kit generate",
    "db:migrate":  "pnpm --filter @erd/db migrate",
    "db:studio":   "pnpm --filter @erd/db exec drizzle-kit studio",
    "env:check":   "pnpm --filter @erd/api env:check",    // valida o .env com o mesmo zod do boot
    "docker:build":"docker build -f apps/api/Dockerfile -t erd-server . && docker build -f apps/web/Dockerfile -t erd-web .",
    "prod:local":  "docker compose --profile prod up --build",   // as imagens reais + postgres + mailpit
    "verify":      "pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docker:build"
  }
}
```

- **Rodar local:** `pnpm i && pnpm infra:up && pnpm db:migrate && pnpm dev`.
- **Antes de abrir PR:** `pnpm verify`.
- **Para reproduzir um problema de produção:** `pnpm prod:local`.

**Variáveis por serviço no Railway** (colar no *Raw Editor* de cada serviço). Para gerar os segredos: `openssl rand -base64 32`.

`server`:

```env
NODE_ENV=production
PORT=8080
APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}          # trocar pelo domínio próprio quando houver
BETTER_AUTH_URL=${{APP_URL}}
DATABASE_URL=${{Postgres.DATABASE_URL}}
BETTER_AUTH_SECRET=<gerado>
COLLAB_JWT_SECRET=<gerado>
MAIL_DRIVER=resend
RESEND_API_KEY=<do painel do Resend>
EMAIL_FROM="EasiER <notificacoes@mail.seudominio.com>"
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
```

`web`:

```env
SERVER_INTERNAL_URL=http://${{server.RAILWAY_PRIVATE_DOMAIN}}:${{server.PORT}}
```

- `${{Servico.VAR}}` são *reference variables*: o Railway resolve o valor e ainda ordena o deploy, então o `server` espera o Postgres subir.
- O `PORT` do `server` é fixado em 8080 porque o `web` precisa saber para onde fazer o proxy. O Railway respeita um `PORT` definido como variável.
- O `web` não precisa de nenhuma variável `VITE_*`: o SPA chama `/api` e monta a URL do WebSocket a partir de `location` (`wss://<host>/collab`). Assim **a mesma imagem serve staging e produção**.

### 15.5 Deploys sem downtime (com WebSocket)

- **Overlap** (`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, opcional): por quanto tempo o container antigo continua vivo depois que o novo fica ativo. **Draining** (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`): quanto tempo o container antigo tem entre o `SIGTERM` e o `SIGKILL`. ⚠ Conferir os nomes e os defaults atuais na documentação.
- O tráfego novo vai para o container novo assim que ele passa no healthcheck. Os WebSockets antigos são fechados pelo handler de `SIGTERM` (§15.2), e os clientes reconectam.
- **Uma réplica do `server` até a fase 7.** Com duas réplicas sem Redis, dois usuários do mesmo documento poderiam cair em instâncias diferentes e não se ver. Antes de subir `numReplicas`, ligar a extensão Redis do Hocuspocus (§6.2).
- **Sem volume** no `server`: todo o estado está no Postgres, e o container é descartável.

### 15.6 Ambientes, CI, backups e custos

- **`staging`:** criado duplicando o `production` (*Environments → New → Duplicate*), com banco próprio. Deploya da branch `develop` (ou de `main`), e o `production` deploya de tags ou de `main` com aprovação. A escolha fica para a etapa.
- **PR environments:** opcionais, em *Project Settings → Environments*. Cada PR ganha um ambiente temporário, apagado ao fazer merge ou fechar o PR. Usar reference variables ao Postgres para o deploy esperar o banco ⚠.
- **CI:** o GitHub Actions roda `pnpm verify` e o e2e contra `pnpm prod:local`. No Railway, ligar **"Wait for CI"** no serviço, para que o deploy só aconteça depois dos checks verdes ⚠.
- **Backups do Postgres:** agendar *volume backups* (diário e semanal) na aba Backups do serviço Postgres. Avaliar *point-in-time recovery* quando houver usuários reais ⚠. Fazer, além disso, um `pg_dump` lógico semanal num job do GitHub Actions (usando a `DATABASE_PUBLIC_URL`), guardado fora do Railway, como cópia independente do provedor.
- **Custos:** configurar *usage limits* e alertas de gasto no workspace. O plano Hobby cobra assinatura mais uso. ⚠ Conferir os preços atuais.
- **Logs:** em JSON (`pino`), para filtrar por `level`, `canvasId` e `userId` na aba de logs do Railway. Os alertas de crash/restart do Railway vão para o e-mail.

### 15.7 Passo a passo: subir no Railway

**Pré-requisitos (uma vez):**

1. Conta no Railway ligada ao GitHub, com o app do Railway autorizado no repositório `erd-to-schema`.
2. CLI: `npm i -g @railway/cli` e depois `railway login`.
3. (Recomendado) Um domínio próprio. Sem ele, dá para começar com o `*.up.railway.app` do serviço `web`.
4. Conta no Resend, com o subdomínio de envio (por exemplo, `mail.seudominio.com`) adicionado e os registros **SPF, DKIM e DMARC** criados no DNS. A chave de API sai de *API Keys*.
5. OAuth apps:
   - **GitHub:** *Settings → Developer settings → OAuth Apps*, com callback `https://<domínio>/api/auth/callback/github`.
   - **Google:** *Cloud Console → Credentials → OAuth client ID (Web)*, com redirect `https://<domínio>/api/auth/callback/google`.
   - Criar um par de credenciais para staging e outro para produção.

**Criar o projeto:**

6. No painel: **New Project → Empty Project**. Dar o nome `erd-builder`.
7. **+ New → Database → PostgreSQL.** Renomear o serviço para `Postgres`; o nome é usado nas referências `${{Postgres.…}}`.
8. **+ New → GitHub Repo → erd-to-schema.** Renomear para `server`. Em *Settings*:
   - **Root Directory:** `/`;
   - **Config file path:** `/apps/api/railway.json`;
   - **Branch:** `main` (ou a de produção);
   - ligar **Wait for CI**;
   - **não** gerar domínio público.
9. Em **server → Variables → Raw Editor**, colar o bloco `server` do §15.4 com os segredos preenchidos.
10. **+ New → GitHub Repo → erd-to-schema** de novo. Renomear para `web`. Em *Settings*:
    - **Root Directory:** `/`;
    - **Config file path:** `/apps/web/railway.json`;
    - em **Networking → Generate Domain** (ou **Custom Domain**, criando no DNS o CNAME que o Railway mostrar);
    - em *Variables*, colar o bloco `web` do §15.4.
11. Se usar domínio próprio, voltar ao `server` e ajustar `APP_URL=https://app.seudominio.com`. Ajustar também as callbacks do OAuth para esse domínio.
12. Clicar em **Deploy** (ou fazer `git push`). Acompanhar a aba *Deployments*. A ordem esperada:
    1. `Postgres` sobe;
    2. `server` faz o build, roda o `preDeployCommand` (migrações) e passa no `/readyz`;
    3. `web` faz o build e passa no `/healthz`.

**Verificar:**

13. Abrir o domínio do `web`, criar uma conta e confirmar que o e-mail de verificação chegou (o painel do Resend mostra a entrega).
14. Abrir o mesmo projeto em duas janelas anônimas com usuários diferentes e conferir a edição ao vivo no canvas e nos painéis.
15. Pela CLI:
    - `railway link` (escolher projeto e ambiente);
    - `railway logs --service server`;
    - `railway ssh --service server` para inspecionar o container, se precisar ⚠.

**Depois:**

16. **Backups:** *Postgres → Backups → schedule*.
17. **Staging:** *Environments → New Environment → Duplicate production*. Ajustar a branch, os segredos próprios (OAuth de staging, chave do Resend e `APP_URL`) e um domínio `staging.seudominio.com`.
18. **Limites de gasto:** *Workspace → Usage → limits/alerts*.
19. **Rollback:** em *Deployments*, escolher o deploy anterior e clicar em **Redeploy/Rollback**. Se o problema foi uma migração, preferir uma migração corretiva para frente; o rollback do código só é seguro se a migração foi *expand* (§15.2).
20. **Rotina de deploy daqui em diante:** PR → CI verde → merge → o Railway faz o deploy sozinho. Mudanças de schema exigem `pnpm db:generate` com a migração commitada no mesmo PR.

### 15.8 Checklist de conformidade por fase

| Fase | O que precisa estar pronto para o deploy |
|---|---|
| 0 | `pnpm-lock.yaml`, `packageManager`, `.node-version`, `turbo.json`; `apps/web/Dockerfile` + `Caddyfile` já servindo o app local (sem backend) num serviço `web` de staging. Assim o pipeline de deploy existe desde o primeiro dia. |
| 2 / **2B** | Tudo do §15.2 a §15.4: `server` + `Postgres` no Railway, migrações no pre-deploy, `env.ts`, `/readyz`, Resend em staging, OAuth de staging, CI com Wait for CI. |
| 3 | Proxy de `/collab` no Caddy; *draining* de 30 s e shutdown que salva os documentos; o `isolated-vm` compilando na imagem (toolchain no build, `--no-node-snapshot`); teste de redeploy no meio de uma edição, sem perder nada. |
| 4 | DNS do Resend em produção (SPF/DKIM/DMARC); limites de convite; pg-boss migrado. |
| 6 | Backups agendados + `pg_dump` externo; ambiente de produção separado do staging; alertas de gasto; logs JSON; teste de carga no staging. |
| 7 | Serviço `Redis`; extensão Redis do Hocuspocus; `numReplicas` > 1 no `server`; opcionalmente, separar o `collab` como serviço próprio (o `/collab` do Caddy aponta para ele). |
