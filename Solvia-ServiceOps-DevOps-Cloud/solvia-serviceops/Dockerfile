# syntax=docker/dockerfile:1
# Build executa a suíte de testes sem instalar dependências de terceiros.
FROM node:22-bookworm-slim AS verify
WORKDIR /workspace
COPY package.json ./
COPY public ./public
COPY server ./server
COPY tests ./tests
COPY scripts ./scripts
RUN npm run check && npm test

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=local
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production PORT=3100 HOST=0.0.0.0 SOLVIA_DATA_DIR=/app/data
WORKDIR /app
COPY --from=verify --chown=node:node /workspace/package.json ./
COPY --from=verify --chown=node:node /workspace/server ./server
COPY --from=verify --chown=node:node /workspace/public ./public
COPY --chown=node:node scripts/backup.mjs ./scripts/backup.mjs
COPY --chown=node:node scripts/backup-scheduler.mjs ./scripts/backup-scheduler.mjs
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
EXPOSE 3100
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server/index.mjs"]
