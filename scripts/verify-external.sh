#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

usage() {
  cat <<'EOF'
Usage: scripts/verify-external.sh [all|mysql|ubuntu-2204|ubuntu-2404|ubuntu-2404-arm64]

With no argument, runs MySQL and the installer targets native to this machine in parallel.
Run an explicit target to reproduce its corresponding CI qualification job.
EOF
}

command -v docker >/dev/null 2>&1 || {
  echo 'Docker is required for external qualification.' >&2
  exit 1
}
docker compose version >/dev/null

project_base="${PORTEAU_COMPOSE_PROJECT:-porteau-${UID:-0}-$$}"
mysql_project="${project_base}-mysql"

declare -a COMPOSE_PROJECTS=()

register() {
  COMPOSE_PROJECTS+=("$1:$2")
}

cleanup() {
  local entry project file
  for entry in "${COMPOSE_PROJECTS[@]}"; do
    project="${entry%%:*}"
    file="${entry#*:}"
    docker compose --project-name "$project" -f "$file" down -v || true
  done
}

trap cleanup EXIT

installer_compose() {
  local -a files=(-f tests/installer/compose.yaml)
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    files+=(-f tests/installer/compose.cache.yaml)
  fi
  printf '%s\n' "${files[@]}"
}

mysql_compose() {
  local -a files=(-f tests/integration/compose.yaml)
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    files+=(-f tests/integration/compose.cache.yaml)
  fi
  printf '%s\n' "${files[@]}"
}

mysql() {
  local -a files
  mapfile -t files < <(mysql_compose)
  local compose=(docker compose --project-name "$mysql_project" "${files[@]}")
  register "$mysql_project" tests/integration/compose.yaml
  "${compose[@]}" up --build --abort-on-container-exit --exit-code-from qualification
}

installer() {
  local service="$1"
  local installer_project="${project_base}-${service}"
  local -a files
  mapfile -t files < <(installer_compose)
  local compose=(docker compose --project-name "$installer_project" "${files[@]}")
  if [[ "$service" == ubuntu-2404-arm64 ]]; then
    compose+=(--profile arm64)
  fi
  register "$installer_project" tests/installer/compose.yaml
  "${compose[@]}" build "$service"
  local run=("${compose[@]}" run --rm)
  [[ "${PORTEAU_RELEASE_TEST:-0}" == 1 ]] && run+=(-e PORTEAU_RELEASE_TEST=1)
  [[ -n "${PORTEAU_INSTALL_URL:-}" ]] && run+=(-e "PORTEAU_INSTALL_URL=$PORTEAU_INSTALL_URL")
  "${run[@]}" "$service"
}

run_parallel() {
  local -a pids=()
  local -a labels=()
  local -a statuses=()
  local label pid status failed=0

  for label in "$@"; do
    labels+=("$label")
    case "$label" in
      mysql) mysql & ;;
      ubuntu-2204 | ubuntu-2404 | ubuntu-2404-arm64) installer "$label" & ;;
      *) echo "unknown parallel target: $label" >&2; return 2 ;;
    esac
    pids+=("$!")
  done

  for pid in "${pids[@]}"; do
    status=0
    wait "$pid" || status=$?
    statuses+=("$status")
  done

  for i in "${!labels[@]}"; do
    if [[ "${statuses[$i]}" -ne 0 ]]; then
      echo "external qualification failed: ${labels[$i]} (exit ${statuses[$i]})" >&2
      failed=1
    fi
  done
  return "$failed"
}

target="${1:-all}"
case "$target" in
  mysql) mysql ;;
  ubuntu-2204 | ubuntu-2404) installer "$target" ;;
  ubuntu-2404-arm64)
    case "$(uname -m)" in
      aarch64 | arm64) installer "$target" ;;
      *) echo 'Ubuntu 24.04 arm64 qualification requires a native arm64 host.' >&2; exit 1 ;;
    esac
    ;;
  all)
    case "$(uname -m)" in
      x86_64 | amd64)
        run_parallel mysql ubuntu-2204 ubuntu-2404
        echo 'Ubuntu 24.04 arm64 is qualified separately on the native CI runner.'
        ;;
      aarch64 | arm64) run_parallel mysql ubuntu-2404-arm64 ;;
      *)
        echo "No installer qualification is defined for host architecture $(uname -m)." >&2
        exit 1
        ;;
    esac
    ;;
  --help | -h) usage ;;
  *) usage >&2; exit 2 ;;
esac
