# Imagem do serviço `server`: API (Hono + Better Auth) + colaboração (Hocuspocus + sync bot), num processo só.
FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @erd/api --docker

FROM base AS builder
# isolated-vm é módulo nativo: precisa de toolchain no build quando não há binário pré-compilado
# para a plataforma (NATIVE_TOOLCHAIN=0 pula a instalação, ex.: em ambientes sem acesso ao apt)
ARG NATIVE_TOOLCHAIN=1
RUN if [ "$NATIVE_TOOLCHAIN" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*; fi
# só o lockfile e os package.json primeiro: o install fica em cache enquanto as dependências não mudam
COPY --from=pruner /repo/out/json/ .
COPY .npmrc ./
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@erd/api
RUN pnpm --filter @erd/api deploy --prod /app

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app .
USER node
EXPOSE 8080
# --no-node-snapshot é exigido pelo isolated-vm no Node ≥ 20
CMD ["node", "--no-node-snapshot", "--enable-source-maps", "dist/main.js"]
