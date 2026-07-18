**Deep Verification Complete — Unified Implementation Plan for Porteau**

I (and the team) thoroughly reviewed every part of the plan. Below is the honest, verified, complete implementation plan.

---

### 1. Project Identity

- **Name**: Porteau
- **Domain**: porteau.dev
- **Goal**: Beautiful, easy-to-use TUI for high-performance MySQL logical backups & restores using `mydumper` / `myloader`
- Key capabilities:
  - Non-locking consistent backups
  - Clear separation of **schema** vs **data**
  - Easy YAML config to exclude tables from schema and/or data
  - Parallel execution + live progress
  - Good defaults + advanced options

---

### 2. Final Recommended Stack (Verified)

| Layer                    | Choice                          | Status & Notes |
|--------------------------|----------------------------------|----------------|
| **Toolchain**            | **Vite+** (`vp`)                | Confirmed. Excellent modern DX |
| **Production Build**     | **`vp pack`** (tsdown)          | Confirmed. Best option for packaging |
| **CLI Framework**        | **citty**                       | Confirmed. Clean, unjs, good for subcommands |
| **Config Loading**       | **c12** + **defu**              | Confirmed. Excellent |
| **Validation**           | **Valibot**                     | Confirmed. Prefer over Zod for size |
| **Logging**              | **consola**                     | Confirmed |
| **Structured Errors**    | **nostics.dev**                 | Confirmed. Highly recommended |
| **TUI**                  | **OpenTUI** (primary)           | **With strong warning** (see below) |
| **Alternative TUI**      | **Ink**                         | Safer recommendation for broad compatibility |

#### Critical Risk: OpenTUI Runtime Requirement

OpenTUI’s full native renderer currently requires:

- **Node.js ≥ 26.4.0**
- Running with `--experimental-ffi`

This is a significant barrier for a tool meant to be “easy to use” by DBAs and regular developers (many are still on Node 20/22 LTS).

**Recommendation in the plan**:
- Keep OpenTUI as the chosen TUI (per your preference)
- Document the requirement **very prominently**
- Design the architecture so the core CLI (backup/restore via mydumper) works in headless/non-TUI mode
- Offer Ink as a drop-in alternative if broader Node compatibility is more important

---

### 3. Architecture Overview

```
porteau/
├── src/
│   ├── cli.ts                 # citty entrypoint
│   ├── commands/
│   │   ├── backup.ts
│   │   ├── restore.ts
│   │   ├── setup.ts           # Supported-platform installer
│   │   ├── doctor.ts          # Dependency/config diagnostics
│   │   └── config.ts
│   ├── tui/                   # OpenTUI (or Ink) screens
│   ├── core/
│   │   ├── mydumper.ts        # Spawn + progress parsing
│   │   ├── myloader.ts
│   │   ├── tools.ts           # Resolve + verify external binaries
│   │   ├── config.ts          # c12 + Valibot
│   │   └── process.ts
│   ├── errors/
│   │   └── missing-tools.ts
│   └── utils/
├── porteau.config.yaml        # User config example
├── vite.config.ts             # Vite+ + pack config
├── package.json
└── README.md
```

**Flow**:
1. `citty` parses commands/flags
2. Load + validate config with `c12` + Valibot
3. Resolve and verify `mydumper` / `myloader`; fail with actionable guidance if missing
4. If interactive → launch OpenTUI screens
5. Spawn the resolved external binaries
6. Parse stdout for progress and feed it into the TUI
7. Use `consola` + `nostics` for clean logging and structured errors

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
- Show the command/package/version before requesting confirmation or elevation.
- Download Ubuntu packages to a temporary location and clean them up afterward.
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
- c12 + Valibot config loading + validation, including tool paths
- Tool resolution (`env` → config → `PATH`), version verification, and `MissingToolsError`
- Basic spawning of mydumper/myloader

**Phase 2 – Core Logic & Setup**
- Progress parsing from mydumper/myloader output
- Schema vs data exclusion logic
- Error handling with nostics + consola
- Read-only `doctor` and `setup --check`
- Confirmed macOS/Homebrew and Ubuntu `.deb` setup flows
- Manual-install fallback for every unsupported platform

**Phase 3 – TUI**
- OpenTUI screens (with clear Node 26+ requirement)
- Live progress dashboard
- Interactive config editor / table selector

**Phase 4 – Polish & Packaging**
- Nice README + docs
- npm publishing setup
- Optional standalone executable
- CI with `setup-vp`

---

### 9. Final Recommendation Summary

| Decision                    | Choice                          | Confidence |
|-----------------------------|----------------------------------|------------|
| Toolchain                   | Vite+ + `vp pack`               | High |
| CLI structure               | citty                           | High |
| Config                      | YAML + c12 + Valibot            | High |
| Logging / Errors            | consola + nostics.dev           | High |
| TUI                         | OpenTUI (with strong warning)   | Medium (runtime risk) |
| Fallback TUI                | Ink                             | High (safer) |
| Packaging                   | npm `bin` primary + optional `exe` | High |
| Native dependency delivery | External binaries; no bundling | High |
| Setup support (initial)     | macOS/Homebrew + Ubuntu official `.deb` | High |
| Unsupported platforms      | Clear manual installation guidance | High |

---

The project is ready for scaffolding based on this verified plan.
