# Installing Porteau

Porteau requires Node.js 22.18 or newer and matching `mydumper` and `myloader` versions at 1.0.3-1 or newer. The standalone installer currently selects Node.js 24 and the reviewed mydumper/myloader 1.0.3-1 package.

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
2. Build or install **both** mydumper and myloader at version 1.0.3-1 or newer from the upstream mydumper releases. Do not mix versions.
3. Put both executables on `PATH`, or configure their absolute paths in Porteau's `tools.mydumper` and `tools.myloader` settings.
4. Run `porteau doctor`; do not run production backups until every tool and platform diagnostic is accepted.

Porteau does not silently broaden platform support: a manually installed platform remains unqualified and should first be exercised against a disposable database.

## Maintainer container qualification

These commands create and mutate **containers only**. They must never be pointed at a host database or run directly as root on a workstation.

```sh
vp run verify:external    # MySQL and installer targets native to this machine
vp run verify:mysql       # MySQL 8.4 + pinned native dump/restore only
vp run verify:installers  # Ubuntu 22.04 and 24.04 amd64 installers only

# Explicit native ARM qualification on an arm64 host (normally run by CI):
bash scripts/verify-external.sh ubuntu-2404-arm64
```

The wrapper always tears down the disposable MySQL services and volumes after a completed run. The integration test is gated by `PORTEAU_MYSQL_INTEGRATION=1`; normal `vp test` discovers it but skips it. Compose supplies that variable only to its isolated qualification service.
