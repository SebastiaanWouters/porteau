#!/usr/bin/env bash
# Fast static check for shell entrypoints. Skips when shellcheck is not installed
# so local verify stays usable; CI installs shellcheck before verify.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo 'shellcheck not installed; skipping shell script lint (CI installs it).'
  exit 0
fi

shellcheck \
  install.sh \
  scripts/install.sh.template \
  scripts/verify-external.sh \
  scripts/release-publish-npm.sh \
  scripts/release-publish-github.sh \
  scripts/check-shell.sh \
  tests/installer/container-test.sh \
  tests/integration/run.sh
