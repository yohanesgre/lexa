FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN bun install --frozen-lockfile

COPY . .

ARG VITE_LXK_API_KEY
ENV VITE_LXK_API_KEY=$VITE_LXK_API_KEY

RUN bunx vite build

EXPOSE 3000
CMD ["bun", "server/entry.ts"]
