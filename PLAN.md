# Porteau — Comprehensive Implementation Plan

## 1. Product identity

- **Name:** Porteau
- **Domain:** `porteau.dev`
- **Purpose:** A safe, fast, easy-to-use command-line layer over `mydumper` and `myloader` for MySQL logical backups and restores.
- **Primary users:** Developers, operators, and DBAs who need portable logical exports without learning the complete mydumper/myloader option surface.

### Product promise

Porteau provides:

- Online, transactionally consistent InnoDB backups.
- A brief, bounded startup synchronization lock rather than a full-backup write lock.
- Continued application DML during the main export phase.
- Parallel table and chunk processing with conservative production defaults.
- Independent schema and data inclusion/exclusion rules.
- Clear progress, actionable failures, and machine-readable output.
- Scriptable commands with optional guided prompts.
- Guarded, parallel restores into new or staging destinations.

Porteau must **not** promise a zero-impact dump from a writable primary. A logical export still consumes CPU, storage I/O, buffer-pool capacity, network bandwidth, and InnoDB undo history. During startup, writes can briefly wait while dump workers establish the same snapshot. DDL can be blocked for the duration of the backup.

When zero primary write interruption is required, Porteau recommends and supports running against a dedicated read replica.

---

## 2. Final stack

| Layer | Choice | Decision |
|---|---|---|
| Toolchain | Vite+ (`vp`) | Development, checks, tests, build, and packaging |
| Production build | `vp pack` / tsdown | ESM npm CLI as the primary artifact |
| Runtime | Node.js `>=22.18.0` | Required by the primary npm distribution |
| CLI framework | citty | Commands, options, positional arguments, and help |
| Interactive prompts | `@clack/prompts` | Guided input, confirmation, cancellation, spinner, progress, and task log |
| Human logging | consola | Normal, quiet, verbose, and non-interactive output |
| Configuration | c12 + Porteau merger | YAML discovery with replacement precedence and Valibot validation |
| Validation | Valibot | Runtime validation of config, flags, manifests, and normalized events |
| MySQL protocol | `mysql2` 3.23.0 | Catalog, privilege, capability, and destination preflight queries without depending on the `mysql` CLI |
| Structured errors | nostics.dev | Actionable domain errors rendered at the CLI boundary |
| Backup engine | mydumper/myloader v1 | Pinned, capability-tested external binaries |
| Full-screen terminal UI | None | Conventional terminal output is simpler and more portable |

### CLI UX boundary

- **citty** owns command structure and parsing.
- **`@clack/prompts`** owns interactive moments.
- **consola** owns human logs and non-interactive status.
- Core backup and restore modules emit normalized typed events and never import Clack or consola.
- Clack and consola must not write transient output simultaneously.
- Every interactive operation must have an equivalent flag/config/environment path.

---

## 3. Backup engine decision

### Why mydumper/myloader is the v1 engine

Mydumper/myloader best matches Porteau’s distinguishing requirements:

1. **Independent per-table object scopes.** A table can export schema, data, triggers, all objects, or nothing in one consistent run.
2. **Versioned machine output.** For the pinned binaries, `--machine-log-json` emits schema/event version 1 JSON Lines on stderr with qualified success, failure, warning, lock, progress, completion, and cancellation behavior represented by redacted fixtures.
3. **Production controls.** It exposes lock modes, transactional-only behavior, adaptive chunking, per-table concurrency, query-duration targets, and workload-aware throttling.
4. **Manageable artifacts.** It creates separate metadata, schema, and data files that remain inspectable and portable.
5. **Broader server compatibility.** Its implementation recognizes Oracle MySQL, Percona Server, MariaDB, RDS/Aurora, Google-hosted MySQL, and TiDB, although Porteau will still capability-test rather than claim universal support.

Initial supported engine release:

```text
mydumper: v1.0.3-1
myloader: v1.0.3-1
machine log: only explicitly supported schema/event versions
```

Porteau must not automatically adopt a newer engine merely because GitHub marks it latest. Engine upgrades require a reviewed compatibility-manifest change and integration tests.

### MySQL Shell comparison

MySQL Shell remains a credible future backend, not the v1 default.

| Area | mydumper/myloader | MySQL Shell |
|---|---|---|
| Per-table schema/data scope | Native in one dump | DDL-only/data-only controls are global |
| Machine integration | Explicit versioned event contract | JSON-capable console progress, but less engine-specific |
| Production throttling | MySQL-status-aware adaptive throttle | Static bytes-per-thread `maxRate` |
| Restore resume | Available but basic | Detailed progress journal and polished resume |
| Cloud storage | External upload/streaming needed | Built-in S3, Azure, and OCI support |
| Users and grants | Not the primary focus | Built-in instance export support |
| Compatibility tooling | Porteau must provide it | Built-in MySQL upgrade/HeatWave checks |
| Maintenance | Community maintained | Oracle maintained |
| Output | SQL-oriented schema/data artifacts | SQL DDL plus loader-oriented text chunks |

Porteau’s `exclude.schema` and `exclude.data` rules are decisive. Reproducing them with MySQL Shell would require separate operations with global `ddlOnly`/`dataOnly` behavior, which would not naturally share one snapshot.

Do not claim mydumper is universally faster. Both engines are parallel; performance depends on schema shape, primary keys, compression, storage, network, source capacity, and destination configuration.

### Engine boundary

Use a narrow internal interface so commands and presentation do not depend on mydumper flags:

```ts
interface BackupEngine {
  inspect(context: EngineContext): Promise<EngineCapabilities>
  backup(request: BackupRequest): AsyncIterable<EngineEvent>
  restore(request: RestoreRequest): AsyncIterable<EngineEvent>
  verifyArtifact(path: string): Promise<ArtifactVerification>
}
```

This is an isolation boundary, not a plugin framework. Implement only `MydumperEngine` in v1. Add a MySQL Shell backend only when concrete cloud-storage or Oracle migration demand justifies it.

---

## 4. Architecture

The following is the target layout. Files marked `(implemented)` exist at the end of Phase 1; the remaining paths are introduced only when their owning phase needs them.

```text
porteau/
├── install.sh                       # Generated Ubuntu dependency bootstrap
├── package.json
├── vite.config.ts
├── porteau.config.yaml
├── src/
│   ├── cli.ts                       # citty entrypoint (implemented); top-level error boundary follows
│   ├── commands/
│   │   ├── backup.ts                # Command skeleton implemented
│   │   ├── restore.ts               # Command skeleton implemented
│   │   ├── init.ts                  # Command skeleton implemented
│   │   ├── setup.ts                 # Command skeleton implemented
│   │   ├── doctor.ts                # Command skeleton implemented
│   │   └── config.ts                # Command skeleton implemented
│   ├── core/
│   │   ├── engine.ts                # Narrow engine capabilities and request types (implemented)
│   │   ├── mydumper.ts              # mydumper subprocess adapter
│   │   ├── myloader.ts              # myloader subprocess adapter
│   │   ├── events.ts                # Porteau-owned normalized event schema (implemented)
│   │   ├── process.ts               # Child lifecycle, process groups, and signals
│   │   ├── preflight.ts             # Server, engine, privilege, lock, and capacity checks
│   │   ├── artifact.ts              # Completion and metadata verification
│   │   ├── config.ts                # c12 + replacement merger + Valibot (implemented)
│   │   ├── filters.ts               # Pattern expansion and object-scope resolution
│   │   ├── credentials.ts           # Temporary protected defaults files
│   │   └── tools.ts                 # Binary resolution and version checks
│   ├── setup/
│   │   ├── manifest.json            # Canonical supported package/digest manifest (implemented)
│   │   ├── manifest.ts              # Validated TypeScript access (implemented)
│   │   ├── ubuntu.ts                # Guarded apt installer
│   │   └── diagnostics.ts
│   ├── presentation/
│   │   ├── context.ts               # TTY, CI, color, verbosity, JSON, and prompt policy
│   │   ├── prompts.ts               # Thin @clack/prompts wrappers
│   │   ├── progress.ts              # Interactive/non-interactive progress sinks
│   │   ├── output.ts                # consola and final summaries
│   │   └── redaction.ts
│   ├── errors/
│   │   ├── artifact.ts
│   │   ├── config.ts
│   │   ├── dependency.ts
│   │   ├── preflight.ts
│   │   └── process.ts
│   └── utils/
├── scripts/
│   └── generate-install-script.ts   # Embeds canonical manifest into install.sh
└── tests/
    ├── fixtures/
    ├── integration/
    └── installer/
```

### Command flow

1. citty parses the command and global options.
2. Build the presentation context from TTY/CI detection and `--quiet`, `--verbose`, `--json`, `--no-interactive`, and `--yes`.
3. Load and merge flags, environment variables, YAML configuration, and defaults.
4. Validate the complete request with Valibot.
5. Prompt only for required missing values when prompting is allowed.
6. Resolve mydumper and myloader from explicit environment override, explicit config path, then `PATH`. An invalid explicit path is terminal and must not fall through.
7. Verify both binaries start, report versions, match one another, and satisfy the compatibility manifest.
8. Connect through the selected direct MySQL protocol client with least-privilege credentials and run preflight checks; do not shell out to a `mysql` client.
9. Expand table patterns and resolve exactly one object scope for every selected table.
10. Show a sanitized operation summary and request confirmation where needed.
11. Create a temporary mydumper/myloader defaults file with mode `0600`.
12. Spawn the child in its own process group with `--machine-log-json`; capture stdout and stderr independently and parse machine events only from the stream verified for the pinned engine release.
13. Parse JSON Lines incrementally into validated engine events.
14. Normalize engine events into Porteau-owned events.
15. Render through Clack, consola, or structured JSON according to presentation mode.
16. On cancellation, terminate the complete process group, clean temporary files, restore terminal state, and return exit code 130 for SIGINT.
17. Verify the completion event, exit status, and backup artifact before reporting success.
18. Render one final summary or one centralized structured error.

---

## 5. Production safety contract

### What a consistent production backup does

For a normal MySQL 8 InnoDB export, mydumper generally:

1. Acquires DDL backup protection when available.
2. Briefly acquires a global read lock.
3. Starts every worker with repeatable-read `START TRANSACTION WITH CONSISTENT SNAPSHOT`.
4. Confirms workers share the intended point in time.
5. Releases the global read lock.
6. Dumps data in parallel while normal application DML continues.
7. Releases DDL backup protection during finalization.

The global read lock can briefly delay writes. The backup lock can block migrations, `TRUNCATE`, `OPTIMIZE`, account changes, and other file-affecting DDL for the backup’s duration.

### Execution profiles

#### `production` — default

- `--sync-thread-lock-mode=AUTO`
- `--trx-tables`
- Require every selected base table to be InnoDB.
- Keep DDL backup protection enabled.
- Enforce a finite startup lock budget with engine options where reliable and a Porteau watchdog.
- Default to four workers.
- Default per-table worker cap to four.
- Enable configurable adaptive throttling.
- Never kill application queries.
- Fail instead of weakening consistency.

#### `replica` — recommended for minimal primary impact

- Use the same consistency protections.
- Confirm the target is a replica and report current lag/state.
- Permit explicitly configured higher concurrency after capacity checks.
- Monitor replication lag throughout the run.
- Never imply the replica export has zero resource cost; it isolates that cost from the primary.

#### `expert` — explicit advanced behavior

- May expose `SAFE_NO_LOCK` with a prominent warning.
- Explain that an actively written primary may cause synchronization checks to fail.
- Never fall back silently to an inconsistent mode.
- Require `--yes` in non-interactive use after explicit risk flags.

### Prohibited production defaults

Porteau must not, by default:

- Continue when snapshot consistency cannot be guaranteed.
- Lock all selected tables for the full dump.
- Disable DDL protection.
- Kill existing application queries.
- Ignore mydumper/myloader errors.
- Change server-global durability settings.
- Disable redo logging during restore.
- Use unsafe overwrite behavior.
- Run exact row counts or full data checksums on a primary merely to improve the progress display.

### InnoDB preflight

Before spawning mydumper, query the selected table catalog and classify:

- InnoDB base tables: allowed in `production`.
- Views: schema handling only unless explicitly requested as data.
- Nontransactional tables: rejected in `production` with maintenance/replica guidance.
- Missing tables/patterns: validation error unless an explicit ignore-missing policy is selected.
- Tables without a useful primary/unique key: allowed, but warn that within-table parallelism may be limited.

Also verify:

- Server product and version.
- Required privileges for the chosen lock strategy.
- Binary logging/GTID capabilities where the engine depends on them.
- No known conflicting DDL/migration policy.
- Output directory writability and available disk space.
- Connection and TLS settings.
- Replica status for replica profile.

RDS and Aurora behavior must be capability-tested. Do not assume Oracle MySQL lock privileges or silently choose a weaker mode. Recommend a replica-first workflow for managed services with restricted backup privileges.

### Lock acquisition guard

- Set an explicit startup-lock time budget; initial config default is 10 seconds.
- Porteau starts a watchdog when the engine reports lock acquisition.
- If the budget expires, terminate the dump and report that no backup was produced.
- Do not enable engine options that kill long-running application queries.
- A lock failure is not retried forever by default.
- Expose bounded retry policy only as an explicit configuration option.

### Source-load monitoring

Track and report where available:

- MySQL `Threads_running`.
- CPU utilization.
- Storage IOPS, throughput, and latency.
- Network throughput.
- Application request/database latency.
- Replica lag.
- InnoDB history-list/undo growth.
- Dump throughput and estimated remaining work.

More workers are not automatically better. Stop scaling concurrency once source latency, I/O, CPU, replication lag, or undo growth crosses the configured safety budget.

---

## 6. Machine-event and artifact contract

### Engine events

Always invoke supported mydumper/myloader versions with:

```text
--machine-log-json
```

The parser must:

- During Phase 2 qualification, capture real output from every supported mydumper/myloader operation and establish which file descriptor carries machine events. Parse only that verified stream; do not assume stderr from human-log behavior.
- Read the verified stream incrementally as JSON Lines while preserving the other stream as bounded, redacted diagnostics.
- Validate guaranteed fields.
- Validate `schema_version` and `event_version` against the compatibility manifest.
- Reject unknown major schemas instead of guessing.
- Ignore documented unknown additive fields.
- Key behavior from `event`, `phase`, and `status`, not human `message` strings.
- Preserve run ID, sequence, parent sequence, database, table, rows, bytes, retries, warnings, errors, and exit code when present.
- Convert engine events into a stable Porteau event schema for presentation and `porteau --json` users.

The implemented `src/core/events.ts` schema is the Porteau-owned normalized contract, not a claim that native events already use those field names. The mydumper/myloader adapter owns explicit native-event schemas and mapping. Before that adapter is accepted, commit a redacted fixture corpus captured from pinned binaries for backup success, restore success, warning, fatal failure, and cancellation. If the pinned binaries do not provide the planned version fields or event coverage, revise the compatibility manifest and adapter contract from observed behavior before implementing presentation code; never synthesize compatibility claims to fit the existing normalized schema.

### Backup success

A backup succeeds only when all conditions hold:

1. The child exits with code `0`.
2. No fatal machine event was observed.
3. The completion event reports `errors == 0` and `exit_code == 0`.
4. The final `metadata` file exists.
5. `metadata.partial` does not exist.
6. Every expected schema/data artifact referenced by metadata exists.
7. The output path is finalized atomically from a temporary/in-progress name.

Warnings are preserved and displayed but do not automatically become success. Specific warnings can be configured as fatal policy checks.

### Restore verification

- Schema checksums may run by default if inexpensive.
- Full data checksums should be optional because they add full reads.
- Periodically restore representative backups into a disposable MySQL instance and validate schema, row-level invariants, and application smoke tests.
- A backup that has never been restored is not considered operationally verified.

---

## 7. Schema/data filtering

Porteau retains its independent YAML lists:

```yaml
exclude:
  schema:
    - "mydb.sessions"
    - "mydb.cache_*"
  data:
    - "mydb.logs"
    - "mydb.events"
```

Expand patterns against the preflight table catalog and resolve one scope per table:

| Porteau result | mydumper `object_to_export` |
|---|---|
| Include schema and data | `ALL` |
| Exclude schema only | `DATA` |
| Exclude data only | `SCHEMA` |
| Exclude both | `NONE` or omit table |

This mapping must happen before the child starts. Do not run separate schema and data dumps because they would not naturally share one snapshot.

The temporary mydumper defaults file should contain the resolved per-table sections. Wildcards are a Porteau configuration feature; pass only concrete, safely quoted identifiers to mydumper.

---

## 8. Configuration design

```yaml
# porteau.config.yaml
connection:
  host: localhost
  port: 3306
  user: backup
  tls: preferred
  # Password comes from environment or a masked prompt.

# Optional explicit binary overrides.
tools:
  mydumper: /usr/local/bin/mydumper
  myloader: /usr/local/bin/myloader

backup:
  directory: ./backups/{{date}}
  profile: production
  threads: 4
  maxThreadsPerTable: 4
  compression: zstd
  consistency:
    mode: auto
    requireInnoDB: true
    protectDdl: true
    startupLockTimeoutSeconds: 10
    lockRetries: 0
  throttle:
    enabled: true
    variable: Threads_running
    threshold: null

restore:
  threads: 4
  destinationPolicy: require-empty
  verifyChecksums: warn
  deferIndexes: per-table

include:
  databases: ["mydb"]

exclude:
  schema:
    - "mydb.sessions"
    - "mydb.cache_*"
  data:
    - "mydb.logs"
    - "mydb.events"

objects:
  triggers: true
  views: true
  routines: false
  events: false
```

### Value precedence

```text
command flags → environment variables → config file → defaults
```

Tool-path resolution remains:

```text
PORTEAU_MYDUMPER / PORTEAU_MYLOADER
→ explicit config paths
→ PATH
```

An explicit invalid path is a configuration error. Do not silently fall through to another executable.

### Throttle threshold

There is no universally safe `Threads_running` threshold. `porteau init` and `porteau doctor` should explain the setting and optionally recommend a value from observed server capacity. A null value means use a conservative engine/profile-derived recommendation, not unlimited throughput.

### Credential handling

- Prefer environment variables or a masked interactive prompt.
- Never put passwords in argv.
- Generate a temporary defaults file with mode `0600`.
- Keep credentials out of debug logs, machine JSON, errors, shell history, and final summaries.
- Delete credential files in `finally`, on cancellation, and during stale-run cleanup.

---

## 9. Restore safety

Mydumper affects the source; myloader affects the destination. Their safety claims must remain separate.

Default restore policy:

- Restore into a new, empty, or staging database.
- Require explicit target database and sanitized operation summary.
- Refuse existing objects by default.
- Require confirmation for drop, truncate, overwrite, GTID, or account changes.
- Never enable unsafe overwrite acceleration by default.
- Never disable redo logging on a running production destination.
- Keep destination binlogging behavior explicit.
- Support controlled index deferral for speed.
- Verify completion events, exit status, artifact metadata, and optional checksums.

A restore into an actively used production schema is disruptive and requires a maintenance/cutover procedure outside the normal quick path.

---

## 10. Presentation and automation contract

### Interactive mode

Enabled only when stdin and stdout are terminals, CI is not detected, and no non-interactive mode was requested.

Use Clack for:

- `intro` / `outro` framing without clearing the screen.
- Masked password input.
- Select, multiselect, and searchable bounded choices.
- Confirmation before destructive or privileged actions.
- Spinner for work without a trustworthy total.
- Progress bars only with meaningful completed/total values.
- Bounded task logs for child diagnostics.
- Consistent cancellation handling.

### Non-interactive mode

- Never prompt or use cursor animation.
- Emit stable line-oriented messages.
- Throttle repetitive progress output by time and meaningful state changes.
- Preserve useful child diagnostics with redaction.
- Return non-zero for validation, dependency, preflight, dump, restore, verification, or cancellation failures.

### Global output options

- Default: concise human-readable output.
- `--quiet`: errors and essential final result only.
- `--verbose`: config sources, tool paths/versions, sanitized commands, and bounded child diagnostics.
- `--json`: no prompts or decorative output; emit a documented Porteau JSON Lines event/result contract.
- `--no-interactive`: never prompt.
- `--yes`: approve documented confirmations but never invent missing required values.
- Respect `NO_COLOR` and terminal color capability.

### Clack/consola coordination

- Suspend consola transient output while a Clack prompt/progress renderer is active.
- Route live interactive child messages through the bounded Clack task log.
- Use consola before/after Clack sessions and throughout non-interactive mode.
- Render each failure once at the top-level CLI boundary.

---

## 11. Build and distribution

### Vite+ configuration

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: 'src/cli.ts',
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
})
```

### Primary package

Publish an npm package with:

```json
{
  "type": "module",
  "bin": {
    "porteau": "./dist/cli.mjs"
  },
  "engines": {
    "node": ">=22.18.0"
  }
}
```

Enforce the minimum runtime through `package.json` and test Node 22.18+ and Node 24 in CI.

### Standalone executable

A standalone executable would remove the end-user Node requirement. Keep it as a later secondary artifact because Vite+/tsdown executable packaging remains experimental and requires Node 25.7+ at build time. Evaluate it with Node 26 in an isolated packaging phase; do not make v1 installation depend on it.

Mydumper and myloader remain external system binaries. Porteau does not bundle or build them.

---

## 12. Supported native-tool manifest

Use `src/setup/manifest.json` as the canonical reviewed source for native packages and candidate machine-log versions. Package entries are supported only after their assets and binaries are qualified; machine-log versions become supported only after fixture-backed qualification in Phase 2. `install.sh` is generated from the manifest so Bash and TypeScript cannot drift.

Initial manifest:

| Ubuntu | Codename | Architecture | Asset | SHA-256 |
|---|---|---|---|---|
| 22.04 | jammy | amd64 | `mydumper_1.0.3-1.jammy_amd64.deb` | `9f7fb46c03e1a721e86d71c42a3fe3bd88f1a7b0ec80fa91c7736826f7f1e6f4` |
| 24.04 | noble | amd64 | `mydumper_1.0.3-1.noble_amd64.deb` | `824c3c78e9bd5311a906a383d7596ff70363e32413df44fe7c58fd8914e5445b` |
| 24.04 | noble | arm64 | `mydumper_1.0.3-1.noble_arm64.deb` | `7b6585df47316e375fee88c115ddbad1d876004fc57a860b6949acbef5a393d6` |

Download base:

```text
https://github.com/mydumper/mydumper/releases/download/v1.0.3-1/
```

Manifest fields must include:

- Engine tag and normalized version.
- Accepted mydumper/myloader version range.
- Supported machine-log schema/event versions.
- Ubuntu codename and Debian architecture.
- Exact asset filename and URL.
- Expected size.
- SHA-256 digest.

Rules:

- Never auto-select prereleases.
- Never use an unsupported codename/architecture asset as a “close enough” fallback.
- Verify SHA-256 before requesting sudo.
- Install with `sudo apt-get install --yes ./asset.deb` so dependencies are resolved.
- Verify both commands after installation and require compatible matching versions.
- A manifest update requires review, generated-installer drift checks, and integration tests.

---

## 13. Ubuntu `install.sh`

### Purpose

The root `install.sh` is an Ubuntu-only dependency bootstrap. It checks and, with explicit consent, installs:

- A compatible Node.js runtime when the npm CLI will need one.
- mydumper and myloader from the pinned manifest when either is missing or incompatible.

It does not install a MySQL server and does not silently alter the system. Automated macOS and other Linux installation are deferred; those platforms receive manual guidance.

### Supported systems

- Ubuntu 22.04 amd64.
- Ubuntu 24.04 amd64.
- Ubuntu 24.04 arm64.

Everything else exits without mutation and prints supported alternatives.

### Interface

```text
./install.sh             # inspect and prompt for missing/incompatible dependencies
./install.sh --check     # read-only diagnostics
./install.sh --yes       # approve documented changes; suitable for controlled automation
./install.sh --help
```

### Required behavior

1. Use `#!/usr/bin/env bash` and `set -Eeuo pipefail`.
2. Validate `ID=ubuntu` from `/etc/os-release`.
3. Read `VERSION_CODENAME` and `dpkg --print-architecture`.
4. Check `node`, `npm`, `mydumper`, and `myloader` independently, including versions.
5. Treat compatible existing dependencies as success without prompting.
6. Show every repository, package, version, asset, checksum, command, and sudo requirement before confirmation.
7. Default every prompt to No.
8. Read prompts from `/dev/tty` so a downloaded script can still prompt.
9. Without a TTY, make no changes unless `--yes` is present.
10. Request sudo only around apt/keyring operations, never for the whole script.
11. Use `mktemp -d` and install cleanup traps before downloading.
12. Quote all expansions, avoid `eval`, and remove partial downloads.
13. Re-run every version check after installation.
14. Declining an install is a clean cancellation with manual instructions.
15. Validation, checksum, download, apt, or post-install failures return non-zero.
16. Re-running the script is idempotent.

### Node.js handling

Node is required for the primary npm distribution.

Accepted runtime:

```text
Node.js >=22.18.0
```

Automatic Ubuntu installation target:

```text
Node.js 24 LTS
```

When Node is missing or incompatible:

- Explain why it is required.
- Detect common user-managed runtimes such as nvm, asdf, mise, and Volta.
- Warn before replacing or bypassing a user-managed Node.
- Offer a prompted system installation through the NodeSource Node 24 apt repository.
- Clearly label NodeSource as a third-party package repository.
- Never execute NodeSource’s remote setup script.
- Configure a dedicated `signed-by` keyring rather than `apt-key`.
- Verify the downloaded signing-key fingerprint against reviewed constants embedded by the generator.
- Stop with official Node.js/manual instructions if repository, key, fingerprint, architecture, or package validation fails.

Vite+ remains a development toolchain. Do not install Vite+ on end-user systems merely to obtain Node.

### Mydumper/myloader handling

If either command is missing, the versions differ, or the pair is unsupported:

1. Select the exact manifest row from Ubuntu codename and Debian architecture.
2. Show the pinned release and package details.
3. Download only from the official `mydumper/mydumper` GitHub release URL.
4. Verify exact size when provided and SHA-256 always.
5. Prompt before sudo and apt.
6. Install the local package with apt.
7. Confirm both commands exist and report the expected compatible version.

The source manifest is canonical. `scripts/generate-install-script.ts` embeds its values into the standalone Bash artifact, and CI fails if regenerating changes committed `install.sh`.

### Installer tests

Use:

- ShellCheck for static analysis.
- Bats for behavior with fake commands and files.
- Container integration tests for supported Ubuntu images.

Bats must cover:

- All dependencies already present.
- Missing Node.
- Incompatible Node.
- User-managed Node detection.
- Missing mydumper only.
- Missing myloader only.
- Version mismatch.
- Unsupported Ubuntu release.
- Unsupported architecture.
- Prompt declined.
- No TTY without `--yes`.
- `--check` read-only behavior.
- Checksum mismatch.
- Download failure.
- apt failure.
- Post-install verification failure.
- Successful idempotent second run.
- Cleanup on error and signal.

Container tests must never modify the host. Run Ubuntu 22.04 amd64 and 24.04 amd64 routinely; run 24.04 arm64 only on a deliberate arm64 runner or configured emulator.

---

## 14. `porteau setup` and `porteau doctor`

### `porteau setup`

`porteau setup` is the canonical in-CLI dependency installer after Node and Porteau are runnable.

```text
porteau setup
porteau setup --check
porteau setup --yes
```

Initial automated system mutation is Ubuntu-only and uses the same canonical manifest as `install.sh`.

Requirements:

- `--check` never changes the system.
- Interactive mode uses Clack confirmation.
- Non-interactive mutation requires `--yes`.
- Show pinned release, asset, digest, apt command, and privilege requirement.
- Download to a temporary directory and verify SHA-256.
- Install through apt and clean up.
- Verify both binaries and machine-log capability afterward.
- Unsupported systems receive manual instructions only.

### `porteau doctor`

`doctor` is always read-only and reports:

- OS, codename, and architecture.
- Node and Porteau versions.
- Effective config path.
- Server product and version when credentials are available.
- Resolution source/path for mydumper and myloader.
- Tool versions and compatibility status.
- Machine-log capability.
- Selected-table engine summary.
- Required privilege and lock-strategy readiness.
- Replica status and lag when applicable.
- Output-directory and disk-space status.
- Suggested correction for every failed check.

---

## 15. Development workflow

```bash
# Install Vite+.
curl -fsSL https://vite.plus | bash

# Install the project-pinned Node version and dependencies.
vp env install
vp install

# Run during development.
vp node src/cli.ts backup --config porteau.config.yaml

# Format, lint, and typecheck.
vp check

# Test.
vp test

# Build npm artifacts.
vp pack
```

Development must not require running `install.sh` against the host. Installer unit tests use fakes, and integration tests use disposable containers.

---

## 16. Test strategy

Tests are added with the phase that introduces the behavior. Phase 2 must first turn the current minimal subprocess convention into reusable fixture executables and pin observed native machine-log fixtures. Real-MySQL tests then validate claims that mocks cannot establish. Installer tests wait for the setup backend, and presentation-mode tests wait for the presentation layer; no later phase should replace or weaken an earlier safety gate.

### Unit tests

- Config precedence and Valibot errors.
- Pattern expansion and object-scope resolution.
- Binary resolution and explicit-path failure.
- Version parsing and compatibility-manifest validation.
- Machine JSON incremental parsing, unknown fields, malformed lines, and unsupported versions.
- Normalized Porteau event mapping.
- Artifact success/failure conditions.
- Secret redaction.
- Presentation-context mode selection.
- Cancellation and exit-code mapping.

### Process integration tests

Use fixture executables that simulate:

- Successful dumps and restores.
- Warnings.
- Fatal events.
- Non-zero exits.
- Missing completion event.
- Completion with non-zero error count.
- Truncated JSON Lines.
- Hanging lock acquisition.
- SIGINT and SIGTERM.
- Child/grandchild process cleanup.
- Final metadata versus partial metadata.

### Real MySQL integration tests

Run disposable containers to verify:

- InnoDB consistent backup under concurrent writes.
- Brief startup lock behavior.
- Production rejection of nontransactional tables.
- Independent schema/data exclusions in one dump.
- Large integer-primary-key chunking.
- Table without a useful key.
- Dump and restore round trip.
- Restore into non-empty target refusal.
- Optional checksum verification.
- Supported engine version and machine-event contract.

Do not claim production safety based only on mocked subprocess tests.

### CI matrix

- Node 22.18+ and Node 24.
- Ubuntu latest for normal package checks.
- Supported MySQL versions selected by the compatibility policy.
- ShellCheck and Bats.
- Ubuntu installer containers.
- npm pack/install smoke test.
- Standalone executable spike only in the later packaging phase.

---

## 17. Current progress and compatibility baseline

### Completed — Phase 1 (2026-07-20)

- Vite+ project, pinned pnpm package manager, Node `>=22.18.0`, ESM packaging, npm `bin`, and green `vp check`, `vp test`, and `vp pack` baseline.
- citty entrypoint with `backup`, `restore`, `init`, `setup`, `doctor`, and `config` command skeletons.
- Strict Valibot configuration schema with defaults, YAML-only c12 loading, replacement array semantics, and `flags → environment → YAML → defaults` precedence.
- Safety validation that prevents production/replica profiles from weakening automatic locking, InnoDB requirements, or DDL protection.
- Narrow `BackupEngine` boundary and Porteau-owned discriminated normalized event schema. Large native counters are intentionally represented as decimal strings to avoid JavaScript precision loss.
- Canonical, schema-validated candidate mydumper/myloader compatibility manifest for v1.0.3-1 and the three planned Ubuntu targets. Package metadata was pinned in Phase 1; native machine-log version 1 was subsequently qualified in Phase 2.
- Initial subprocess fixture convention and contract tests for CLI surface, configuration, events, and manifest consistency.

### Completed — Phase 2 (2026-07-21)

- Qualified the checksum-pinned v1.0.3-1 Jammy binaries without system installation and exercised them against an unprivileged disposable MySQL 8.4.10 server. Runtime machine events are JSON Lines on stderr; normal version output is on stdout. Redacted pinned fixtures cover mydumper/myloader success, startup failure, warnings, and mydumper cancellation, including the observed lock/unlock ordering and variable-width fractional timestamps.
- Selected and pinned `mysql2` 3.23.0. The shared direct-protocol connection boundary uses direct fields, bigint-safe strings, deadlines/abort destruction, sanitized errors, and injectable connections. Read-only preflight validates a qualified MySQL 8 server, databases, selected tables/views, InnoDB safety, useful keys, triggers, grants, GTID/binlog state, and replica state where requested.
- Added environment/config/PATH tool resolution with terminal explicit-path errors, exact matching version checks, protected `0600` credential defaults files, concrete per-table object scopes, exact table regexes, and child environments stripped of `PORTEAU_PASSWORD`.
- Added incremental native event parsing, explicit normalized mapping, required completion counters, bounded diagnostics, POSIX process groups, abort/timeout forwarding, TERM-to-KILL escalation, and parser-failure tree cleanup. The lock watchdog remains armed through native `table_unlock` and clears only after the qualified post-unlock event.
- Added the non-interactive backup safety path and command. It performs preflight before spawning, enables configured triggers/views, rejects unqualified object/TLS/profile combinations, refuses existing output paths, writes to a same-filesystem partial directory, requires process/event/artifact agreement, reserves the final path, atomically publishes, and cleans credentials and partial artifacts on failure or cancellation.
- Artifact verification requires regular final metadata, no partial metadata, selected database/table metadata, exact database/base-table/view/trigger schema artifacts, and numeric data chunks for nonempty data-bearing tables. Identifiers that mydumper would masquerade are rejected until metadata alias mapping is qualified.
- Real qualification covered successful backup and restore, independent data exclusion, keyless-table warnings, trigger preservation, view artifacts, non-InnoDB rejection before spawn, zero stdout machine logging, cancellation without completion, and partial metadata on interruption. Deterministic tests cover disagreement, malformed/truncated streams, hanging locks, and child/grandchild cleanup.

Phase 2 deliberately fails closed outside its qualified boundary. MariaDB and non-8.x MySQL are rejected. Routines/events await catalog and artifact qualification. CA-verified TLS modes await explicit CA configuration; `preferred` currently requires TLS during mysql2 preflight rather than retrying plaintext. Nontransactional expert exports are rejected, and verifiable artifact identifiers use a conservative filename-safe subset. Process-tree guarantees are currently POSIX/qualified-Ubuntu guarantees. These are explicit future extensions, not silent fallbacks.

The committed Phase 1 types are foundations, not frozen external APIs. `BackupRequest`, `RestoreRequest`, and `EngineCapabilities` are deliberately minimal and should grow from concrete requirements in their owning phases. Preserve the `BackupEngine` isolation boundary and normalized-event discriminant, but prefer extending these types over creating parallel command-specific request models. Phase 2 consumes only the backup-facing structural subset of `BackupEngine` (`inspect`, `backup`, and `verifyArtifact`); no concrete adapter claims to implement the full interface until Phase 5 adds `restore`. The CLI has no public JSON event compatibility promise until its schema is documented and versioned in Phase 4.

### Current dependency boundary

The Phase 2 production dependency set is c12, citty, mysql2, and Valibot. Add remaining dependencies in their owning phase:

- Phase 3: no presentation dependency; setup/doctor expose pure diagnostic and mutation-planning services.
- Phase 4: `@clack/prompts`, consola, and nostics.dev, after their exact APIs and supported Node range are verified.

Do not import Clack or consola into `src/core` or `src/setup`. Do not make backup correctness depend on presentation, and do not make the generated installer depend on Node or the built CLI at runtime.

---

## 18. Remaining implementation phases

### Phase 1 — Verification baseline and contracts (complete)

- The baseline listed in Section 17 is implemented.
- Remaining subprocess scenarios and native machine-log fixtures belong to Phase 2, where their required behavior is known.

### Phase 2 — Qualify and implement safe backup integration (complete)

- Qualify pinned mydumper/myloader binaries first: verify version output, machine-log flag support, event stream location, native schema/version fields, completion semantics, metadata format, lock-related events, and cancellation behavior. Capture redacted fixtures and correct the manifest assumptions before building adapters.
- Evaluate `mysql2` against the supported Node range, TLS modes, cancellation/time limits, error redaction, and large-value handling; pin it if suitable, otherwise select another direct protocol client without creating a multi-driver abstraction. Implement shared, injectable connection handling for source/destination preflight. Keep passwords out of URLs, argv, logs, and errors; set connection/TLS options directly.
- Resolve and verify both native tools using environment override, config path, then `PATH`; reject an invalid explicit path without fallback.
- Implement protected temporary credential files.
- Implement process-group lifecycle and signal forwarding.
- Expand the subprocess fixture into deterministic success, warning, malformed/truncated event, fatal event, non-zero exit, hang, signal, and child/grandchild scenarios.
- Implement incremental native machine-log parsing and explicit mapping into the existing normalized event schema. Preserve unknown additive native fields only as needed for diagnostics; do not leak a native schema into the public contract.
- Implement read-only server/table/privilege/capability preflight through the selected protocol client, with abort/time limits and redacted errors.
- Implement production, replica, and expert profiles.
- Implement bounded lock watchdog.
- Implement pattern expansion and per-table object scopes.
- Implement backup completion policy, artifact validator, and same-filesystem atomic output finalization. Refuse a pre-existing final path rather than overwriting it.
- Wire the non-interactive `backup` command only after the service-level safety path passes. Initially use stable plain output without introducing the Phase 4 presentation stack.
- Add unit and process tests, then real-MySQL tests for consistent backup under writes, lock behavior, filters, nontransactional rejection, and artifact integrity before UI polish.

**Exit gate:** a non-interactive backup can run end-to-end, cancellation cleans the full process tree and secret files, success requires process/event/artifact agreement, and native behavior is represented by pinned fixtures. Myloader machine-event qualification is complete even though restore mapping and destination mutation remain Phase 5. The Phase 2 adapter implements only the backup-facing structural subset of `BackupEngine`, and `vp check`, `vp test`, and `vp pack` pass.

Completed on 2026-07-21 within the qualified boundary recorded in Section 17. Broader server, TLS, identifier, and object support must add evidence and tests before relaxing those fail-closed gates.

### Phase 3 — Read-only diagnostics and setup backend

- Implement reusable OS, architecture, tool-resolution, version, and compatibility diagnostics used by both `doctor` and setup planning.
- Implement `doctor` and `setup --check` as read-only non-interactive commands first. Reuse Phase 2 tool inspection rather than introducing a second version parser.
- Implement a manifest-backed Ubuntu installation planner/executor with mutation separated from policy and rendering. The backend requires an explicit approval value but must not prompt itself.
- Implement non-interactive `setup --yes`; without `--yes`, the temporary plain CLI can print the plan and refuse mutation until Phase 4 supplies interactive confirmation.
- Generate root `install.sh` from the canonical manifest.
- Implement guarded Node 24 installation flow.
- Add ShellCheck, Bats, and Ubuntu container tests.
- Document unsupported-platform manual paths.

The generator must consume validated canonical data, but the committed `install.sh` must remain standalone Bash because it runs before Node/Porteau may exist. A drift test regenerates to a temporary path and compares bytes. Never run installer integration tests against the host.

**Exit gate:** diagnostics and `--check` are provably read-only, mutation requires explicit approval, generated Bash is deterministic and standalone, supported Ubuntu container tests are idempotent, and all package checks pass.

### Phase 4 — Presentation boundary and guided backup/setup experience

- Add and verify `@clack/prompts`, consola, and nostics.dev against the supported Node matrix.
- Implement presentation context and the top-level error/exit-code boundary before adding prompts.
- Add thin Clack wrappers and consistent cancellation. Keep prompt results as command inputs; core/setup services remain non-interactive.
- Add guided backup, init, setup, doctor, and config flows. Restore can inspect/verify an artifact here, but destination mutation remains Phase 5.
- Add interactive spinner/progress/task log adapters.
- Add consola default/quiet/verbose non-interactive adapters.
- Add a versioned Porteau JSON Lines output schema based only on normalized events plus command result envelopes. Document this as the first public machine-output contract and snapshot-test it independently of native fixtures.
- Test TTY, non-TTY, CI, redirected output, no-color, `--yes`, and `--no-interactive` behavior.

**Exit gate:** every interactive input has a flag/config/environment equivalent, `--json` and non-TTY modes never prompt or animate, errors render once with stable exit codes, setup uses the Phase 3 approval boundary, and presentation imports do not cross into core/setup.

### Phase 5 — Guarded restore, operational verification, and release packaging

- Implement myloader native-event mapping from the Phase 2-qualified fixture corpus, revalidate it in pinned-binary integration tests, and qualify destination mutation behavior before exposing restore. Extend the existing parser/event system rather than creating a second one.
- Extend `RestoreRequest` from proven requirements and implement destination preflight through the shared direct-protocol connection layer.
- Complete guarded myloader flows with `require-empty` as the default, explicit destination/binlog/overwrite policies, process-group cancellation, and the same process/event/artifact agreement used by backup.
- Add disposable restore verification and real dump/restore round trips. Keep full data checksums opt-in and distinguish “backup artifact valid” from “restore operationally verified.”
- Add npm publishing and installation smoke tests.
- Write paired interactive and automation documentation.
- Review shell completions and help.
- Add supported Node/MySQL CI matrix.
- Evaluate, but do not depend on, a standalone executable built with Node 26.
- Consider a MySQL Shell backend only as a separate evidence-driven roadmap item.

**Exit gate:** destructive destination behavior is impossible without explicit policy and confirmation, round-trip tests pass on the supported matrix, npm pack/install invokes `dist/cli.mjs`, documentation matches both human and JSON modes, and release artifacts contain no credentials or temporary data.

---

## 19. Final decision summary

| Decision | Choice | Confidence |
|---|---|---|
| Toolchain | Vite+ + `vp pack` | High |
| Runtime | Node.js `>=22.18.0` for npm distribution | High |
| CLI structure | citty | High |
| Guided interaction | `@clack/prompts` | High |
| Human/non-interactive logs | consola | High |
| Config | YAML + c12 + replacement merger + Valibot | High |
| Structured errors | nostics.dev | High |
| Primary engine | Pinned mydumper/myloader v1 | High |
| Initial engine release | v1.0.3-1 | High |
| MySQL Shell | Deferred optional backend | Medium |
| Production consistency | `AUTO` + transactional InnoDB + bounded startup lock | High |
| Zero-primary-impact strategy | Dedicated read replica | High |
| Default dump concurrency | 4 workers, maximum 4 per table | High |
| Progress integration | Versioned machine JSON → Porteau normalized events | High |
| Backup completion | Exit/event/artifact validation, not exit code alone | High |
| Restore target | New/staging by default; live target requires maintenance | High |
| Native dependency delivery | External checksum-pinned packages | High |
| Automated setup | Ubuntu 22.04/24.04 supported matrix | High |
| Bootstrap | Prompt-first generated `install.sh` | High |
| Other platforms | Read-only diagnostics and manual guidance initially | High |
| Primary packaging | npm `bin` | High |
| Standalone packaging | Experimental secondary artifact later | Medium |
| Full-screen terminal UI | None | High |

Phases 1 and 2 are complete within the qualified boundary in Section 17. Future work must preserve these safety, compatibility, event, artifact, and installer contracts, while correcting assumptions whenever qualification against pinned native binaries provides stronger evidence. Porteau’s value is not merely forwarding flags: it is making fast logical backups understandable, observable, reproducible, and safe by default.
