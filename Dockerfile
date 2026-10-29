# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public/css ./public/css
COPY --chown=node:node public/js ./public/js
COPY --chown=node:node public/views ./public/views
COPY --chown=node:node public/favicon.svg ./public/favicon.svg
COPY --chown=node:node scripts/healthcheck.js scripts/admin-sync.js ./scripts/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
