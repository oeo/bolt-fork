# bolt node
FROM oven/bun:1-alpine

WORKDIR /app

RUN apk add --no-cache tini curl

# copy package files
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# copy source code
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data/lmdb

# expose ports
EXPOSE 7333 7336 8333

# use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
