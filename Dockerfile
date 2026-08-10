FROM oven/bun:1 AS base
WORKDIR /app

# better-sqlite3 needs node-gyp (python3/make/g++) when its NAPI prebuild
# doesn't match the runtime — oven/bun images ship neither.
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

EXPOSE 3000
CMD ["bun", "server/entry.ts"]
