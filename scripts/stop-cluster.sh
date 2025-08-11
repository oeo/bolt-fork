#!/bin/bash

# stop a cluster of bolt nodes
# usage: ./stop-cluster.sh [number_of_nodes]

N=${1:-3}

for i in $(seq 1 $N); do
  NODE_NAME="node$i"
  echo "stopping $NODE_NAME..."
  docker compose -f compose/node.yml -p $NODE_NAME down -v
done

echo "cluster stopped"