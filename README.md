# Porteau

Porteau is a safety-first CLI for consistent MySQL logical backups and restores with `mydumper` and `myloader`. It validates the database and native tools before execution, publishes backup artifacts atomically, and discloses the resolved restore policy before requiring approval to change a destination.

Porteau is an alpha release. Test backups and restores against disposable databases before production use.

## Installation

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/SebastiaanWouters/porteau/main/install.sh | bash
```

Ubuntu 22.04 amd64 and Ubuntu 24.04 amd64/arm64. Shows a plan before changing the system. Add `| bash -s -- --yes` for unattended installs.

Other platforms: install Node.js 22.18+, matching mydumper/myloader, then
`npm install --global --prefix "$HOME/.local" --ignore-scripts porteau@next`.

Older alphas: download `install.sh` from a [GitHub release](https://github.com/SebastiaanWouters/porteau/releases), or `porteau@X.Y.Z-alpha.N`.

## Quick start

Create a configuration, inspect the effective result, and run the read-only environment diagnostics:

```sh
porteau init --user backup_operator --database app
porteau config
porteau doctor
```

Porteau reads `porteau.config.yaml` from the working directory by default. Use `--config <file>` to select another YAML file. Command flags override environment variables, which override YAML and then safe defaults. Supported environment variables are `PORTEAU_HOST`, `PORTEAU_PORT`, `PORTEAU_USER`, `PORTEAU_PASSWORD`, `PORTEAU_MYDUMPER`, and `PORTEAU_MYLOADER`.

Create a backup:

```sh
export PORTEAU_PASSWORD='…'
porteau backup \
  --user backup_operator \
  --database app \
  --output ./backups/app-2026-07-21
```

The final output directory must not exist. Porteau writes to a temporary sibling directory, validates native completion and artifact metadata, then publishes the artifact atomically. On failure or cancellation it removes partial output and temporary credentials.

Default backups use mydumper's lock-based consistency strategy and need global privileges. If you only have database-scoped grants, opt into `no-lock`:

```yaml
backup:
  consistency:
    mode: no-lock
    protectDdl: false
```

`no-lock` still requires `SELECT` (plus `SHOW VIEW` / `TRIGGER` when those objects are enabled). It does not need `REPLICATION CLIENT`. It does not guarantee a consistent snapshot across concurrent writes.

Restore into a new or staging database and review the disclosed plan before confirming:

```sh
export PORTEAU_PASSWORD='…'
porteau restore \
  --user restore_operator \
  --artifact ./backups/app-2026-07-21 \
  --database app \
  --destination-database app_restore
```

Use `porteau <command> --help` for the complete, version-matched option reference.

## Restore safety

Restore resolves three policies from command flags, YAML, or these safe defaults:

| Policy          | Default         | Alternatives                 |
| --------------- | --------------- | ---------------------------- |
| Destination     | `require-empty` | `allow-existing`             |
| Existing tables | `reject`        | `drop`, `truncate`, `delete` |
| Binary log      | `disable`       | `enable`                     |

A destructive existing-table policy is valid only with `allow-existing`. `--yes` approves the disclosed plan; it does not bypass artifact verification or destination preflight. Artifact metadata cannot override the binary-log policy.

Backup filters can omit an object with `exclude.tables` or retain its schema without rows with `exclude.data`. Porteau rejects data-only artifacts because they cannot be restored safely into a new database.

Keep passwords out of command arguments, YAML, shell history, and source control. Prefer `PORTEAU_PASSWORD` supplied by a secret manager. Porteau gives native tools a short-lived defaults file, removes the password from their environment, and cleans the file after execution.

Cancellation is best effort at the database boundary: Porteau terminates the native process tree and cleans local temporary state, but MySQL statements already committed during a restore are not rolled back as one transaction. Inspect the destination before retrying.

## Automation

Use `--json` for JSON Lines on stdout; human diagnostics remain on stderr. JSON mode implies `--no-interactive` and cannot be combined with `--quiet` or `--verbose`.

```sh
PORTEAU_PASSWORD="$BACKUP_PASSWORD" porteau backup \
  --json --user backup_operator --database app \
  --output ./backups/app-2026-07-21 >backup.events.jsonl

PORTEAU_PASSWORD="$RESTORE_PASSWORD" porteau restore \
  --json --yes --user restore_operator \
  --artifact ./backups/app-2026-07-21 \
  --database app --destination-database app_restore \
  --destination-policy require-empty \
  --overwrite-policy reject --binlog-policy disable \
  >restore.events.jsonl
```

Treat a nonzero exit or incomplete event stream as failure. Exit codes are `1` for operational failure, `2` for invalid usage, and `130` for cancellation.

A completed backup is **artifact-valid**: its process, event stream, files, and manifest agreed. It is not operationally verified until it has been restored into an isolated compatible destination and checked with application-specific assertions such as row counts, checksums, migrations, and representative reads.

## Supported boundaries

- The committed release matrix targets Node.js 22.18 and 24.
- Automatic installation is limited to the Ubuntu releases and architectures listed above.
- The supported integration target is MySQL 8.4 and the reviewed mydumper/myloader contract. Run `doctor` before production use.
- Nontransactional selected tables and system-database restore destinations are rejected.
- CA-verified TLS modes are unavailable until certificate-path configuration is implemented.
- Shell completion and standalone executable packaging are not provided in v1.

## Development

Use the same verification entry points as CI:

```sh
vp run verify           # shellcheck (if installed), check, test, build, package smoke
vp run verify:external  # optional Docker MySQL + installer matrices
vp run package:dry-run  # package construction only; does not publish
```

Installer behavior is covered in unit tests (`tests/installer.test.ts`). `verify:external` is for disposable end-to-end Docker checks before a release, not the default gate.
