#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.bluegreen.yml"
ENV_FILE="$ROOT_DIR/deploy/.env.bluegreen"
STATE_DIR="$ROOT_DIR/deploy/state"
STATE_FILE="$STATE_DIR/active-color"
KEEP_OLD_STACK="${KEEP_OLD_STACK:-0}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-90}"
SMOKE_INTERVAL="${SMOKE_INTERVAL:-3}"
PROXY_SCHEME="${PROXY_SCHEME:-http}"

mkdir -p "$STATE_DIR"

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
fi

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

die() {
  echo "error: $*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  local default_value="${2:-}"

  if [[ -f "$ENV_FILE" ]]; then
    local value
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- || true)"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return
    fi
  fi

  printf '%s\n' "$default_value"
}

validate_color() {
  local color="${1:-}"
  [[ "$color" == "blue" || "$color" == "green" ]] || die "color must be 'blue' or 'green'"
}

current_color() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  fi
}

opposite_color() {
  local color="$1"
  if [[ "$color" == "blue" ]]; then
    echo "green"
  else
    echo "blue"
  fi
}

service_container_id() {
  compose ps -q "$1"
}

proxy_port() {
  read_env_value "PROXY_HTTP_PORT" "80"
}

proxy_host() {
  local public_base_url
  public_base_url="$(read_env_value "PUBLIC_BASE_URL" "")"

  if [[ -n "$public_base_url" ]]; then
    public_base_url="${public_base_url#http://}"
    public_base_url="${public_base_url#https://}"
    public_base_url="${public_base_url%%/*}"
    printf '%s\n' "$public_base_url"
    return
  fi

  printf '127.0.0.1:%s\n' "$(proxy_port)"
}

proxy_url() {
  printf '%s://%s' "$PROXY_SCHEME" "$(proxy_host)"
}

service_health() {
  local container_id
  container_id="$(service_container_id "$1")"
  if [[ -z "$container_id" ]]; then
    echo "missing"
    return 1
  fi

  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
}

wait_for_service() {
  local service="$1"
  local timeout="${2:-180}"
  local elapsed=0
  local status="missing"

  while (( elapsed < timeout )); do
    status="$(service_health "$service" 2>/dev/null || true)"
    case "$status" in
      healthy|running)
        echo "$service is $status"
        return 0
        ;;
      unhealthy|exited|dead)
        compose logs --no-color "$service" || true
        die "$service entered terminal state: $status"
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  compose logs --no-color "$service" || true
  die "timed out waiting for $service to become healthy"
}

ensure_shared_services() {
  compose up -d postgres redis minio
  wait_for_service postgres 120
  wait_for_service redis 60
  wait_for_service minio 120
}

ensure_color_services() {
  local color="$1"
  validate_color "$color"
  compose up -d --build "runtime-${color}" "web-${color}"
  wait_for_service "runtime-${color}" 240
  wait_for_service "web-${color}" 240
}

switch_proxy() {
  local color="$1"
  validate_color "$color"

  if [[ -z "$(service_container_id proxy)" ]]; then
    ACTIVE_COLOR="$color" compose up -d proxy
    wait_for_service proxy 60
  else
    compose exec -T -e ACTIVE_COLOR="$color" proxy /bin/sh -lc \
      "envsubst '\$ACTIVE_COLOR' < /etc/nginx/templates/active-upstream.conf.template > /etc/nginx/conf.d/active-upstream.conf && nginx -s reload"
    wait_for_service proxy 60
  fi
  echo "proxy now routes to $color"
}

stop_color_services() {
  local color="$1"
  validate_color "$color"
  compose stop "web-${color}" "runtime-${color}" || true
}

command_status() {
  local active
  active="$(current_color || true)"
  echo "Active color: ${active:-none}"
  echo "Proxy URL: $(proxy_url)"
  compose ps
}

smoke_check_endpoint() {
  local url="$1"
  local expected_pattern="${2:-}"
  local body

  body="$(curl --silent --show-error --fail --max-time 10 "$url")" || return 1

  if [[ -n "$expected_pattern" ]] && ! grep -Eq "$expected_pattern" <<<"$body"; then
    return 1
  fi
}

smoke_check_proxy() {
  local base_url
  local deadline
  local now

  base_url="$(proxy_url)"
  deadline=$((SECONDS + SMOKE_TIMEOUT))

  while true; do
    if smoke_check_endpoint "${base_url}/healthz" '^ok$' &&
      smoke_check_endpoint "${base_url}/api/health" '"status"[[:space:]]*:[[:space:]]*"ok"' &&
      smoke_check_endpoint "${base_url}/" 'Bridge Online|Bridge Authorization|The Council'; then
      echo "proxy smoke checks passed at ${base_url}"
      return 0
    fi

    now=$SECONDS
    if (( now >= deadline )); then
      return 1
    fi
    sleep "$SMOKE_INTERVAL"
  done
}

switch_and_smoke() {
  local target="$1"
  local previous="${2:-}"

  switch_proxy "$target"

  if smoke_check_proxy; then
    printf '%s\n' "$target" > "$STATE_FILE"
    echo "active color recorded as $target"
    return 0
  fi

  echo "smoke checks failed after switching to $target" >&2

  if [[ -n "$previous" && "$previous" != "$target" ]]; then
    echo "restoring previous color: $previous" >&2
    switch_proxy "$previous"
    if smoke_check_proxy; then
      printf '%s\n' "$previous" > "$STATE_FILE"
      echo "rollback to $previous succeeded" >&2
    else
      die "rollback switch to $previous also failed smoke checks"
    fi
  fi

  return 1
}

command_deploy() {
  local requested="${1:-auto}"
  local active=""
  local target=""

  active="$(current_color || true)"
  if [[ "$requested" == "auto" ]]; then
    if [[ -z "$active" ]]; then
      target="blue"
    else
      target="$(opposite_color "$active")"
    fi
  else
    validate_color "$requested"
    target="$requested"
  fi

  echo "Deploying color: $target"
  ensure_shared_services
  ensure_color_services "$target"
  switch_and_smoke "$target" "$active" || die "deployment smoke checks failed for $target"

  if [[ -n "$active" && "$active" != "$target" && "$KEEP_OLD_STACK" != "1" ]]; then
    echo "Stopping previous color: $active"
    stop_color_services "$active"
  fi

  command_status
}

command_switch() {
  local target="${1:-}"
  validate_color "$target"
  local active
  active="$(current_color || true)"
  wait_for_service "runtime-${target}" 60
  wait_for_service "web-${target}" 60
  switch_and_smoke "$target" "$active" || die "switch smoke checks failed for $target"
  command_status
}

command_rollback() {
  local active
  active="$(current_color || true)"
  [[ -n "$active" ]] || die "no active color is recorded"
  command_switch "$(opposite_color "$active")"
}

main() {
  local command="${1:-deploy}"
  shift || true

  case "$command" in
    deploy)
      command_deploy "${1:-auto}"
      ;;
    switch)
      command_switch "${1:-}"
      ;;
    rollback)
      command_rollback
      ;;
    status)
      command_status
      ;;
    smoke)
      smoke_check_proxy
      ;;
    *)
      die "unknown command '$command' (expected: deploy, switch, rollback, status, smoke)"
      ;;
  esac
}

main "$@"
