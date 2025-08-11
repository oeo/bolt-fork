#!/bin/bash

# launch a cluster of N bolt nodes for testing
# usage: ./launch-cluster.sh [number_of_nodes]

N=${1:-3}
NETWORK_NAME="bolt-shared"
BASE_API_PORT=7333
BASE_P2P_PORT=7334
BASE_WS_PORT=7335
BASE_METRICS_PORT=7336
BASE_REDIS_PORT=6379
BASE_IPFS_API_PORT=5001
BASE_IPFS_SWARM_PORT=4001
BASE_IPFS_GATEWAY_PORT=8080
BASE_GRAFANA_PORT=3000
BASE_PROMETHEUS_PORT=9090
BASE_LOKI_PORT=3100

# miner addresses for testing
MINERS=(
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
  "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"
  "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
)

echo "creating shared network: $NETWORK_NAME"
docker network create $NETWORK_NAME 2>/dev/null || true

# collect bootstrap nodes as we create them
BOOTSTRAP_NODES=""

for i in $(seq 1 $N); do
  NODE_NAME="node$i"
  
  # calculate port offsets
  API_PORT=$((BASE_API_PORT + (i-1)*10))
  P2P_PORT=$((BASE_P2P_PORT + (i-1)*10))
  WS_PORT=$((BASE_WS_PORT + (i-1)*10))
  METRICS_PORT=$((BASE_METRICS_PORT + (i-1)*10))
  REDIS_PORT=$((BASE_REDIS_PORT + i))
  IPFS_API_PORT=$((BASE_IPFS_API_PORT + i*10))
  IPFS_SWARM_PORT=$((BASE_IPFS_SWARM_PORT + i*10))
  IPFS_GATEWAY_PORT=$((BASE_IPFS_GATEWAY_PORT + i))
  GRAFANA_PORT=$((BASE_GRAFANA_PORT + i))
  PROMETHEUS_PORT=$((BASE_PROMETHEUS_PORT + i))
  LOKI_PORT=$((BASE_LOKI_PORT + i))
  
  # first 2 nodes are miners, rest are full nodes
  if [ $i -le 2 ]; then
    MINING_ENABLED="true"
    MINER_ADDRESS="${MINERS[$((i-1))]}"
  else
    MINING_ENABLED="false"
    MINER_ADDRESS=""
  fi
  
  echo "launching $NODE_NAME..."
  echo "  api: http://localhost:$API_PORT"
  echo "  p2p: localhost:$P2P_PORT"
  echo "  grafana: http://localhost:$GRAFANA_PORT"
  
  # use compose/node.yml with environment overrides
  NODE_NAME=$NODE_NAME \
  NODE_ID=$NODE_NAME \
  API_PORT=$API_PORT \
  P2P_PORT=$P2P_PORT \
  WS_PORT=$WS_PORT \
  METRICS_PORT=$METRICS_PORT \
  REDIS_PORT=$REDIS_PORT \
  IPFS_API_PORT=$IPFS_API_PORT \
  IPFS_SWARM_PORT=$IPFS_SWARM_PORT \
  IPFS_GATEWAY_PORT=$IPFS_GATEWAY_PORT \
  GRAFANA_PORT=$GRAFANA_PORT \
  PROMETHEUS_PORT=$PROMETHEUS_PORT \
  LOKI_PORT=$LOKI_PORT \
  MINING_ENABLED=$MINING_ENABLED \
  MINER_ADDRESS=$MINER_ADDRESS \
  BOOTSTRAP_NODES=$BOOTSTRAP_NODES \
  NETWORK_NAME=$NETWORK_NAME \
  docker compose -f compose/node.yml -p $NODE_NAME up -d
  
  # add this node to bootstrap list for next nodes
  if [ -n "$BOOTSTRAP_NODES" ]; then
    BOOTSTRAP_NODES="$BOOTSTRAP_NODES,$NODE_NAME@localhost:$P2P_PORT"
  else
    BOOTSTRAP_NODES="$NODE_NAME@localhost:$P2P_PORT"
  fi
done

echo ""
echo "cluster launched with $N nodes:"
for i in $(seq 1 $N); do
  API_PORT=$((BASE_API_PORT + (i-1)*10))
  GRAFANA_PORT=$((BASE_GRAFANA_PORT + i))
  echo "  node$i: http://localhost:$API_PORT (grafana: http://localhost:$GRAFANA_PORT)"
done

echo ""
echo "to stop the cluster: ./scripts/stop-cluster.sh $N"