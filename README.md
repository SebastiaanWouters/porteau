# Porteau

Porteau is a safety-first TypeScript CLI for consistent MySQL logical backups and restores using `mydumper` and `myloader`. See [INSTALL.md](INSTALL.md) for supported installation and native-tool setup.

## Interactive use

Run `porteau doctor` first. For a guided backup, use a terminal and omit values you want Porteau to prompt for:

```sh
export PORTEAU_PASSWORD='…'
porteau backup --user backup_operator --database app --output ./backups/app-2026-07-21
```

A backup destination must not already exist. Do not put a password in command arguments, YAML, shell history, or source control: set `PORTEAU_PASSWORD` in the process environment (ideally through a secret manager). Porteau passes native tools a short-lived defaults file rather than a password argument and removes it during cleanup.

Backup filters can omit a table entirely with `exclude.tables` or retain its schema without rows with `exclude.data`. Porteau does not create data-only artifacts: every exported object includes the schema required to restore it safely into a new or staging database.

Restore always resolves and discloses all three policies before approval. Command flags override YAML, which overrides Porteau's safe defaults (`require-empty`, `reject`, and `disable`):

- **Destination:** `require-empty` refuses a populated destination; `allow-existing` permits one.
- **Overwrite:** `reject` preserves existing tables; `drop`, `truncate`, and `delete` authorize the corresponding destructive treatment. A destructive choice is valid only with `allow-existing`.
- **Binary log:** `disable` avoids replay logging; `enable` requires destination binlogging to be available. Artifact metadata cannot override this choice.

Use `porteau restore --help` for the current option spellings. Review the rendered plan and confirm interactively. `--yes` approves the exact resolved plan; it does not bypass artifact verification or destination preflight. Automation should normally pass policy flags explicitly so a configuration change cannot alter its intended policy.

Press Ctrl-C or cancel a prompt to stop. Porteau forwards cancellation to the native process tree, waits for termination, and cleans partial backup state and temporary credential files. Cancellation is best effort at the database boundary: statements already committed by MySQL during a restore are not rolled back as one transaction. Inspect the destination before retrying.

## Non-interactive JSONL automation

Automation must supply the artifact and database inputs, use environment-only credentials, disable prompts, approve the resolved plan, and consume stdout as JSON Lines:

```sh
PORTEAU_PASSWORD="$BACKUP_PASSWORD" porteau backup \
  --no-interactive --json \
  --user backup_operator --database app \
  --output ./backups/app-2026-07-21 >backup.events.jsonl

PORTEAU_PASSWORD="$RESTORE_PASSWORD" porteau restore \
  --no-interactive --json --yes \
  --user restore_operator \
  --artifact ./backups/app-2026-07-21 \
  --source-database app --destination-database app_restore \
  --destination-policy require-empty \
  --overwrite-policy reject --binlog-policy disable \
  >restore.events.jsonl
```

Check `porteau restore --help` for the installed version. Keep JSONL on stdout machine-readable; send it directly to a parser or durable log. Human diagnostics go to stderr. Treat a nonzero exit or an interrupted/incomplete event stream as failure. Send SIGINT/SIGTERM for cancellation and wait for the command to exit before retrying.

`--json` implies non-interactive operation and cannot be combined with human `--quiet`/`--verbose` rendering. `--yes` only records approval where approval is supported; CI still needs complete credentials, artifact selection, and destination inputs.

## Result terminology

- **Artifact-valid** means Porteau completed its atomic publication checks and the backup artifact/manifest is structurally valid. It does **not** prove that every application invariant is correct or that a future restore will work in a different environment.
- **Operationally verified** means an operator restored the artifact into an isolated, compatible MySQL destination and performed application-specific checks (row counts, checksums, migrations, and representative reads). Only a restore drill can establish this stronger claim.

Retain JSONL and manifest evidence, monitor backup age, and schedule isolated restore drills. Never call an artifact operationally verified solely because backup exited successfully.

## Supported boundaries

- Node.js 22.18 or newer; the committed CI matrix targets Node 22.18 and Node 24 and must pass before release.
- Supported automatic-installation targets are limited to the Ubuntu releases and architectures listed in [INSTALL.md](INSTALL.md); their committed external matrices must pass before release.
- MySQL 8.4 with the matching pinned `mydumper`/`myloader` pair is the supported integration target. Its committed guarded round trip must pass before release. Native tools remain external executables and must be diagnosed with `porteau doctor`.
- Consistent production backup requires InnoDB. Selected nontransactional tables are rejected; system databases are not restore targets. Unsupported TLS certificate configuration and unlisted platforms are not silently accepted.
- Shell completion is not provided in v1. Citty does not currently expose a stable generated-completion contract, and Porteau will not install an ad-hoc completion script that could drift from safety checks.

Standalone Node 26 executable packaging is **non-blocking/deferred**. Vite+/tsdown executable packaging remains experimental, while `mydumper` and `myloader` must remain external native tools. The supported release artifact is therefore the Node package containing `dist/cli.mjs`, not a standalone binary.
