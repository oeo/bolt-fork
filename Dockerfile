# bolt node with IPFS networking
FROM oven/bun:1-alpine

WORKDIR /app

# install runtime dependencies including IPFS
RUN apk add --no-cache tini curl bash && \
    # detect architecture for IPFS download
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        IPFS_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        IPFS_ARCH="arm64"; \
    else \
        IPFS_ARCH="$ARCH"; \
    fi && \
    curl -sSL "https://dist.ipfs.tech/go-ipfs/v0.17.0/go-ipfs_v0.17.0_linux-${IPFS_ARCH}.tar.gz" | tar xz && \
    mv go-ipfs/ipfs /usr/local/bin/ && \
    rm -rf go-ipfs && \
    ipfs version

# copy package files
COPY package.json bun.lock* ./
RUN bun install

# copy source code
COPY src ./src
COPY scripts ./scripts

# create directories
RUN mkdir -p /data/lmdb /ipfs

# create startup script
RUN cat > /start.sh << 'EOF'
#!/bin/bash
set -e

echo "Starting bolt node with IPFS networking..."

# initialize IPFS if needed
if [ ! -d /ipfs/.ipfs ]; then
    IPFS_PATH=/ipfs/.ipfs ipfs init
    IPFS_PATH=/ipfs/.ipfs ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
    IPFS_PATH=/ipfs/.ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
    IPFS_PATH=/ipfs/.ipfs ipfs config Datastore.StorageMax 1GB
    # disable autorelay to prevent the errors
    IPFS_PATH=/ipfs/.ipfs ipfs config --json Swarm.RelayClient.Enabled false
fi

# start IPFS daemon in background
IPFS_PATH=/ipfs/.ipfs ipfs daemon --enable-pubsub-experiment &
IPFS_PID=$!

# wait for IPFS API to be ready
echo "Waiting for IPFS API to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:5001/api/v0/version > /dev/null 2>&1; then
        echo "IPFS API is ready!"
        IPFS_PATH=/ipfs/.ipfs ipfs id
        break
    fi
    echo "Waiting for IPFS API... ($i/30)"
    sleep 1
done

# check if we reached timeout
if [ $i -eq 30 ]; then
    echo "IPFS API failed to start after 30 seconds"
    exit 1
fi

# run bolt node
exec bun run src/index.ts
EOF

RUN chmod +x /start.sh

# expose ports
EXPOSE 7333 4001 5001 8080

# environment
ENV IPFS_PATH=/ipfs/.ipfs

# use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/bash", "/start.sh"]