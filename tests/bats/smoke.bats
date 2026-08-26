#!/usr/bin/env bats

setup() {
  export PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export COMPOSE_PROJECT_NAME="bolt-bats-${BATS_TEST_NUMBER}-$$"
  export COMPOSE_FILE="$PROJECT_ROOT/docker-compose.bats.yml"
}

teardown() {
  if [ "${BATS_TEST_COMPLETED:-0}" -ne 1 ]; then
    docker compose --project-directory "$PROJECT_ROOT" ps >&2
    docker compose --project-directory "$PROJECT_ROOT" logs bolt-a bolt-b ipfs-a ipfs-b >&2
  fi
  docker compose --project-directory "$PROJECT_ROOT" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

wait_for_api() {
  local service="$1"
  local address
  for _ in $(seq 1 60); do
    address="$(docker compose --project-directory "$PROJECT_ROOT" port "$service" 7333 2>/dev/null)"
    [ -n "$address" ] && curl --fail --silent "http://$address/health" >/dev/null 2>&1 && return 0
    sleep 1
  done

  return 1
}

node_eval() {
  local service="$1"
  local script="$2"
  docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY "$service" bun -e "$script"
}

wait_for_mined_block() {
  for _ in $(seq 1 60); do
    local info
    info="$(node_eval bolt-a 'const i=await fetch("http://127.0.0.1:7333/blockchain/info").then(r=>r.json()); console.log(`${i.height} ${i.latestBlockHash}`)' 2>/dev/null)" || true
    [ "${info%% *}" -ge 1 ] 2>/dev/null && printf '%s' "$info" && return 0
    sleep 1
  done
  return 1
}

wait_for_block() {
  local service="$1"
  local height="$2"
  local expected_hash="$3"
  for _ in $(seq 1 60); do
    local hash
    hash="$(node_eval "$service" "const r=await fetch('http://127.0.0.1:7333/blocks/$height'); if(!r.ok) process.exit(1); console.log((await r.json()).hash)" 2>/dev/null)" || true
    [ "$hash" = "$expected_hash" ] && return 0
    sleep 1
  done
  return 1
}

wait_for_mempool_transaction() {
  local service="$1"
  local hash="$2"
  for _ in $(seq 1 50); do
    node_eval "$service" "const d=await fetch('http://127.0.0.1:7333/mempool/transactions?limit=100').then(r=>r.json()); if(!d.transactions.some(t=>t.hash==='$hash')) process.exit(1)" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

wait_for_peer() {
  local service="$1"
  for _ in $(seq 1 60); do
    node_eval "$service" 'const t=await fetch("http://127.0.0.1:7336/metrics").then(r=>r.text()); const m=t.match(/^bolt_network_peers_connected (\d+)$/m); if(!m||Number(m[1])<1) process.exit(1)' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

@test "two nodes synchronize, relay a transaction, and preserve state" {
  run docker compose --project-directory "$PROJECT_ROOT" up --detach --wait --wait-timeout 30 ipfs-a ipfs-b
  [ "$status" -eq 0 ]

  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-a ipfs bootstrap list
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-b ipfs bootstrap list
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  ipfs_b_id="$(docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-b ipfs id -f='<id>')"
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-a ipfs swarm connect "/dns4/ipfs-b/tcp/4001/p2p/$ipfs_b_id"
  [ "$status" -eq 0 ]

  run docker compose --project-directory "$PROJECT_ROOT" up --detach --build bolt-a bolt-b
  [ "$status" -eq 0 ]

  wait_for_api bolt-a
  wait_for_api bolt-b

  target="$(wait_for_mined_block)"
  target_height="${target%% *}"
  target_hash="${target#* }"
  [ "$target_height" -ge 1 ]
  wait_for_block bolt-b "$target_height" "$target_hash"

  run env BOLT_A_MINING_ENABLED=false docker compose --project-directory "$PROJECT_ROOT" up --detach --force-recreate bolt-a
  [ "$status" -eq 0 ]
  wait_for_api bolt-a
  wait_for_peer bolt-a

  run node_eval bolt-a '
    import { TransactionClass } from "./src/core/transaction.ts";
    import { serialize } from "./src/utils/bigint.ts";
    const from = "2fQ4Xu3dv16nKNxZfBKkHfC759K79xRpsYC";
    const nonce = await fetch(`http://127.0.0.1:7333/accounts/${from}/nonce`).then(r => r.json());
    const tx = new TransactionClass(1059, from, "2fWMqcFysx5wtV6KZDZ71a1jZgd2tRd3CcX", 100000000n, nonce.nonce, 1000000n, Date.now());
    await tx.sign("0000000000000000000000000000000000000000000000000000000000000001");
    const response = await fetch("http://127.0.0.1:7333/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialize(tx.toObject()),
    });
    if (!response.ok) throw new Error(await response.text());
    console.log(tx.hash);
  '
  [ "$status" -eq 0 ]
  transaction_hash="$output"
  [[ "$transaction_hash" =~ ^[a-f0-9]{64}$ ]]
  wait_for_mempool_transaction bolt-b "$transaction_hash"

  run docker compose --project-directory "$PROJECT_ROOT" restart bolt-a
  [ "$status" -eq 0 ]
  wait_for_api bolt-a
  wait_for_block bolt-a "$target_height" "$target_hash"

  run node_eval bolt-a "const r=await fetch('http://127.0.0.1:7333/transactions/$transaction_hash'); if(!r.ok) process.exit(1); console.log((await r.json()).hash)"
  [ "$status" -eq 0 ]
  [ "$output" = "$transaction_hash" ]
}
