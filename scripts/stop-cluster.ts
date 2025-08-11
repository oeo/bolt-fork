#!/usr/bin/env bun

// stop a cluster of bolt nodes
// usage: bun run scripts/stop-cluster.ts [number_of_nodes]

import { $ } from "bun";

const N = parseInt(process.argv[2] || "3");

for (let i = 1; i <= N; i++) {
  const nodeName = `node${i}`;
  console.log(`stopping ${nodeName}...`);
  await $`docker compose -f compose/node.yml -p ${nodeName} down -v`.quiet();
}

console.log(`cluster stopped`);