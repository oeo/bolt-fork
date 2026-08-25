#!/usr/bin/env bats

setup() {
  export PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export COMPOSE_PROJECT_NAME="bolt-bats-$$"
  export COMPOSE_FILE="$PROJECT_ROOT/docker-compose.bats.yml"
}

teardown() {
  docker compose --project-directory "$PROJECT_ROOT" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

wait_for_api() {
  for _ in $(seq 1 60); do
    docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY bolt \
      curl --fail --silent http://127.0.0.1:7333/health >/dev/null 2>&1 && return 0
    sleep 1
  done

  docker compose --project-directory "$PROJECT_ROOT" logs bolt >&2
  return 1
}

@test "node preserves genesis across restart" {
  run docker compose --project-directory "$PROJECT_ROOT" up --detach --build
  [ "$status" -eq 0 ]

  wait_for_api

  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY bolt \
    curl --fail --silent http://127.0.0.1:7333/blocks/0
  [ "$status" -eq 0 ]
  genesis="$output"

  run docker compose --project-directory "$PROJECT_ROOT" restart bolt
  [ "$status" -eq 0 ]
  wait_for_api

  run docker compose --project-directory "$PROJECT_ROOT" exec --no-TTY bolt \
    curl --fail --silent http://127.0.0.1:7333/blocks/0
  [ "$status" -eq 0 ]
  [ "$output" = "$genesis" ]
}
