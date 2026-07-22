#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  cat <<'EOF'
Usage: scripts/verify-external.sh [all|mysql|ubuntu-2204|ubuntu-2404|ubuntu-2404-arm64]

With no argument, runs MySQL and the installer targets native to this machine.
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
installer_project=''

cleanup_mysql() {
  docker compose --project-name "$mysql_project" -f tests/integration/compose.yaml down -v
}

cleanup_installer() {
  docker compose --project-name "$installer_project" -f tests/installer/compose.yaml down -v
}

mysql() {
  local compose=(
    docker compose --project-name "$mysql_project" -f tests/integration/compose.yaml
  )
  trap cleanup_mysql EXIT
  "${compose[@]}" up --build --abort-on-container-exit --exit-code-from qualification
  cleanup_mysql
  trap - EXIT
}

installer() {
  local service="$1"
  installer_project="${project_base}-${service}"
  local compose=(
    docker compose --project-name "$installer_project" -f tests/installer/compose.yaml
  )
  if [[ "$service" == ubuntu-2404-arm64 ]]; then
    compose+=(--profile arm64)
  fi
  trap cleanup_installer EXIT
  "${compose[@]}" build "$service"
  local run=("${compose[@]}" run --rm)
  [[ "${PORTEAU_RELEASE_TEST:-0}" == 1 ]] && run+=(-e PORTEAU_RELEASE_TEST=1)
  [[ -n "${PORTEAU_INSTALL_URL:-}" ]] && run+=(-e "PORTEAU_INSTALL_URL=$PORTEAU_INSTALL_URL")
  "${run[@]}" "$service"
  cleanup_installer
  trap - EXIT
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
    mysql
    case "$(uname -m)" in
      x86_64 | amd64)
        installer ubuntu-2204
        installer ubuntu-2404
        echo 'Ubuntu 24.04 arm64 is qualified separately on the native CI runner.'
        ;;
      aarch64 | arm64) installer ubuntu-2404-arm64 ;;
      *)
        echo "No installer qualification is defined for host architecture $(uname -m)." >&2
        exit 1
        ;;
    esac
    ;;
  --help | -h) usage ;;
  *) usage >&2; exit 2 ;;
esac
