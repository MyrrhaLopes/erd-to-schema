# Imagem do serviço `web`: build do Vite + Caddy servindo o SPA e fazendo proxy de /api e /collab.
FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @erd/web --docker

FROM base AS build
# só o lockfile e os package.json: o install fica em cache enquanto as dependências não mudam
COPY --from=pruner /repo/out/json/ .
COPY .npmrc ./
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@erd/web

FROM caddy:2
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
ENV PORT=8080 SERVER_INTERNAL_URL=http://localhost:8080
EXPOSE 8080
