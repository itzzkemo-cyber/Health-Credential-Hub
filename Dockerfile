FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build:production
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /opt/healthdocs-api

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_DIST_DIR=/app/web
ENV MIGRATIONS_DIR=/app/migrations

WORKDIR /app/api
COPY --from=build --chown=node:node /opt/healthdocs-api/ /app/api/
COPY --from=build --chown=node:node /workspace/artifacts/api-server/dist/ /app/api/dist/
COPY --from=build --chown=node:node /workspace/artifacts/health-docs/dist/public/ /app/web/
COPY --from=build --chown=node:node /workspace/lib/db/migrations/ /app/migrations/

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
