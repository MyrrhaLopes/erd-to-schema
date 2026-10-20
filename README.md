# ERD Builder

Canvas interativo de ERD em que **canvas, SQL (Postgres), Prisma e Drizzle são quatro vistas do mesmo modelo**. Editar qualquer uma atualiza as outras três, e o canvas se redesenha sozinho. Implementado a partir de [`docs/erd-builder-plan.md`](docs/erd-builder-plan.md).

Monorepo pnpm + Turborepo, com contas, projetos na nuvem e o modo local sem conta. O plano de evolução está em [`docs/fullstack-collab-plan.md`](docs/fullstack-collab-plan.md). O dicionário de dados em Word publicado no Google Drive está planejado em [`docs/drive-docx-plan.md`](docs/drive-docx-plan.md).

## Rodando local (com backend)

Pré-requisitos: Node 22+ (24 recomendado, `.node-version`), pnpm 10 (`corepack enable`) e Docker.

```bash
pnpm install
cp .env.example .env      # valores de dev já prontos
pnpm infra:up             # Postgres + Mailpit (e-mails em http://localhost:8025)
pnpm db:migrate
pnpm dev                  # web em http://localhost:5173 (+ API em :8080, via proxy do Vite)
```

- `/local` abre o modo local, sem conta (o projeto fica só neste navegador, no IndexedDB).
- `/` pede login. O e-mail de confirmação do cadastro chega no Mailpit.

| Comando | O quê |
|---|---|
| `pnpm test` | unitários, propriedade (fast-check) e integração com Postgres real |
| `pnpm e2e` | Playwright; sobe a API e o Vite sozinho (com `URL=...`, roda contra outro servidor) |
| `pnpm verify` | lint + typecheck + test + build + imagens Docker — rodar antes de abrir PR |
| `pnpm prod:local` | as imagens reais (as mesmas do Railway) + Postgres + Mailpit, em http://localhost:8081 |
| `pnpm prod:scale` | igual, com Redis e **duas réplicas** do `server` atrás do Caddy (fase 7) |
| `pnpm load` | teste de carga: 20 clientes editando um canvas de 200 tabelas (`URL`, `CLIENTS`, `TABLES`, `SECONDS`) |
| `pnpm db:generate` | gera a migração SQL a partir do schema Drizzle (versionar junto com a mudança) |
| `pnpm env:check` | valida o `.env` com o mesmo zod do boot do servidor |

## Variáveis de ambiente

Todas estão em [`.env.example`](.env.example), com comentários. O servidor valida tudo no boot (`apps/api/src/env.ts`): com variável faltando, ele não sobe e o healthcheck não passa. O `web` não tem variáveis de build: chama `/api` e `/collab` na própria origem, então a mesma imagem serve staging e produção.

## Deploy no Railway

Resumo do §15 do plano. Um projeto Railway com três serviços:

| Serviço | Origem | Domínio público |
|---|---|---|
| `web` | `apps/web/Dockerfile` (Vite + Caddy), config em `/apps/web/railway.json` | sim (o único) |
| `server` | `apps/api/Dockerfile` (API + colaboração), config em `/apps/api/railway.json` | não (rede privada) |
| `Postgres` | template do Railway | não |

1. **New Project → Empty Project**; **+ New → Database → PostgreSQL** (nome do serviço: `Postgres`).
2. **+ New → GitHub Repo** duas vezes (`server` e `web`), ambas com *Root Directory* `/` e *Config file path* apontando para o `railway.json` do serviço. Ligue **Wait for CI**. Só o `web` ganha domínio.
3. Variáveis do `server` (Raw Editor): `NODE_ENV=production`, `PORT=8080`, `APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}`, `BETTER_AUTH_URL=${{APP_URL}}`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_SECRET` e `COLLAB_JWT_SECRET` (`openssl rand -base64 32`), `MAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, OAuth opcional e `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`.
4. Variável do `web`: `SERVER_INTERNAL_URL=http://${{server.RAILWAY_PRIVATE_DOMAIN}}:${{server.PORT}}`.
5. Deploy: o `server` roda as migrações no `preDeployCommand` e só recebe tráfego quando `/readyz` responde; o `web` responde em `/healthz`.

Daí em diante: PR → CI verde → merge → deploy automático.

**E-mail em produção:** crie a conta no Resend com um subdomínio de envio próprio (por exemplo, `mail.seudominio.com`) e os registros **SPF, DKIM e DMARC** no DNS; sem isso, convites e pedidos de acesso caem no spam. `EMAIL_FROM` usa esse subdomínio.

**Produção x staging:** duplique o ambiente (*Environments → New → Duplicate*) para ter `staging` com banco próprio; a produção deploya de `main` (com aprovação) e o staging do branch de desenvolvimento. Configure *usage limits* e alertas de gasto no workspace.

**Backups:** além dos backups de volume do Postgres no Railway (diário e semanal, aba *Backups*), o workflow [`backup.yml`](.github/workflows/backup.yml) faz um `pg_dump` semanal cifrado (segredos `DATABASE_PUBLIC_URL` e `BACKUP_PASSPHRASE`) e guarda como artefato por 90 dias, fora do Railway.

**Observabilidade:** logs em JSON (pino) filtráveis por `level`, `canvasId` e `userId`; `GET /metrics` no `server` (formato Prometheus: conexões, documentos abertos, maior documento, tempo de parse do bot, timeouts do sandbox, updates recusados, 5xx, limite de taxa, pool do Postgres, memória). O `server` fica na rede privada (o Caddy só repassa `/api` e `/collab`); com `METRICS_TOKEN`, o endpoint exige o token.

**Escala (fase 7):** com uma réplica, nada muda. Para várias: crie um serviço **Redis** (template do Railway), defina `REDIS_URL=${{Redis.REDIS_URL}}` no `server` e suba `numReplicas` no `apps/api/railway.json`. Cada réplica sincroniza os documentos abertos pela extensão Redis do Hocuspocus; uma só (eleita por documento no Redis) roda o sync bot, para o SQL não ser traduzido duas vezes; os avisos de papel e de versão restaurada continuam pelo `LISTEN/NOTIFY` do Postgres, que já alcança todas as réplicas. **Nunca** mais de uma réplica sem `REDIS_URL`. Migrações seguem *expand/contract* (nada de `DROP`/`RENAME` no mesmo deploy que muda o código que usa a coluna).

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

### Na nuvem: projetos, compartilhamento e tempo real

- **Contas** com e-mail e senha (verificação e redefinição por e-mail) e, se configurado, GitHub/Google.
- **Projetos** com vários canvases; edição em tempo real (Yjs + Hocuspocus), cópia local para abrir rápido e continuar offline.
- **Compartilhar** (botão no topo do editor): por e-mail, como **editor** ou **leitor**. Quem já tem conta entra direto; quem não tem recebe um convite por e-mail (link de uso único, 7 dias, só vale para aquele endereço). Limite de convites por hora (`INVITES_PER_HOUR`).
- **Papéis** (`packages/contracts/src/permissions.ts`, uma regra só usada pela API, pelo collab e pela interface): o dono faz tudo; editores editam, renomeiam e criam canvases (e compartilham, se o dono ligar "Editores podem compartilhar"); leitores veem, exportam e aparecem na presença.
- **Modo visualização:** o leitor vê uma faixa "Você está no modo visualização", com o botão **Pedir acesso de edição** (com mensagem opcional). O dono recebe no sininho e por e-mail; ao aprovar (em **Configurações do projeto**), o leitor vira editor **sem recarregar a página**.
- **Link de visualização:** opcionalmente, qualquer pessoa logada com o link vê o projeto como leitor. Desligar o link derruba na hora quem entrou só por ele.
- **Notificações:** sininho in-app (pedidos, decisões, convites, papel alterado) e e-mails desligáveis em **Configurações da conta** (`/settings`). Os e-mails saem por uma fila **pg-boss** no próprio Postgres, com retentativa e backoff; a requisição não espera o envio.
- **Presença (estilo Google Docs):** cada membro tem uma cor estável no projeto. No canvas aparecem o cursor de cada pessoa com o nome, o anel na cor de quem está com um nó selecionado (com mini-avatares), o aviso "Fulana está editando" ao renomear uma tabela ou coluna (só avisa, não bloqueia), o arraste ao vivo, arestas selecionadas na cor de quem selecionou e pontinhos no minimapa. No topo, os avatares de quem está online: clicar **segue** a pessoa.
- **Painéis e notas compartilhados:** cursores e seleções dos outros com nome, rastro do que acabaram de digitar na cor deles, bolinhas nas abas mostrando quem está em cada formato, erros "em edição por Fulana" no trecho que outra pessoa está escrevendo, faixa na margem do bloco da tabela que alguém selecionou no canvas e "Ver no diagrama" para ir do código à tabela.
- **Versões:** o botão de histórico no topo do editor salva uma versão com nome; uma automática é guardada por dia (as automáticas com mais de 30 dias saem). **Restaurar** aplica a diferença como uma edição comum: todos veem na hora (com o aviso "Fulana restaurou a versão…") e dá para desfazer com Ctrl+Z.
- **Miniaturas** dos projetos no dashboard, desenhadas no servidor (SVG) a partir do layout.
- **Limites:** projetos por conta, canvases por projeto, membros por projeto, versões por canvas, convites por hora, cadastros por minuto, requisições por minuto na API, tamanho e taxa de mensagens no WebSocket — todos configuráveis (veja `.env.example`).
- **Autoria:** o que outra pessoa muda acende por alguns segundos na cor dela; **Visualização → Mostrar autoria** pinta cada tabela, coluna, nota e trecho de texto na cor de quem editou por último ("Bia · há 3 min").
- **Mudança de papel ao vivo:** a API publica o evento (Postgres `LISTEN/NOTIFY`) e o servidor de colaboração rebaixa, promove ou desconecta as conexões abertas.

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
apps/web/                    o app (Vite + React): rotas, auth, dashboard, editor; modo local em /local
apps/api/                    Hono + Better Auth + e-mail; hospeda o servidor de colaboração (mesmo processo)
apps/collab/                 Hocuspocus (WebSocket Yjs em /collab), persistência (log + compactação), sync bot
packages/crdt/               o modelo como CRDT: forma do Y.Doc, applyDiff, projeção incremental, validação zod
packages/sync/               o sync bot: texto ⇄ modelo (parse por bloco, patch, blocos divergentes)
packages/sandbox/            Drizzle do usuário num isolate V8 (isolated-vm) dentro de worker_threads
packages/db/                 schema Drizzle do backend + migrações; packages/contracts: zod + can()
packages/emails/             templates React Email; packages/canvas-kinds: contrato de tipo de canvas
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

## Teste de carga

`pnpm load` cria uma conta (confirmada pelo Mailpit), um projeto com 200 tabelas e N clientes Yjs reais (distribuídos em processos, como navegadores) que movem tabelas, renomeiam colunas e digitam no painel SQL ao mesmo tempo. Mede a latência de propagação entre clientes e confere que todos terminam com o mesmo documento. Resultado local contra `pnpm prod:local` (20 clientes, 200 tabelas, 30 s, ~39 op/s no total):

| Topologia | p50 | p95 | p99 | convergência |
|---|---|---|---|---|
| 1 réplica | 33 ms | 99 ms | 175 ms | OK |
| 2 réplicas + Redis (`pnpm prod:scale`) | 34 ms | 121 ms | 224 ms | OK |

O job `e2e-scale` do CI roda as jornadas de colaboração e este teste contra as duas réplicas. No staging: `URL=https://<staging> LOAD_EMAIL=... LOAD_PASSWORD=... pnpm load`.

## Diferenças em relação ao plano

- Os eventos de permissão e os avisos de canvas (versão restaurada, pedidos ao bot) usam `LISTEN/NOTIFY` do Postgres também com várias réplicas, em vez do Redis pub/sub: o Postgres já alcança todas as réplicas, e o Redis fica só para o Hocuspocus e a eleição do líder do bot.
- As miniaturas são SVG gerados no servidor a partir do layout (sem navegador no backend), não imagens do canvas renderizado.
- O canvas de **fluxos de usuário** (fase 8) aparece como aba "em breve": o contrato `CanvasKind` (`packages/canvas-kinds`) já existe, então ele entra como um tipo novo, sem refatorar o editor.

- No Drizzle, relações-nota e tags usam a mesma diretiva `// @erd:` dos outros formatos (lida por scan de linhas), e não `relations()`. Isso deixa o formato uniforme e não depende da troca de API do Drizzle 1.0.
- O auto-layout é próprio, em camadas por profundidade de FK (botão **Organizar**). O `elkjs` ficou de fora.
- Os atalhos são tratados diretamente com `keydown`, sem `tinykeys`. A interface usa fontes do sistema, então o export usa `skipFonts` e não sofre com CORS de fontes.
- Índices de expressão ainda não são suportados: geram um aviso e são ignorados.
