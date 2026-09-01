#!/usr/bin/env bats

setup() {
  export PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export COMPOSE_PROJECT_NAME="bolt-bats-${BATS_TEST_NUMBER}-$$"
  export COMPOSE_FILE="$PROJECT_ROOT/docker-compose.bats.yml"
}

teardown() {
  if [ "${BATS_TEST_COMPLETED:-0}" -ne 1 ]; then
    docker compose --project-directory "$PROJECT_ROOT" ps >&2
    docker compose --project-directory "$PROJECT_ROOT" logs bolt-a bolt-b ipfs-a ipfs-b router >&2
  fi
  docker compose --project-directory "$PROJECT_ROOT" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

route_side() {
  local service="$1"
  local destination="$2"
  local gateway="$3"
  docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY --user root "$service" \
    ip route replace "$destination" via "$gateway"
}

configure_routes() {
  route_side bolt-a 172.29.20.0/24 172.29.10.2
  route_side ipfs-a 172.29.20.0/24 172.29.10.2
  route_side bolt-b 172.29.10.0/24 172.29.20.2
  route_side ipfs-b 172.29.10.0/24 172.29.20.2
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

mine_blocks() {
  local service="$1"
  local payout="$2"
  local count="$3"
  node_eval "$service" "
    for (let block = 0; block < $count; block++) {
      const template = await fetch('http://127.0.0.1:7333/mining/template', {
        method: 'POST',
        headers: { Authorization: 'Bearer bolt-bats-mining-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutAddress: '$payout' }),
      }).then(r => r.json());
      let nonce = 0;
      for (;; nonce++) {
        const preimage = [template.height, template.timestamp, template.previousHash,
          template.merkleRootPlaceholder, template.stateRoot, template.difficulty, nonce].join(':');
        const hash = new Bun.CryptoHasher('sha256').update(preimage).digest('hex');
        if (BigInt('0x' + hash) <= BigInt('0x' + template.target)) break;
      }
      const result = await fetch('http://127.0.0.1:7333/mining/submit', {
        method: 'POST',
        headers: { Authorization: 'Bearer bolt-bats-mining-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: template.templateId, nonce }),
      }).then(r => r.json());
      if (!result.valid) throw new Error(result.error);
    }
    const info = await fetch('http://127.0.0.1:7333/blockchain/info').then(r => r.json());
    console.log(info.height + ' ' + info.latestBlockHash);
  "
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

wait_for_peer_direction() {
  local service="$1"
  local direction="$2"
  for _ in $(seq 1 60); do
    node_eval "$service" "const t=await fetch('http://127.0.0.1:7336/metrics').then(r=>r.text()); const m=t.match(/^bolt_network_peers_${direction} (\\d+)$/m); if(!m||Number(m[1])<1) process.exit(1)" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

wait_for_log() {
  local service="$1"
  local text="$2"
  for _ in $(seq 1 60); do
    docker compose --project-directory "$PROJECT_ROOT" logs "$service" 2>/dev/null | grep -F "$text" >/dev/null && return 0
    sleep 1
  done
  return 1
}

@test "two nodes synchronize, relay a transaction, and preserve state" {
  run docker compose --project-directory "$PROJECT_ROOT" up --detach --wait --wait-timeout 30 router ipfs-a ipfs-b
  [ "$status" -eq 0 ]

  route_side ipfs-a 172.29.20.0/24 172.29.10.2
  route_side ipfs-b 172.29.10.0/24 172.29.20.2

  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-a ipfs bootstrap list
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-b ipfs bootstrap list
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  ipfs_b_id="$(docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-b ipfs id -f='<id>')"
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-a ipfs swarm connect "/ip4/172.29.20.11/tcp/4001/p2p/$ipfs_b_id"
  [ "$status" -eq 0 ]

  run docker compose --project-directory "$PROJECT_ROOT" up --detach --build bolt-a bolt-b
  [ "$status" -eq 0 ]

  configure_routes

  wait_for_api bolt-a
  wait_for_api bolt-b

  run node_eval bolt-a 'await Bun.dns.lookup("bolt-b").then(()=>process.exit(1),()=>process.exit(0))'
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY bolt-a ip route get 172.29.20.10
  [ "$status" -eq 0 ]
  [[ "$output" == *"via 172.29.10.2"* ]]
  wait_for_log bolt-a "announced tcp endpoint: 172.29.10.10:8333"
  run sh -c "! docker compose --project-directory '$PROJECT_ROOT' logs bolt-b | grep -F 'announced tcp endpoint:'"
  [ "$status" -eq 0 ]
  wait_for_peer_direction bolt-a inbound
  wait_for_peer_direction bolt-b outbound

  target="$(mine_blocks bolt-a 2fQ4Xu3dv16nKNxZfBKkHfC759K79xRpsYC 1)"
  target_height="${target%% *}"
  target_hash="${target#* }"
  [ "$target_height" -ge 1 ]
  wait_for_block bolt-b "$target_height" "$target_hash"

  run env BOLT_A_MINING_ENABLED=false docker compose --project-directory "$PROJECT_ROOT" up --detach --force-recreate bolt-a
  [ "$status" -eq 0 ]
  route_side bolt-a 172.29.20.0/24 172.29.10.2
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

  run docker compose --project-directory "$PROJECT_ROOT" kill --signal SIGKILL bolt-a
  [ "$status" -eq 0 ]
  run env BOLT_A_MINING_ENABLED=false docker compose --project-directory "$PROJECT_ROOT" up --detach bolt-a
  [ "$status" -eq 0 ]
  wait_for_api bolt-a
  wait_for_block bolt-a "$target_height" "$target_hash"

  run docker compose --project-directory "$PROJECT_ROOT" stop bolt-a
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" run --rm --no-deps --user root bolt-a bun run storage backup /data /backups/snapshot
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" --profile tools run --rm --no-deps bolt-recovery bun run storage restore /backups/snapshot /restore/data
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" --profile tools run --rm --no-deps bolt-recovery bun run storage verify /restore/data
  [ "$status" -eq 0 ]

  run env BOLT_A_MINING_ENABLED=false docker compose --project-directory "$PROJECT_ROOT" start bolt-a
  [ "$status" -eq 0 ]
  route_side bolt-a 172.29.20.0/24 172.29.10.2
  wait_for_api bolt-a
  run docker compose --project-directory "$PROJECT_ROOT" stop router
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY bolt-a sh -c \
    "timeout 3 bun -e 'await Bun.connect({hostname:\"172.29.20.10\",port:8333,socket:{data(){}}})'"
  [ "$status" -ne 0 ]

  branch_a="$(mine_blocks bolt-a 2fQ4Xu3dv16nKNxZfBKkHfC759K79xRpsYC 2)"
  branch_b="$(mine_blocks bolt-b 2fWMqcFysx5wtV6KZDZ71a1jZgd2tRd3CcX 3)"
  branch_b_height="${branch_b%% *}"
  branch_b_hash="${branch_b#* }"
  [ "${branch_a%% *}" -lt "$branch_b_height" ]

  run docker compose --project-directory "$PROJECT_ROOT" start router
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY ipfs-a ipfs swarm connect "/ip4/172.29.20.11/tcp/4001/p2p/$ipfs_b_id"
  [ "$status" -eq 0 ]
  run docker compose --project-directory "$PROJECT_ROOT" restart bolt-a bolt-b
  [ "$status" -eq 0 ]
  route_side bolt-a 172.29.20.0/24 172.29.10.2
  route_side bolt-b 172.29.10.0/24 172.29.20.2
  wait_for_api bolt-a
  wait_for_api bolt-b
  wait_for_peer bolt-a
  wait_for_peer bolt-b
  wait_for_block bolt-a "$branch_b_height" "$branch_b_hash"
  wait_for_block bolt-b "$branch_b_height" "$branch_b_hash"
}
