# Installing Porteau

Porteau requires Node.js 22.18 or newer and the **matching pinned** `mydumper` and `myloader` release. The standalone installer currently selects Node.js 24 and mydumper/myloader 1.0.3-1.

## Supported automated setup

Automatic setup supports Ubuntu 22.04 amd64 and Ubuntu 24.04 amd64 or arm64. Review the checked-in `install.sh` before running it; it downloads a manifest-pinned package, verifies its size and SHA-256, and uses `sudo` for system package changes.

```sh
./install.sh --check       # report only; never downloads or invokes sudo
./install.sh               # interactive confirmation on a TTY
./install.sh --yes         # explicit noninteractive installation
porteau doctor             # verify the resulting environment
```

Node is installed from NodeSource's signed Node 24 repository when the system Node/npm is absent or too old. Existing nvm, asdf, mise, or Volta shims are not replaced; the installer warns when it detects them. Re-running the installer is safe and reports compatible dependencies without mutation.

## Other platforms and manual installation

The automated script intentionally refuses unlisted distributions, releases, and architectures. On those systems:

1. Install Node.js >=22.18 with your platform's trusted package mechanism.
2. Build or install **both** mydumper and myloader version 1.0.3-1 from the upstream mydumper release. Do not mix versions.
3. Put both executables on `PATH`, or configure their absolute paths in Porteau's `tools.mydumper` and `tools.myloader` settings.
4. Run `porteau doctor`; do not run production backups until every tool and platform diagnostic is accepted.

Porteau does not silently broaden platform support: a manually installed platform remains unqualified and should first be exercised against a disposable database.

## Maintainer container qualification

These commands create and mutate **containers only**. They must never be pointed at a host database or run directly as root on a workstation.

```sh
docker compose -f tests/installer/compose.yaml build
docker compose -f tests/installer/compose.yaml run --rm ubuntu-2204
docker compose -f tests/installer/compose.yaml run --rm ubuntu-2404
# opt-in emulated/native ARM qualification:
docker compose -f tests/installer/compose.yaml --profile arm64 run --rm ubuntu-2404-arm64

# MySQL 8.4 + pinned native dump/restore qualification (also disposable):
docker compose -f tests/integration/compose.yaml up --build --abort-on-container-exit --exit-code-from qualification
docker compose -f tests/integration/compose.yaml down -v
```

The integration test is gated by `PORTEAU_MYSQL_INTEGRATION=1`; normal `vp test` discovers it but skips it. Compose supplies that variable only to its isolated qualification service.
