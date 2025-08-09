# use the official bun image
FROM oven/bun:1-alpine

# set working directory
WORKDIR /app

# install dependencies for libp2p
RUN apk add --no-cache python3 make g++ git

# copy package files
COPY package.json bun.lockb* ./

# install dependencies
RUN bun install --frozen-lockfile || bun install

# copy source code
COPY . .

# expose ports
# 7333: API server
# 7334: P2P networking
# 7335: WebSocket server
# 7336: Metrics endpoint
EXPOSE 7333 7334 7335 7336

# run the application
CMD ["bun", "run", "src/index.ts"]