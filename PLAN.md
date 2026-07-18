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
│   │   └── config.ts
│   ├── tui/                   # OpenTUI (or Ink) screens
│   ├── core/
│   │   ├── mydumper.ts        # Spawn + progress parsing
│   │   ├── myloader.ts
│   │   ├── config.ts          # c12 + Valibot
│   │   └── process.ts
│   └── utils/
├── porteau.config.yaml        # User config example
├── vite.config.ts             # Vite+ + pack config
├── package.json
└── README.md
```

**Flow**:
1. `citty` parses commands/flags
2. Load + validate config with `c12` + Valibot
3. If interactive → launch OpenTUI screens
4. Spawn `mydumper` / `myloader` (user must have them installed)
5. Parse stdout for progress and feed it into the TUI
6. Use `consola` + `nostics` for clean logging and structured errors

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

`mydumper` and `myloader` remain **external** system binaries (user installs them). This is correct and unavoidable for performance.

---

### 5. Config Design (YAML + Valibot)

```yaml
# porteau.config.yaml
connection:
  host: localhost
  port: 3306
  user: backup
  # password via env or prompt

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

Validation happens entirely in the CLI with Valibot → language-independent for the user.

---

### 6. Development Workflow

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

### 7. Implementation Phases (Recommended Order)

**Phase 1 – Foundation**
- Project scaffolding with Vite+
- citty CLI skeleton (`backup`, `restore`, `init`)
- c12 + Valibot config loading + validation
- Basic spawning of mydumper/myloader

**Phase 2 – Core Logic**
- Progress parsing from mydumper/myloader output
- Schema vs data exclusion logic
- Error handling with nostics + consola

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

### 8. Final Recommendation Summary

| Decision                    | Choice                          | Confidence |
|-----------------------------|----------------------------------|------------|
| Toolchain                   | Vite+ + `vp pack`               | High |
| CLI structure               | citty                           | High |
| Config                      | YAML + c12 + Valibot            | High |
| Logging / Errors            | consola + nostics.dev           | High |
| TUI                         | OpenTUI (with strong warning)   | Medium (runtime risk) |
| Fallback TUI                | Ink                             | High (safer) |
| Packaging                   | npm `bin` primary + optional `exe` | High |

---

**Would you like me to proceed with generating the actual project scaffolding** based on this verified plan?

I can create the full initial structure, `vite.config.ts`, `package.json`, basic CLI, config schema, etc.
