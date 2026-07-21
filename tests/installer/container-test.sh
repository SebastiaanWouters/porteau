#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /.dockerenv ]] || { echo 'REFUSING: this destructive qualification must run in a disposable container.' >&2; exit 90; }
shellcheck install.sh tests/installer/container-test.sh tests/integration/run.sh
bats tests/installer/installer.bats
./install.sh --yes
./install.sh --yes
