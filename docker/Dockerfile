# syntax=docker/dockerfile:1.7
#
# Sandchest, self-hosted: the web app, its workflows and the indexer in one image.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t sandchest:local .
# Both architectures:
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile -t <registry>/sandchest .
#
# The indexer is cross-compiled on the build machine (static musl, no emulation). The web app is built
# for the target platform, since its traced dependencies can include native modules.

ARG NODE_IMAGE=node:24-alpine
ARG BUN_IMAGE=oven/bun:1.4.4-alpine

# ---- Indexer ------------------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM ghcr.io/rust-cross/cargo-zigbuild:0.24.0 AS indexer
ARG TARGETARCH
WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-musl ;; \
      arm64) target=aarch64-unknown-linux-musl ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && cargo zigbuild --locked --release -p sandchest-indexer --target "$target" \
    && cp "target/$target/release/sandchest-index" /sandchest-index

# ---- Web app ------------------------------------------------------------------------------------

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
# Manifests first, so dependencies stay cached while the source changes.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/billing/package.json packages/billing/
COPY packages/db/package.json packages/db/
COPY packages/email/package.json packages/email/
COPY packages/engine/package.json packages/engine/
COPY packages/github/package.json packages/github/
COPY packages/workspace/package.json packages/workspace/
COPY evals/package.json evals/
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
# A self-contained server running workflows on the Postgres World (apps/web/next.config.ts).
ENV SANDCHEST_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN bun run --cwd apps/web build \
    # Traced but never loaded: TypeScript (wanted only by an optional config loader in the queue
    # worker) and the image optimiser (the app has no next/image).
    && cd apps/web/.next/standalone/node_modules \
    && rm -rf .bun/typescript@* .bun/sharp@* .bun/@img+* \
    && for link in $(find . -type l); do [ -e "$link" ] || rm "$link"; done
# Start-up migrations, bundled into one file with their SQL beside them.
RUN bun build apps/web/scripts/migrate.ts --target=node --format=esm --minify-syntax --external pg-native --external typescript --outfile=/out/migrate.mjs \
    && mkdir -p /out/migrations \
    && cp -R packages/db/migrations /out/migrations/app \
    && cp -RL apps/web/node_modules/@workflow/world-postgres/src/drizzle/migrations /out/migrations/world

# ---- Runtime ------------------------------------------------------------------------------------

FROM ${NODE_IMAGE}
# git clones repositories for scans (LocalWorkspace); tini forwards signals and reaps scan subprocesses.
RUN apk add --no-cache git tini
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    SANDCHEST_WORKSPACE=local \
    SANDCHEST_INDEXER_BIN=/usr/local/bin/sandchest-index \
    WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY=20 \
    WORKFLOW_POSTGRES_MAX_POOL_SIZE=22 \
    SANDCHEST_MIGRATIONS=/app/migrations/app \
    SANDCHEST_WORLD_MIGRATIONS=/app/migrations/world
WORKDIR /app
COPY --from=indexer /sandchest-index /usr/local/bin/sandchest-index
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /out/ ./
COPY docker/server.mjs docker/entrypoint.sh ./
# The app's files stay root-owned; the server may only write its cache and temporary scan workspaces.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
