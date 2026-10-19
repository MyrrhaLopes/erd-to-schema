# ERD Builder → plataforma colaborativa: plano de arquitetura

> Plano para transformar o mini-app local (Vite + React, estado em zustand, autosave em IndexedDB) numa aplicação fullstack em monorepo, com contas de usuário, múltiplos projetos, compartilhamento com permissões e edição colaborativa em tempo real no canvas. Escrito a partir do código atual (`src/store`, `src/sync`, `src/model`) e pensado para ser executado em fases, cada uma entregável e testável.

## Pedido (resumo)

1. **Fullstack em monorepo**, com múltiplos usuários e múltiplos projetos.
2. Um **projeto** contém o diagrama ER e, no futuro, um **segundo canvas de fluxos de usuário** (só planejar agora).
3. **Compartilhamento** com outros usuários, com permissão de **edição** ou **somente visualização**. Quem só visualiza pode **pedir acesso de edição**.
4. **Colaboração em tempo real** no canvas, estilo Google Docs: as edições de cada pessoa ficam visíveis, com **uma cor de destaque por usuário** nos blocos que ela está mexendo e nas mudanças que fez.

## Decisões principais (TL;DR)

| Tema | Escolha | Por quê |
|---|---|---|
| Monorepo | **pnpm workspaces + Turborepo** | Cache de build/test por pacote; pnpm resolve bem os pacotes internos `workspace:*`. |
| Modelo de colaboração | **CRDT com Yjs** | Merge automático sem servidor de transformação (OT); funciona offline e reconecta sozinho; ecossistema maduro (awareness, undo, bindings de CodeMirror). |
| Servidor de tempo real | **Hocuspocus** (servidor Yjs) | Já traz autenticação por documento, conexões *read-only*, persistência plugável, extensão Redis para escalar horizontalmente. |
| API | **Hono** (Node) + **zod** | Leve, tipada ponta a ponta com o cliente RPC do próprio Hono, sem codegen. |
| Banco | **Postgres + Drizzle ORM** | O app já gera Drizzle; usar o mesmo ORM no backend faz *dogfooding* e permite validar o próprio gerador. |
| Auth | **Better Auth** (adaptador Drizzle) | Self-hosted, e-mail/senha + OAuth (GitHub/Google), sessões em cookie, sem dependência de SaaS. |
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
    Panels[Painéis SQL/Prisma/Drizzle] -->|parse + reconcile + diff| Bind
    Workers[[Workers: libpg-query, prisma-ast, drizzle sandbox]] --- Panels
  end
  YD <-->|WebSocket: updates + awareness| HP[apps/collab Hocuspocus]
  UI -->|HTTPS REST| API[apps/api Hono]
  API --> PG[(Postgres)]
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
│  └─ collab/         # Hocuspocus: WebSocket Yjs, auth por documento, persistência
├─ packages/
│  ├─ model/          # hoje em src/model + src/formats: tipos canônicos, reconcile, geradores e parsers SQL/Prisma
│  ├─ crdt/           # schema do Y.Doc, Project ⇄ Y.Doc, diff→ops, projeção, validação defensiva
│  ├─ canvas-kinds/   # contrato comum de "tipo de canvas" (erd, flow) — ver §8
│  ├─ db/             # schema Drizzle do backend, migrações (drizzle-kit), cliente
│  ├─ contracts/      # schemas zod compartilhados entre api e web (DTOs, papéis, eventos)
│  └─ config/         # tsconfig base, eslint, prettier, vitest preset
├─ e2e/               # Playwright: cenários multi-usuário (dois contextos de browser)
├─ docker-compose.yml # postgres (+ redis opcional) para dev
├─ turbo.json
└─ pnpm-workspace.yaml
```

Fronteiras importantes:

- **`packages/model` é isomórfico** (roda no browser e no Node). O backend usa para gerar `schema.sql`/`schema.prisma` em exports e snapshots. O parser SQL (`libpg-query`) tem build WASM que roda nos dois lados.
- **O parse de Drizzle continua só no browser.** Ele *executa* o código do usuário (sucrase + `drizzle-orm` num worker com timeout). Executar código de usuário no servidor é uma superfície de ataque que não vale o ganho; o servidor nunca roda Drizzle de entrada.
- **`packages/crdt` não depende de React** — dá para testar convergência em Node com fast-check (já usado em `tests/roundtrip.property.test.ts`).
- Os workers (`parser.worker.ts`, `drizzle.worker.ts`) ficam em `apps/web`, importando os parsers de `@erd/model`.

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

O ponto de entrada de toda escrita hoje é `useProjectStore.getState().commit(recipe, origin, changes)`, usado por `actions.ts`, pelo Inspector, pelo `apply()` do sync engine e pelo `loadProject`. O plano é **manter essa assinatura** e trocar a implementação:

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

**Origem das mudanças:** `lastOrigin` (usado pelo sync engine para não regenerar o painel que originou a edição) passa a sair de `transaction.origin`. Updates remotos chegam com a origem do provider e são tratados como `'remote'`.

### 4.4 Undo/redo

- `Y.UndoManager` sobre todos os tipos de primeiro nível, com `trackedOrigins = new Set([LOCAL_ORIGIN])`. Ctrl+Z desfaz só as suas mudanças, nunca as do colega.
- `batch()` (hoje usado pela borracha) vira `undoManager.stopCapturing()` antes e depois do bloco. Os `captureTimeout` agrupam digitação.
- Os metadados de seleção (`stack-item-added`/`popped`) restauram a seleção e o viewport junto com o undo.
- O `zundo` e o `temporal` saem do store.
- **Comportamento novo para documentar:** desfazer pode não restaurar o estado exato se alguém editou o mesmo campo depois. É a semântica do Google Docs e o comportamento esperado.

### 4.5 Arrastar nós sem inundar a rede

Mover uma tabela gera dezenas de eventos por segundo. Gravar cada um no Y.Doc infla o histórico e o log do servidor. Então:

- **Durante o arrasto:** a posição vai pela **awareness** (efêmera, ~30 Hz, com throttle). Os outros veem o nó se mover suave, na cor de quem arrasta.
- **No `onNodeDragStop`** (que já existe em `Canvas.tsx`): um único `commit` grava a posição final. Uma entrada de undo, um update persistido.
- Para redimensionar nota ou tabela, a mesma regra.

### 4.6 Painéis de código (SQL / Prisma / Drizzle) em modo colaborativo

Hoje o sync engine marca `conflict: true` quando o modelo muda enquanto um painel tem edição pendente, e mostra um banner. Com várias pessoas editando, isso dispararia o tempo todo. A proposta é um **merge de três vias** no nível do modelo:

1. Quando o usuário começa a digitar num painel, o painel guarda `base` (o `Project` projetado naquele momento), além do `baseRev` que já existe.
2. No parse (debounce de 400 ms ou Ctrl+S): `reconciled = reconcile(base, parsed, format)`, como hoje, mas **contra a base e não contra o modelo atual**.
3. `applyDiff(ydoc, base, reconciled)`: o diff entre a base e o que o usuário escreveu é aplicado **sobre o Y.Doc atual**. Como as operações são por campo e por ID, as edições do usuário se misturam com as remotas, e só o mesmo campo editado dos dois lados entra em *last-writer-wins*.
4. Depois de aplicar, o painel é regenerado a partir do modelo mesclado. Para não "pular o texto" debaixo do cursor, o painel só é regenerado se o usuário não digitou nada desde o parse (a regra atual do `seq`). Se a regeneração muda trechos que o usuário não editou, ela vira uma transação do CodeMirror que mapeia a posição do cursor.
5. O banner de conflito só aparece num caso real: a base referencia uma entidade que alguém apagou nesse meio tempo (por exemplo, o usuário editou colunas de uma tabela que outra pessoa excluiu). As opções continuam "aplicar a minha versão" (recria a tabela) ou "recarregar do modelo".

O **texto do painel não é compartilhado** (não é um `Y.Text`). Ele é uma vista derivada, e o merge acontece no modelo. Se duas pessoas digitarem SQL ao mesmo tempo, cada uma tem seu rascunho, e os dois convergem pelo modelo. Isso evita o problema de dois rascunhos de texto se mesclarem em SQL inválido. A presença aparece nos painéis mesmo assim (§5.4).

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
| Header | Pilha de avatares de quem está online. Clicar num avatar **segue** a pessoa (viewport sincronizado) ou só centraliza nela. |
| Minimap | Pontinhos na cor de cada usuário na posição do viewport dele. |

Os componentes de presença ficam numa camada própria (`apps/web/src/collab/presence/`), sem misturar com `TableNode`/`NoteNode`. Os nós recebem só uma prop derivada `presence: { color, label }[]` vinda de um seletor.

### 5.4 Presença nos painéis de código

Os geradores (`generateSql` etc.) passam a emitir também um **source map** simples: `entityId → intervalo de linhas`. Com ele:

- Uma faixa na **gutter** com a cor de quem está selecionando ou editando aquela tabela no canvas.
- Se alguém está editando o painel SQL na tabela X, os outros veem a marca na mesma tabela nos painéis deles, inclusive em Prisma ou Drizzle.

Esse source map também ajuda fora da colaboração: clicar numa tabela no canvas pode rolar o painel até ela.

### 5.5 Autoria das edições ("quem mudou o quê")

Duas camadas:

1. **Rastro recente (efêmero):** quando chega um update remoto, as entidades tocadas (`transaction.changed`, mapeadas pelo `clients` → usuário) ganham por ~8 s um **realce na cor do autor**, que vai desbotando. Uma coluna nova "acende" na cor de quem criou. É o equivalente ao destaque das edições alheias no Google Docs.
2. **Autoria persistente:** cada entidade guarda `_by` (userId) e `_at` (timestamp), gravados na mesma transação da edição. Um botão **"Mostrar autoria"** pinta a borda de cada tabela, coluna e nota com a cor de quem a editou por último, e mostra um tooltip "editado por Fulana há 3 min". Dentro das notas, a autoria por trecho de texto usa `Y.PermanentUserData` junto com snapshots do Yjs.

Mais tarde, com `canvas_versions` (§6.3), dá para ter um modo **"o que mudou desde a versão X"**: tabelas e colunas adicionadas, removidas ou alteradas, coloridas por autor. Esse modo reusa a lógica de mudanças do `reconcile` que hoje alimenta o toast.

---

## 6. Servidor de colaboração (`apps/collab`)

### 6.1 Ciclo de vida

- **`onAuthenticate`:** valida o JWT (§3) e define `readOnly`.
- **`onLoadDocument`:** lê `canvas_state.state` e aplica, por cima, os `canvas_updates` posteriores à última compactação.
- **`onStoreDocument`** (com debounce de ~2 s e `maxDebounce` de ~10 s): faz append do update incremental em `canvas_updates`. A cada N updates ou T minutos, **compacta**: grava o `Y.encodeStateAsUpdate` em `canvas_state`, apaga os updates antigos, recalcula o `json_snapshot` (projeção via `@erd/crdt`) e atualiza `projects.updated_at`.
- **`onChange`:** valida o tamanho do update (por exemplo, rejeita acima de 1 MB) e aplica limite de taxa por conexão.
- **Garbage collection** do Yjs ligada (`gc: true`). As versões nomeadas guardam snapshots completos, então o histórico fino não é necessário.

### 6.2 Escala

- Começo: **uma instância** com API e collab no mesmo processo Node (o Hocuspocus se acopla no servidor HTTP do Hono). É o deploy mais simples.
- Quando precisar: separar os processos e ligar a **extensão Redis** do Hocuspocus, que propaga updates e awareness entre instâncias. Os eventos de permissão passam para o Redis pub/sub.

### 6.3 Versões

- **Snapshot automático diário** e um **"Salvar versão"** manual com nome → `canvas_versions`.
- **Restaurar versão** = calcular o diff entre o estado atual e a versão e aplicá-lo como uma transação normal (via `applyDiff`). Assim a restauração propaga para todos ao vivo e pode ser desfeita, em vez de trocar o documento por baixo dos clientes.

---

## 7. API (`apps/api`)

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
- E-mail transacional (convites, pedidos de acesso) atrás de uma interface `Mailer`, com um provedor como Resend em produção e log no console em dev.
- Testes de integração com Postgres real (Testcontainers ou o Postgres do `docker-compose`), cobrindo **cada regra da tabela de permissões**.

**Import de projeto:** o parse continua no cliente, porque Drizzle exige executar código e o WASM do Postgres já está carregado lá. O cliente monta o `Project`, converte para um update Yjs (`@erd/crdt/fromProject`) e manda para o canvas novo. O servidor valida a projeção do resultado com zod antes de aceitar.

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
- `bootstrap.ts` vira `openCanvas(canvasId)`: cria o `Y.Doc`, liga o `y-indexeddb` (cache local e offline), conecta o `HocuspocusProvider`, cria a projeção, o `UndoManager` e o sync engine. `closeCanvas()` desfaz tudo ao trocar de rota. Os stores deixam de ser singletons globais e passam a ser criados por canvas (`createProjectStore(ydoc)` + React context), para evitar vazamento entre projetos.
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

- O **modo local** (`/local`) continua existindo sem conta. Ele usa o mesmo Y.Doc com `y-indexeddb` e sem provider, o que testa o binding CRDT sem servidor e mantém o app usável offline e para quem só quer experimentar.
- **"Enviar para a nuvem":** num projeto local, depois do login, cria o projeto no servidor e envia o estado do Y.Doc.
- **Conversão do IndexedDB antigo** (chave `current` com o `Project` em JSON) para o Y.Doc local via `@erd/crdt/fromProject`, na primeira abertura.
- O `.zip` continua igual (`project.json`, `notes/*.md`, os três schemas), então import e export entre local e nuvem funcionam nos dois sentidos.

---

## 11. Testes

| Nível | O que cobrir |
|---|---|
| `@erd/model` | Os testes atuais (`sql`, `prisma`, `drizzle`, `roundtrip.property`...) migram sem mudança. |
| `@erd/crdt` (propriedade, fast-check) | **Convergência:** N réplicas aplicam sequências aleatórias de ações de `actions.ts` em ordens diferentes e terminam com a mesma projeção. **Validade:** toda projeção passa no zod e gera SQL que o `libpg-query` aceita. **Ida e volta:** `project(fromProject(p)) ≡ p`. **Diff mínimo:** `applyDiff(a, a)` não gera nenhuma operação. |
| Merge de painel | Dois rascunhos de SQL editando tabelas diferentes da mesma base convergem sem banner; editando a mesma coluna, *last-writer-wins*; editando uma tabela que outro apagou, banner. |
| API | Integração com Postgres real: matriz de permissões completa, convites, pedidos de acesso (incluindo os pendentes duplicados), mudança de papel. |
| Collab | Uma conexão read-only não altera o documento; um token de outro canvas é recusado; a mudança de papel reconecta; a compactação preserva o estado. |
| E2E (Playwright) | Dois `browserContext`s logados como usuários diferentes: criar uma tabela em A e vê-la em B em menos de 1 s; cursor e anel de seleção na cor certa; o viewer não edita e pede acesso; o owner aprova e o viewer vira editor sem recarregar; offline em A → editar → reconectar → B recebe. Os roteiros atuais (`e2e/*.mjs`) migram para `@playwright/test`. |

A CI (GitHub Actions) roda, via Turborepo e com cache por pacote: lint, typecheck, testes unitários e de propriedade, integração com o serviço Postgres e e2e.

---

## 12. Fases de entrega

Cada fase termina com o app funcionando e os testes verdes. A ordem ataca primeiro o maior risco técnico (o binding CRDT), antes de existir backend.

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0. Monorepo** | pnpm + Turborepo; `src/` vira `apps/web`; `src/model` + `src/formats` viram `packages/model`; `packages/config`; CI. **Nenhuma mudança de comportamento.** | `pnpm build`, `test` e `e2e` passam como hoje. |
| **1. Y.Doc local** | `packages/crdt` (schema, `fromProject`, projeção, `applyDiff`); `commit()` reimplementado por cima do Y.Doc; `Y.UndoManager` no lugar do zundo; `y-indexeddb` no lugar do autosave; `view` separado do documento. Ainda sem servidor. | Testes de propriedade de convergência e de ida e volta; todos os e2e atuais passam; undo e redo com o mesmo comportamento percebido. |
| **2. Backend + contas** | `packages/db`, `apps/api` com Better Auth, CRUD de projetos e canvases, dashboard e rotas na web, import do `.zip` e do projeto local. Persistência por enquanto via upload do estado Yjs pela API (sem tempo real). | Criar conta, criar e abrir projetos, recarregar e ver o estado salvo. |
| **3. Tempo real** | `apps/collab` (Hocuspocus, persistência com log e compactação, token JWT); `HocuspocusProvider` na web; indicador de conexão; arraste via awareness; merge de três vias nos painéis. | E2E com dois usuários editando o mesmo canvas, incluindo offline e reconexão. |
| **4. Compartilhamento** | Membros, convites por e-mail, papéis, modo visualização, pedidos de acesso, notificações, mudança de papel ao vivo, link de visualização. | Matriz de permissões coberta por testes de API e e2e. |
| **5. Presença e autoria** | Cores por membro, cursores, anéis de seleção, soft lock, avatares e "seguir", notas com cursores remotos, rastro recente, modo "Mostrar autoria", presença nos painéis via source map. | E2E verificando cor e rótulo; teste manual com 3 a 4 pessoas. |
| **6. Produção** | Versões nomeadas e restauração, thumbnails, limites e taxas, observabilidade (logs estruturados, métricas de conexões e tamanho de documentos), deploy, backups. | Deploy de staging; teste de carga com cerca de 20 clientes num documento de 200 tabelas. |
| **7. Escala** (sob demanda) | Separar API e collab; extensão Redis; múltiplas instâncias. | — |
| **8. Fluxos de usuário** | `CanvasKind` "flow" (§9). | — |

O **contrato `CanvasKind`** (§8.3) entra na fase 1 ou 3, quando o editor deixa de ser singleton. Assim a fase 8 só adiciona um tipo novo, sem refatorar o editor.

### Deploy sugerido

- **Web:** estático (Cloudflare Pages, Vercel ou Netlify). Atenção aos headers do WASM do `libpg-query` e ao `Content-Type` correto.
- **API + collab:** um container Node com suporte a WebSocket de longa duração (Fly.io, Railway ou Render; *não* serverless, porque o Hocuspocus precisa de conexões persistentes).
- **Postgres** gerenciado (Neon, Supabase ou RDS) com backup diário; Redis só a partir da fase 7.
- Domínio único com proxy (`app.dominio` → web, `/api` e `/collab` → Node) para o cookie de sessão funcionar sem dor de CORS.

---

## 13. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Merges que quebram invariantes do schema (FK órfã, nomes duplicados) | Projeção tolerante + diagnósticos nos painéis; correções só como intenção local (§4.2); testes de propriedade com réplicas concorrentes. |
| `applyDiff` lento em diagramas grandes | Pular sub-árvores por referência (`===`) do immer; *benchmark* com 500 tabelas na fase 1. |
| Painel de código "brigando" com edições remotas | Merge de três vias contra a `base` (§4.6); regenerar só quando o painel está ocioso. |
| Crescimento do log de updates | Compactação periódica + GC do Yjs; arraste via awareness. |
| Editor malicioso corrompendo o documento | Validação zod na projeção; limites de tamanho e taxa no collab; versões para restaurar; `audit_log`. |
| Mudança de papel não refletida em sessões abertas | Evento `permission-changed` + JWT curto (5 min) como rede de segurança. |
| Undo surpreendente em colaboração | Documentar a semântica "desfaz só as suas mudanças"; restaurar a seleção junto com o undo. |
| Executar Drizzle no servidor | Não fazer: o parse de Drizzle é só no cliente (§1). |

---

## 14. Decisões em aberto (com recomendação)

1. **Os painéis de código devem ser de digitação compartilhada** (duas pessoas no mesmo texto SQL, com cursores)? Recomendação: **não por enquanto**. O merge pelo modelo (§4.6) evita SQL inválido no meio de uma digitação alheia. Dá para reavaliar depois da fase 5.
2. **Provedores de login:** e-mail/senha + GitHub + Google? (Recomendação: sim, os três.)
3. **Manter o modo local sem conta?** Recomendação: sim. É barato, porque usa o mesmo binding CRDT, e serve de porta de entrada.
4. **Editores podem compartilhar?** Default `editorsCanShare: false`, configurável por projeto.
5. **Hospedagem e e-mail:** escolher os provedores antes da fase 6. O código fica atrás de interfaces (`Mailer`, `Storage` para thumbnails) para não acoplar.
