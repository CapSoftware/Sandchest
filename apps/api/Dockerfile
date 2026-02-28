FROM oven/bun:1.3.6 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/docs/package.json apps/docs/
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config/package.json packages/config/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/admin-cli/package.json packages/admin-cli/
COPY packages/github-action/package.json packages/github-action/
COPY examples/package.json examples/
COPY patches/ patches/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN bun run --filter @sandchest/contract build && \
    bun run --filter @sandchest/api build

FROM oven/bun:1.3.6-slim
WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/docs/package.json apps/docs/
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config/package.json packages/config/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/admin-cli/package.json packages/admin-cli/
COPY packages/github-action/package.json packages/github-action/
COPY examples/package.json examples/
COPY patches/ patches/
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY --from=build /app/packages/db/src packages/db/src

EXPOSE 3001
CMD ["bun", "run", "apps/api/dist/index.js"]
