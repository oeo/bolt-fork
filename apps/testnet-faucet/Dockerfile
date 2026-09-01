FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY apps/testnet-faucet ./apps/testnet-faucet
RUN mkdir -p /data && chown -R bun:bun /app /data

USER bun
EXPOSE 7340
CMD ["bun", "run", "apps/testnet-faucet/server.ts"]
