#!/bin/bash

# run multiple nodes using the same compose file
# usage: ./run-multi-node.sh

# node 1 - miner
NODE_NAME=node1 \
NODE_ID=node1 \
API_PORT=7333 \
REDIS_PORT=7337 \
MINER_ADDRESS=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa \
docker compose -f compose/node.yml -p node1 up -d

# node 2 - miner  
NODE_NAME=node2 \
NODE_ID=node2 \
API_PORT=7343 \
REDIS_PORT=7338 \
MINER_ADDRESS=1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 \
docker compose -f compose/node.yml -p node2 up -d

# node 3 - full node
NODE_NAME=node3 \
NODE_ID=node3 \
API_PORT=7353 \
REDIS_PORT=7339 \
MINING_ENABLED=false \
docker compose -f compose/node.yml -p node3 up -d

echo "started 3 nodes:"
echo "  node1: http://localhost:7333 (miner)"
echo "  node2: http://localhost:7343 (miner)"
echo "  node3: http://localhost:7353 (full node)"