#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /.dockerenv && "${PORTEAU_MYSQL_INTEGRATION:-}" == 1 ]] || { echo 'REFUSING: set PORTEAU_MYSQL_INTEGRATION=1 inside the disposable Compose container.' >&2; exit 90; }
vp test tests/integration/mysql.integration.test.ts
