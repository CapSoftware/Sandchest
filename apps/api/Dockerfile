FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config/package.json packages/config/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY examples/package.json examples/
COPY patches/ patches/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --filter @sandchest/contract build && \
    bun run --filter @sandchest/api build

FROM oven/bun:1-slim
WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config/package.json packages/config/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY examples/package.json examples/
COPY patches/ patches/
RUN bun install --frozen-lockfile --production

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY --from=build /app/packages/db/src packages/db/src

EXPOSE 3001
CMD ["bun", "run", "apps/api/dist/index.js"]
