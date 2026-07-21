#!/usr/bin/env bats

setup() {
  [[ -f /etc/os-release ]] && . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || skip "installer tests require a disposable Ubuntu container"
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fake="$BATS_TEST_TMPDIR/fake-bin"
  rm -rf "$fake"
  mkdir -p "$fake"
  make_fake dpkg 'echo amd64'
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
  make_fake node "[ \"\$1\" = -e ] && exit 0; echo v24.0.0"
  make_fake npm 'echo 11.0.0'
  make_fake mydumper 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "mydumper v1.0.3-1, built against MySQL 8.0.0 with SSL support"; fi'
  make_fake myloader 'if [ "$1" = --help ]; then echo --machine-log-json; else echo "myloader v1.0.3-1, built against MySQL 8.0.0 with SSL support"; fi'
}

@test "compatible dependencies require no mutation" {
  compatible
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
  [ "$status" -eq 1 ]; [[ "$output" == *"Post-install verification failed"* ]]
}
