#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /.dockerenv ]] || { echo 'REFUSING: this destructive qualification must run in a disposable container.' >&2; exit 90; }
if [[ -n "${PORTEAU_INSTALL_URL:-}" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL "$PORTEAU_INSTALL_URL" | bash -s -- --yes
  exit
fi
shellcheck install.sh scripts/verify-external.sh scripts/release-publish-npm.sh \
  scripts/release-publish-github.sh tests/installer/container-test.sh tests/integration/run.sh
export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"
bats tests/installer/installer.bats
mode=(--dependencies-only)
[[ "${PORTEAU_RELEASE_TEST:-0}" == 1 ]] && mode=()
./install.sh "${mode[@]}" --yes
./install.sh "${mode[@]}" --yes
