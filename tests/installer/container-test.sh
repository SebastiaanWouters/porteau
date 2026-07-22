#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /.dockerenv ]] || { echo 'REFUSING: this destructive qualification must run in a disposable container.' >&2; exit 90; }
if [[ -n "${PORTEAU_INSTALL_URL:-}" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL "$PORTEAU_INSTALL_URL" | bash -s -- --yes
  exit
fi
export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"
bats tests/installer/installer.bats
if [[ "${PORTEAU_RELEASE_TEST:-0}" == 1 ]]; then
  ./install.sh --yes
  ./install.sh --yes
  exit
fi
# Image build already ran a cold --dependencies-only install; assert the mounted
# install.sh is an idempotent no-op against that environment.
./install.sh --dependencies-only --yes
