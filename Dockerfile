# Builder: full install (dev deps incl. vite/tailwind) + frontend build.
# Build tools (python3/make/g++) are needed only here: bun compiles
# better-sqlite3 (test-only devDep) via node-gyp during install.
FROM oven/bun:1.3.14-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Skip the react-doctor Effect-TS checkout (dev-only; a live clone in image
# builds is a fragile network dep). The prepare hook must exist for
# `bun install` to succeed, so copy the script — it exits 0 under the guard.
ENV LXK_SKIP_PREPARE=1
COPY scripts/prepare-effect.sh ./scripts/prepare-effect.sh

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ARG VITE_LXK_API_KEY
ENV VITE_LXK_API_KEY=$VITE_LXK_API_KEY

RUN bunx vite build

# Runtime: production deps only, no build tools, no dev deps.
FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV LXK_SKIP_PREPARE=1
COPY scripts/prepare-effect.sh ./scripts/prepare-effect.sh
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["bun", "server/entry.ts"]
