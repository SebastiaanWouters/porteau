**Deep Verification Complete — Unified Implementation Plan for Porteau**

I (and the team) thoroughly reviewed every part of the plan. Below is the honest, verified, complete implementation plan.

---

### 1. Project Identity

- **Name**: Porteau
- **Domain**: porteau.dev
- **Goal**: Beautiful, easy-to-use command-line interface for high-performance MySQL logical backups and restores using `mydumper` / `myloader`
- Key capabilities:
  - Non-locking consistent backups
  - Clear separation of **schema** vs **data**
  - Easy YAML config to exclude tables from schema and/or data
  - Parallel execution with clear live progress
  - Optional interactive prompts without sacrificing scriptability
  - Good defaults + advanced options

---

### 2. Final Recommended Stack (Verified)

| Layer                    | Choice                          | Status & Notes |
|--------------------------|----------------------------------|----------------|
| **Toolchain**            | **Vite+** (`vp`)                | Confirmed. Excellent modern DX |
| **Production Build**     | **`vp pack`** (tsdown)          | Confirmed. Best option for packaging |
| **CLI Framework**        | **citty**                       | Command definitions, subcommands, flags, help, and parsing |
| **Interactive Prompts**  | **`@clack/prompts`**            | Small, polished prompts, confirmations, progress, and task logs |
| **Config Loading**       | **c12** + **defu**              | Confirmed. Excellent |
| **Validation**           | **Valibot**                     | Confirmed. Prefer over Zod for size |
| **Logging**              | **consola**                     | Human-readable, verbose, and non-interactive logging |
| **Structured Errors**    | **nostics.dev**                 | Confirmed. Actionable domain errors |
| **Full-screen UI**       | **None**                        | Intentionally omitted to keep the CLI simple, portable, and maintainable |

#### Final CLI UX Decision

Porteau will be a conventional, scriptable CLI with an optional guided experience. It will not use a full-screen terminal renderer.

- **citty owns command structure**: commands, positional arguments, options, generated help, and parsing.
- **`@clack/prompts` owns interactive moments**: missing-value prompts, password input, selection, confirmation, spinners, progress bars, and bounded task logs.
- **consola owns logging**: normal status messages, warnings, verbose diagnostics, and readable output in non-interactive environments.
- The interactive layer must remain optional. Every operation must be usable through flags, configuration, and environment variables.
- Interactive behavior is enabled only when both input and output are attached to a terminal and the user has not selected a non-interactive output mode.
- CI, redirected output, `--json`, and `--no-interactive` must never wait for a prompt. Missing required input must instead produce an actionable error.
- `--yes` skips confirmations but does not invent missing required values.
- Use a progress bar only when a meaningful total is known. Otherwise use a spinner plus changing status text; never display a fabricated percentage.
- Handle `Ctrl+C` and prompt cancellation consistently, terminate the active child process, clean up terminal state, and exit with the conventional cancellation status.

This removes native rendering dependencies and keeps Porteau reliable over SSH, in CI, in log files, and in ordinary terminals.

---

### 3. Architecture Overview

```text
porteau/
├── src/
│   ├── cli.ts                   # citty entrypoint and top-level error boundary
│   ├── commands/
│   │   ├── backup.ts
│   │   ├── restore.ts
│   │   ├── init.ts              # Guided or flag-driven config creation
│   │   ├── setup.ts             # Supported-platform installer
│   │   ├── doctor.ts            # Dependency/config diagnostics
│   │   └── config.ts
│   ├── presentation/
│   │   ├── context.ts           # TTY, color, verbosity, JSON, and prompt policy
│   │   ├── prompts.ts           # Thin wrappers around @clack/prompts
│   │   ├── progress.ts          # Interactive and non-interactive progress sinks
│   │   ├── output.ts            # consola setup and final summaries
│   │   └── redaction.ts         # Prevent credentials from reaching output
│   ├── core/
│   │   ├── mydumper.ts          # Spawn process and emit normalized events
│   │   ├── myloader.ts
│   │   ├── progress.ts          # UI-independent progress event types
│   │   ├── tools.ts             # Resolve + verify external binaries
│   │   ├── config.ts            # c12 + Valibot
│   │   └── process.ts           # Child lifecycle, signals, and cancellation
│   ├── errors/
│   │   └── missing-tools.ts
│   └── utils/
├── porteau.config.yaml          # User config example
├── vite.config.ts               # Vite+ + pack config
├── package.json
└── README.md
```

**Command flow**:
1. `citty` parses commands, positional arguments, and flags.
2. Build a presentation context from TTY detection and global options such as `--json`, `--quiet`, `--verbose`, `--no-interactive`, and `--yes`.
3. Load, merge, and validate configuration with c12, defu, and Valibot.
4. Resolve values using documented precedence: command flags → environment variables → config file → defaults.
5. If required values remain missing and prompting is allowed, gather them with `@clack/prompts`; otherwise fail with an actionable validation error.
6. Resolve and verify `mydumper` / `myloader`; fail with installation guidance if either is missing.
7. Show a sanitized operation summary and request confirmation when the action is destructive or risky, unless `--yes` was supplied.
8. Spawn the resolved external binary and translate its output into UI-independent progress events.
9. Render those events through the selected sink: Clack progress/spinner/task log for interactive use, periodic consola messages for normal non-interactive use, or structured events for `--json`.
10. Print a stable final summary, restore terminal state, and return a meaningful exit code.

#### Interaction and Output Contract

The presentation layer must stay separate from backup and restore logic. Core modules emit typed events and never import Clack or consola directly. This keeps process handling testable and prevents future output changes from affecting backup correctness.

**Interactive mode**:
- Use `intro` / `outro` to frame guided commands without clearing the terminal or entering an alternate screen.
- Use `password` for credentials that cannot come from environment/configuration.
- Use `select`, `multiselect`, or searchable selection for small, bounded choices. Keep YAML patterns and flags as the preferred interface for very large table sets.
- Use `confirm` before restores, overwrites, downloads, package installation, or privilege elevation.
- Use a spinner for indeterminate work such as connection checks and tool verification.
- Use a progress bar only when the parser has a trustworthy completed/total value.
- Use a bounded task log for relevant child-process messages; do not flood or permanently rewrite the user's terminal.
- Treat Clack cancellation as a normal controlled cancellation, not as an unhandled exception.

**Non-interactive mode**:
- Never prompt or use cursor-based animation.
- Emit stable line-oriented status messages suitable for SSH sessions, redirected logs, and CI.
- Throttle repetitive progress messages by time or meaningful state changes.
- Preserve the child process's useful diagnostics while redacting passwords and connection secrets.
- Return non-zero exit codes for configuration errors, missing dependencies, failed backups/restores, and cancellation.

**Output modes**:
- Default: concise human-readable status and final summary.
- `--quiet`: errors and essential final result only.
- `--verbose`: resolved config source, tool paths and versions, sanitized child command, and bounded child output.
- `--json`: no prompts, decoration, spinner, progress bar, or unrelated human log lines; emit a documented machine-readable result/event format.
- `NO_COLOR` and terminal color capability must be respected.

**Clack/consola coordination**:
- Do not let consola write transient status messages while a Clack prompt or progress renderer is active, because competing writers can corrupt terminal output.
- Route live child messages through the active Clack task log in interactive mode.
- Use consola directly in non-interactive mode and for messages emitted before or after a Clack session.
- Keep final errors centralized in the top-level command boundary so the same failure is not printed twice.

---

### 4. Production Build Strategy (Vite+)

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    // Optional later for true standalone binary (Node ≥ 25.7):
    // exe: true,
  },
})
```

**Packaging strategy**:
- **Primary**: Normal npm package  
  `"bin": { "porteau": "./dist/cli.js" }`
- **Secondary**: Standalone executable via `exe: true` (experimental)

`mydumper` and `myloader` remain **external** system binaries. Porteau will not bundle or build them.

---

### 5. mydumper / myloader Dependency Handling

#### Final decisions

| Approach | Status |
|----------|--------|
| Fully bundle binaries | No |
| Detection + clear installation guidance | Yes |
| `porteau setup` / `porteau doctor` | Yes |
| Config and environment path overrides | Yes |

#### Resolution and verification

Before every backup or restore, resolve both tools independently in this order:

1. Environment override: `PORTEAU_MYDUMPER` / `PORTEAU_MYLOADER`
2. Config path: `tools.mydumper` / `tools.myloader`
3. Executable found on `PATH`

An explicitly configured path that does not exist or is not executable is a configuration error; Porteau must not silently fall through to a different binary. After resolution, invoke each binary with its version flag to verify that it starts successfully.

```ts
const mydumperPath = resolveTool({
  env: process.env.PORTEAU_MYDUMPER,
  config: config.tools?.mydumper,
  command: 'mydumper',
})

const myloaderPath = resolveTool({
  env: process.env.PORTEAU_MYLOADER,
  config: config.tools?.myloader,
  command: 'myloader',
})

if (!mydumperPath || !myloaderPath) {
  throw new MissingToolsError({ mydumperPath, myloaderPath })
}
```

Missing dependencies produce a clean, actionable error rather than a raw process-spawn failure:

```text
✖  Required tools not found

  Porteau needs mydumper and myloader to work.

  Missing:
  • mydumper
  • myloader

  Quick fix:
  → Run: porteau setup

  Or install manually:
  • macOS:  brew install mydumper
  • Ubuntu: https://github.com/mydumper/mydumper/releases
  • Other:  https://github.com/mydumper/mydumper/releases

  You can also set custom paths in your config:
  tools:
    mydumper: /path/to/mydumper
    myloader: /path/to/myloader
```

#### `porteau setup`

The initial setup command intentionally supports only macOS and Ubuntu:

| Platform | Setup behavior |
|----------|----------------|
| macOS | Require Homebrew, run `brew install mydumper`, then verify both tools |
| Ubuntu | Detect `amd64` / `arm64`, download the matching official `.deb` from the latest mydumper GitHub release, install with `sudo dpkg -i`, then verify both tools |
| Any other OS | Make no system changes; show manual installation instructions and the official releases URL |

Additional requirements:

- `porteau setup --check` performs detection and verification without installing or changing anything.
- In interactive mode, use a Clack confirmation after showing the exact command, package, version, download source, and expected privilege elevation.
- In non-interactive mode, installation requires explicit `--yes`; otherwise print the proposed action and exit without changing the system.
- Download Ubuntu packages to a temporary location and clean them up afterward.
- Show installation progress with a spinner or trustworthy progress bar, while keeping verbose child output available through a bounded task log.
- Fail clearly if the OS, architecture, Homebrew, release asset, download, or installation cannot be validated.
- Do not add a generic `~/.porteau/bin` installer or modify `PATH` in the initial version.

#### `porteau doctor`

`porteau doctor` provides read-only diagnostics suitable for troubleshooting. It reports:

- OS and architecture
- Effective config file
- Resolution source and path for each tool (environment, config, or `PATH`)
- Tool executability and version-check result
- A concise suggested fix for every failed check

It never installs packages or modifies user configuration.

---

### 6. Config Design (YAML + Valibot)

```yaml
# porteau.config.yaml
connection:
  host: localhost
  port: 3306
  user: backup
  # password via env or prompt

tools:
  mydumper: /usr/local/bin/mydumper   # optional
  myloader: /usr/local/bin/myloader   # optional

backup:
  directory: ./backups/{{date}}
  threads: 12
  compress: true
  less-locking: true

include:
  databases: ["mydb"]

exclude:
  schema:
    - "mydb.sessions"
    - "mydb.cache_*"
  data:
    - "mydb.logs"
    - "mydb.events"

options:
  triggers: true
  views: true
  routines: false
```

Validation happens entirely in the CLI with Valibot → language-independent for the user. `PORTEAU_MYDUMPER` and `PORTEAU_MYLOADER` override the optional YAML paths.

---

### 7. Development Workflow

```bash
# Install Vite+ globally
curl -fsSL https://vite.plus | bash

# Project setup
vp create porteau   # or manual

# Daily development
vp node src/cli.ts backup --config porteau.config.yaml

# Lint + format + typecheck
vp check

# Production build
vp pack

# Test
vp test
```

---

### 8. Implementation Phases (Recommended Order)

**Phase 1 – Foundation**
- Project scaffolding with Vite+
- citty CLI skeleton (`backup`, `restore`, `init`, `setup`, `doctor`)
- Global output options: `--quiet`, `--verbose`, `--json`, `--no-interactive`, and `--yes`
- Presentation-context detection for TTY, CI, color support, and prompt eligibility
- c12 + Valibot config loading + validation, including tool paths
- Documented value precedence: flags → environment → config → defaults
- Tool resolution (`env` → config → `PATH`), version verification, and `MissingToolsError`
- Basic spawning of mydumper/myloader with signal forwarding and secret redaction

**Phase 2 – Core Logic & Setup**
- Typed, presentation-independent progress events from mydumper/myloader output
- Schema vs data exclusion logic
- Structured error handling with nostics and centralized rendering
- consola-based human, verbose, quiet, and non-interactive output
- Read-only `doctor` and `setup --check`
- Confirmed macOS/Homebrew and Ubuntu `.deb` setup flows
- Manual-install fallback for every unsupported platform

**Phase 3 – Guided CLI Experience**
- Thin, testable wrappers around `@clack/prompts`
- Guided `init`, backup, restore, and setup flows that prompt only for missing or confirmable input
- Password, select, multiselect/search, and confirmation prompts with consistent cancellation handling
- Spinner, trustworthy progress bar, and bounded task-log adapters
- Strict coordination between Clack and consola so output never overlaps
- Non-TTY, CI, redirected-output, `--no-interactive`, `--yes`, and `--json` behavior
- Snapshot/unit tests for progress rendering, cancellation, redaction, and final summaries

**Phase 4 – Polish & Packaging**
- README with paired interactive and automation examples for every important operation
- Shell completion and command-help review
- npm publishing setup
- Optional standalone executable
- CI with `setup-vp` across supported Node versions and representative interactive/non-interactive modes

---

### 9. Final Recommendation Summary

| Decision                    | Choice                                      | Confidence |
|-----------------------------|---------------------------------------------|------------|
| Toolchain                   | Vite+ + `vp pack`                           | High |
| CLI structure               | citty                                       | High |
| Interactive UX              | `@clack/prompts`                            | High |
| Human/non-interactive logs  | consola                                     | High |
| Config                      | YAML + c12 + Valibot                        | High |
| Structured errors          | nostics.dev                                 | High |
| Full-screen terminal UI     | None; conventional CLI output by design    | High |
| Automation                  | Flags/config/env + no-prompt and JSON modes | High |
| Packaging                   | npm `bin` primary + optional `exe`          | High |
| Native dependency delivery | External binaries; no bundling             | High |
| Setup support (initial)     | macOS/Homebrew + Ubuntu official `.deb`     | High |
| Unsupported platforms      | Clear manual installation guidance         | High |

---

The project is ready for scaffolding based on this verified plan.
