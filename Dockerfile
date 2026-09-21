# syntax=docker/dockerfile:1
#
# Single self-contained image: the whole app (API + static UI) as one Node
# process, SQLite + book files on a volume at /data. Built for the k3s
# cluster's arm64 nodes (see .github/workflows/build-ghcr.yml).

# The bundle is plain JS (node:sqlite is built into Node, no native modules),
# so it can be compiled once on the *build* machine's own architecture and
# just copied into the arm64 image — no slow QEMU-emulated npm install.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: wrangler/workerd postinstalls aren't needed to bundle.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN npm run build:server
# The reading pane is a real Monaco editor: bundle just its core (no language
# packs) into public/vendor/monaco, loaded lazily by the UI.
COPY client ./client
RUN npm run build:monaco

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    MIGRATIONS_DIR=/app/migrations \
    CHUNK_SIZE=300
WORKDIR /app
COPY --from=build /app/dist/server.mjs ./server.mjs
# Backup/restore tool, run by the cluster CronJob against the same volume.
COPY --from=build /app/dist/backup.mjs ./backup.mjs
COPY public ./public
COPY --from=build /app/public/vendor ./public/vendor
COPY migrations ./migrations
# uid 1000 = the image's built-in `node` user (matches runAsUser in the k8s
# manifests). On Kubernetes the PVC is made writable via fsGroup instead.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
