# bolt node
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb

WORKDIR /app

# copy package files
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# copy source code
COPY src ./src
COPY scripts/storage.ts ./scripts/storage.ts

RUN mkdir -p /data/lmdb

# expose ports
EXPOSE 7333 7336 8333

CMD ["bun", "run", "src/index.ts"]
