#!/usr/bin/env bats

setup() {
  [[ -f /etc/os-release ]] && . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || skip "installer tests require a disposable Ubuntu container"
  source_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  # apt bats may omit BATS_TEST_TMPDIR; never expand an empty root to /.
  tmp="${BATS_TEST_TMPDIR:-${BATS_TMPDIR:-}}"
  if [[ -z "$tmp" || ! -d "$tmp" || ! -w "$tmp" ]]; then
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/porteau-bats.XXXXXX")"
  fi
  BATS_TEST_TMPDIR="$tmp"
  porteau_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$source_root/package.json" | head -n 1)"
  [[ -n "$porteau_version" ]] || {
    echo 'Unable to read package.json version' >&2
    return 1
  }
  root="$BATS_TEST_TMPDIR/dependencies-only"
  mkdir -p "$root"
  printf '#!/bin/sh\nexec bash %q --dependencies-only "$@"\n' "$source_root/install.sh" >"$root/install.sh"
  chmod +x "$root/install.sh"
  fake="$BATS_TEST_TMPDIR/fake-bin"
  rm -rf "$fake"
  mkdir -p "$fake"
  make_fake dpkg 'if [ "$1" = --print-architecture ]; then echo amd64; else /usr/bin/dpkg "$@"; fi'
  expected_size=9624536
  if [[ "${VERSION_ID:-}" == 22.04 ]]; then
    expected_size=1627788
  fi
}

make_fake() {
  printf '#!/bin/sh\n%s\n' "$2" >"$fake/$1"
  chmod +x "$fake/$1"
}

compatible() {
  make_fake node "if [ \"\$1\" = -e ]; then case \"\$2\" in *p.name*) printf 'porteau@${porteau_version} dist/cli.mjs';; esac; exit 0; fi; echo v24.0.0"
  make_fake npm 'echo 11.0.0'
  make_fake mydumper 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "mydumper v1.0.3-1, built against MySQL 8.0.0 with SSL support"; fi'
  make_fake myloader 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "myloader v1.0.3-1, built against MySQL 8.0.0 with SSL support"; fi'
}

fake_porteau_install() {
  make_fake npm "case \"\$1\" in --version) echo 11.0.0;; view) echo '${porteau_version}';; install) package=\"\$HOME/.local/lib/node_modules/porteau\"; mkdir -p \"\$package/dist\" \"\$HOME/.local/bin\"; printf '{\"name\":\"porteau\",\"version\":\"${porteau_version}\",\"bin\":{\"porteau\":\"dist/cli.mjs\"}}' >\"\$package/package.json\"; printf '#!/bin/sh\\ncase \"\$1\" in --version) echo ${porteau_version};; doctor) exit 0;; *) exit 1;; esac\\n' >\"\$package/dist/cli.mjs\"; chmod +x \"\$package/dist/cli.mjs\"; ln -sf ../lib/node_modules/porteau/dist/cli.mjs \"\$HOME/.local/bin/porteau\";; *) exit 91;; esac"
}

@test "released installer installs the exact package and verifies an idempotent rerun" {
  compatible
  fake_porteau_install
  make_fake sudo 'exit 99'

  run env HOME="$HOME" PATH="$fake:/usr/bin:/bin" bash "$source_root/install.sh" --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Porteau ${porteau_version} and all dependencies installed and verified."* ]]

  make_fake npm 'if [ "$1" = --version ]; then echo 11.0.0; else exit 98; fi'
  run env HOME="$HOME" PATH="$fake:/usr/bin:/bin" bash "$source_root/install.sh" --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Porteau ${porteau_version} and all dependencies are ready."* ]]
}

compatible_newer() {
  compatible
  make_fake mydumper 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "mydumper v1.0.4-1, built against MySQL 8.0.0 with SSL support"; fi'
  make_fake myloader 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "myloader v1.0.4-1, built against MySQL 8.0.0 with SSL support"; fi'
}

@test "compatible dependencies require no mutation" {
  compatible
  make_fake curl 'exit 99'; make_fake sudo 'exit 98'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 0 ]
  [[ "$output" == *"All dependencies are compatible."* ]]
}

@test "matching newer tools require no mutation" {
  compatible_newer
  make_fake curl 'exit 99'; make_fake sudo 'exit 98'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 0 ]
  [[ "$output" == *"All dependencies are compatible."* ]]
}

@test "--check reports missing dependencies without curl or sudo" {
  make_fake node 'exit 1'; make_fake npm 'exit 1'
  make_fake mydumper 'exit 1'; make_fake myloader 'exit 1'
  make_fake curl 'echo MUTATED >&2; exit 97'; make_fake sudo 'echo MUTATED >&2; exit 96'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"Check only: no changes made."* ]]
  [[ "$output" == *"Repository: deb [signed-by="* ]]
  [[ "$output" == *"sudo apt-get update"* ]]
  [[ "$output" == *"apt-cache madison nodejs"* ]]
  [[ "$output" == *"nodejs=<validated NodeSource 24 candidate>"* ]]
  [[ "$output" != *MUTATED* ]]
}

@test "conflicting and unknown arguments are rejected" {
  run bash "$root/install.sh" --check --yes
  [ "$status" -eq 2 ]
  run bash "$root/install.sh" --wat
  [ "$status" -eq 2 ]
}

@test "strict tool version mismatch needs installation" {
  compatible
  make_fake myloader 'echo "myloader v1.0.3, built against MySQL 8.0.0 with SSL support"'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"Check only"* ]]
}

@test "supported but mismatched tools are rejected without an automatic downgrade" {
  compatible_newer
  make_fake myloader 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "myloader v1.0.3-1, built against MySQL 8.0.0 with SSL support"; fi'
  make_fake curl 'echo MUTATED >&2; exit 97'; make_fake sudo 'echo MUTATED >&2; exit 96'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"will not downgrade"* ]]
  [[ "$output" != *MUTATED* ]]
}

@test "a newer tool with a missing peer is rejected without an automatic downgrade" {
  compatible_newer
  make_fake myloader 'exit 1'
  make_fake curl 'echo MUTATED >&2; exit 97'; make_fake sudo 'echo MUTATED >&2; exit 96'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"will not downgrade"* ]]
  [[ "$output" != *MUTATED* ]]
}

@test "well-formed tools below the minimum need installation" {
  compatible
  make_fake mydumper 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "mydumper v1.0.2-99, built against MySQL 8.0.0 with SSL support"; fi'
  make_fake myloader 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "myloader v1.0.2-99, built against MySQL 8.0.0 with SSL support"; fi'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"Check only"* ]]
}

@test "missing mydumper and missing myloader are diagnosed independently" {
  compatible
  make_fake mydumper 'exit 1'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]
  compatible
  make_fake myloader 'exit 1'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]
}

@test "missing and incompatible Node plus user-managed runtimes are reported" {
  compatible; make_fake node 'exit 1'
  run env PATH="$fake:/usr/bin:/bin" VOLTA_HOME=/volta bash "$root/install.sh" --check
  [ "$status" -eq 1 ]; [[ "$output" == *"Node.js target: 24"* ]]; [[ "$output" == *VOLTA_HOME* ]]
  compatible; make_fake node 'if [ "$1" = -e ]; then exit 1; fi; echo v20.0.0'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --check
  [ "$status" -eq 1 ]; [[ "$output" == *"Node.js target: 24"* ]]
}

@test "noninteractive mutation is refused without --yes" {
  make_fake node 'exit 1'; make_fake npm 'exit 1'; make_fake mydumper 'exit 1'; make_fake myloader 'exit 1'
  run setsid env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" </dev/null
  [ "$status" -eq 1 ]
  [[ "$output" == *"No TTY"* ]]
}

@test "unsupported architecture is rejected before mutation" {
  make_fake dpkg 'echo s390x'; make_fake curl 'echo MUTATED; exit 1'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"Supported targets:"* ]]
  [[ "$output" != *MUTATED* ]]
}

@test "download failure cleans temporary state without sudo" {
  compatible; make_fake mydumper 'exit 1'
  temporary="$BATS_TEST_TMPDIR/download"
  make_fake mktemp "mkdir -p '$temporary'; echo '$temporary'"
  make_fake curl 'exit 22'; make_fake sudo 'echo MUTATED >&2; exit 99'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -ne 0 ]; [ ! -e "$temporary" ]; [[ "$output" != *MUTATED* ]]
}

@test "checksum mismatch is rejected before sudo" {
  compatible; make_fake mydumper 'exit 1'
  make_fake curl 'output=""; while [ "$#" -gt 0 ]; do [ "$1" = --output ] && { shift; output="$1"; }; shift; done; : >"$output"'
  make_fake stat "echo $expected_size"
  make_fake sha256sum 'exit 1'; make_fake sudo 'echo MUTATED >&2; exit 99'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]; [[ "$output" == *"checksum mismatch"* ]]; [[ "$output" != *MUTATED* ]]
}

@test "apt and post-install verification failures are nonzero" {
  compatible; make_fake mydumper 'exit 1'
  make_fake curl 'output=""; while [ "$#" -gt 0 ]; do [ "$1" = --output ] && { shift; output="$1"; }; shift; done; : >"$output"'
  make_fake stat "echo $expected_size"; make_fake sha256sum 'exit 0'; make_fake sudo 'exit 42'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 42 ]

  make_fake sudo 'exit 0'
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]; [[ "$output" == *"Post-install dependency verification failed"* ]]
}

@test "post-install verification rejects supported but mismatched tools" {
  compatible
  state="$BATS_TEST_TMPDIR/installed"
  make_fake mydumper "if [ \"\$1\" = --help ]; then echo --machine-log-json; elif [ -e '$state' ]; then echo 'mydumper v1.0.4-1, built against MySQL 8.0.0 with SSL support'; else echo 'mydumper v1.0.2-99, built against MySQL 8.0.0 with SSL support'; fi"
  make_fake myloader "if [ \"\$1\" = --help ]; then echo --machine-log-json; elif [ -e '$state' ]; then echo 'myloader v1.0.3-1, built against MySQL 8.0.0 with SSL support'; else echo 'myloader v1.0.2-99, built against MySQL 8.0.0 with SSL support'; fi"
  make_fake curl 'output=""; while [ "$#" -gt 0 ]; do [ "$1" = --output ] && { shift; output="$1"; }; shift; done; : >"$output"'
  make_fake stat "echo $expected_size"
  make_fake sha256sum 'exit 0'
  make_fake sudo "touch '$state'"
  run env PATH="$fake:/usr/bin:/bin" bash "$root/install.sh" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"Post-install dependency verification failed"* ]]
}
