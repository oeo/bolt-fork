#!/usr/bin/env bun

// launch a cluster of N bolt nodes for testing
// usage: bun run scripts/launch-cluster.ts [number_of_nodes]

import { $ } from "bun";

const N = parseInt(process.argv[2] || "3");
const NETWORK_NAME = "bolt-shared";

// base ports
const BASE_API_PORT = 7333;
const BASE_METRICS_PORT = 7336;
const BASE_REDIS_PORT = 6379;
const BASE_IPFS_API_PORT = 5001;
const BASE_IPFS_SWARM_PORT = 4001;
const BASE_IPFS_GATEWAY_PORT = 8080;
const BASE_GRAFANA_PORT = 3000;
const BASE_PROMETHEUS_PORT = 9090;
const BASE_LOKI_PORT = 3100;

// miner addresses for testing
const MINERS = [
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
  "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
];

// check for --clean flag
const CLEAN = process.argv.includes("--clean");

console.log(`creating shared network: ${NETWORK_NAME}`);
await $`docker network create ${NETWORK_NAME} 2>/dev/null || true`.quiet();

if (CLEAN) {
  console.log("cleaning up old data volumes...");
  // stop and remove all node containers and their volumes
  for (let i = 1; i <= N; i++) {
    await $`docker compose -f compose/node.yml -p node${i} down -v 2>/dev/null || true`.quiet();
  }
  // also remove any lingering volumes with node patterns
  await $`docker volume ls | grep -E "node[0-9]" | awk '{print $2}' | xargs -r docker volume rm -f 2>/dev/null || true`.quiet();
}

for (let i = 1; i <= N; i++) {
  const nodeName = `node${i}`;
  
  // calculate port offsets (each node gets +10 offset)
  const ports = {
    api: BASE_API_PORT + (i - 1) * 10,
    metrics: BASE_METRICS_PORT + (i - 1) * 10,
    redis: BASE_REDIS_PORT + i,
    ipfsApi: BASE_IPFS_API_PORT + i * 10,
    ipfsSwarm: BASE_IPFS_SWARM_PORT + i * 10,
    ipfsGateway: BASE_IPFS_GATEWAY_PORT + i,
    grafana: BASE_GRAFANA_PORT + i,
    prometheus: BASE_PROMETHEUS_PORT + i,
    loki: BASE_LOKI_PORT + i
  };
  
  // only first node is a miner to avoid competing chains
  const isMiner = i === 1;
  const minerAddress = isMiner ? MINERS[0] : "";
  
  console.log(`launching ${nodeName}...`);
  console.log(`  api: http://localhost:${ports.api}`);
  console.log(`  grafana: http://localhost:${ports.grafana}`);
  
  // set environment variables for this node
  const env = {
    NODE_NAME: nodeName,
    API_PORT: ports.api.toString(),
    METRICS_PORT: ports.metrics.toString(),
    REDIS_PORT: ports.redis.toString(),
    IPFS_API_PORT: ports.ipfsApi.toString(),
    IPFS_SWARM_PORT: ports.ipfsSwarm.toString(),
    IPFS_GATEWAY_PORT: ports.ipfsGateway.toString(),
    GRAFANA_PORT: ports.grafana.toString(),
    PROMETHEUS_PORT: ports.prometheus.toString(),
    LOKI_PORT: ports.loki.toString(),
    MINING_ENABLED: isMiner.toString(),
    MINER_ADDRESS: minerAddress,
    NETWORK_NAME: NETWORK_NAME
  };
  
  // launch the node using compose/node.yml (skip build, use existing image)
  await $`docker compose -f compose/node.yml -p ${nodeName} up -d --no-build`.env(env);
}

console.log(`\ncluster launched with ${N} nodes:`);
for (let i = 1; i <= N; i++) {
  const apiPort = BASE_API_PORT + (i - 1) * 10;
  const grafanaPort = BASE_GRAFANA_PORT + i;
  const nodeType = i === 1 ? "miner" : "full node";
  console.log(`  node${i}: http://localhost:${apiPort} (${nodeType}, grafana: http://localhost:${grafanaPort})`);
}

console.log(`\nto stop the cluster: bun run scripts/stop-cluster.ts ${N}`);
console.log(`to restart with clean data: bun run scripts/launch-cluster.ts ${N} --clean`);