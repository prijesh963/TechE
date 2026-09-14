# Copilot Architect — Project Handover Briefing

> **Purpose of this document:** a speaking guide / talk track for handing this project over to the team.
> Each section has **"What to say"** talking points plus the reference detail behind them, so you can present it
> live and leave it behind as documentation. Suggested length: **30–45 min walkthrough + 10 min live demo.**

---

## 0. How to use this document

- Sections **1–4** are the _story_ — open with these. They explain what the project is and why it's built the way it is.
- Sections **5–10** are the _reference_ — the packages, commands, MCP tools, safety model, and file layout.
- Sections **11–14** are the _operational handover_ — how to build/run/test, distribute, and what to watch out for.
- Section **15** is a **suggested live demo script** — run it on screen at the end.
- Section **16** is a **handover checklist** to make sure nothing is missed.

Keep `README.md` and the `docs/` folder open in another tab — this briefing points to them throughout.

---

## 1. The elevator pitch (open with this)

> **"Copilot Architect is an internal, local-first tool that makes AI coding agents — GitHub Copilot, Codex,
> Claude Code — actually understand our repositories before they write code."**

**What to say:**

- The problem: AI coding agents are powerful but _context-blind_. You ask "add an invoice approval workflow" and the
  agent guesses at our conventions, file layout, frameworks, and test strategy.
- Copilot Architect sits _in front of_ the agent. It analyzes the repo, builds a searchable map, finds similar existing
  features, generates a detailed implementation **plan**, and only then hands a precise prompt to the coding agent.
- It also runs **safe validation**, produces **review reports**, and enforces a **safety policy** — all locally.
- **Nothing leaves the machine.** No cloud backend, no vector DB, no telemetry. That's the headline for security-minded teammates.

**One-liner from `package.json`:** _"TypeScript/Node.js-first internal tool for repo-aware coding agent workflows."_

- **Current version:** `0.1.0` in `package.json`, `0.1.1` in the changelog (internal MVP).
- **Status:** MVP complete — all planned phases implemented, **147 tests passing**.

---

## 2. The core idea / mental model

**What to say — describe the end-to-end flow the tool enables:**

A developer types a high-level task like _"Add invoice approval workflow based on the current repo,"_ and the tool:

1. **Analyzes** the current repo (or a multi-repo workspace).
2. **Detects** languages, frameworks, package managers, build systems, and test systems.
3. Builds a **repo map** and a **local searchable index**.
4. **Finds similar** existing features and patterns.
5. **Generates a detailed implementation plan** (Markdown + JSON).
6. **Requires human approval** — plans are never auto-applied.
7. **Generates a custom handoff prompt** for Copilot / Codex / Claude Code.
8. **Runs safe validation** commands (build / test / lint / format).
9. **Generates a review report** from the git diff + validation evidence.
10. Exposes all of this through a **CLI** and a **local MCP server**.
11. **Generates and maintains** custom Copilot agents and workspace instructions.

> The key framing: **Copilot Architect plans and validates; the AI agent implements; a human approves the gate in between.**

---

## 3. Architecture at a glance

**What to say:** "It's a TypeScript **monorepo** using npm workspaces. The design rule is strict: **all business logic
lives in `packages/`, and the UI shells are thin.** Two entry points sit on top of that logic — a **CLI** (primary) and a
**local MCP server** — and both call the _same_ package APIs, so behavior never diverges."

```
                        ┌──────────────────────────────────────────────┐
   Human / Developer    │   Entry points (thin orchestration only)     │
        │               │                                              │
        ├─ terminal ───▶│  CLI  (packages/cli)  ── 23 commands         │
        │               │                                              │
   AI agent host ──────▶│  MCP server (packages/mcp-server) ── 21 tools│
   (Copilot Chat,       │                                              │
    Claude, Codex)      │  VS Code ext / Web UI  (thin shells →        │
        │               │       they just shell out to the CLI)        │
        │               └───────────────────┬──────────────────────────┘
        │                                   │  both call the same package APIs
        ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Business logic packages                            │
│                                                                          │
│  shared ◀── adapters ◀── core ◀── indexer ◀── planner ── reviewer        │
│    ▲           (lang/    (repo    (search)   (plans/    (review          │
│    │          framework  discovery)          handoff)    reports)        │
│    │          detection)     ▲                                           │
│    │                         │                                           │
│  validator (safety policy, command risk, secret redaction, audit) ───────│
│  agents (Copilot agent templates) · instructions (Copilot instructions)  │
└─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
   Local artifacts on disk:  .copilot-architect/   and   .github/ , .vscode/mcp.json
```

**Two design principles to emphasize:**

1. **CLI-first** — the CLI is the primary local entry point. It _orchestrates_ package APIs; it never re-implements
   detection, planning, validation, review, or generation logic.
2. **MCP-first** — the MCP server is a first-class peer to the CLI (not an afterthought), because agent hosts need
   _structured_ access to repo maps, plans, validation evidence, and policy. It uses the official TypeScript MCP SDK
   over stdio and calls the same package APIs.

**The golden rule (repeat this to the team):**

> _"Business logic must never live inside a UI shell. `vscode-extension` and `web` only call CLI/core/MCP services."_

---

## 4. Why these technology choices (the "decisions" slide)

**What to say — this pre-empts the "why not X?" questions:**

| Decision                         | Rationale                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript / Node.js-first**   | Most of our target repos are Python, Java, JS/TS, Angular, React, Node, monorepos. Explicitly **not** C#/.NET (that was a hard requirement). |
| **Monorepo via npm workspaces**  | Clear package boundaries, shared domain models, single build (`tsc -b`), no publishing overhead.                                             |
| **Local-first, no cloud**        | Repo data never leaves the machine. No vector DB, no backend, telemetry off by default. Big trust win for internal adoption.                 |
| **JSON index (not a vector DB)** | MVP keeps dependencies minimal — keyword index in `index.json`. Can graduate to SQLite/vectors later if needed.                              |
| **MCP as a first-class surface** | It's the standard protocol agent hosts (Copilot Chat, Claude) speak. Gives us structured tool access for free.                               |
| **Minimal dependencies**         | TypeScript, Node, Vitest, and the MCP SDK. Focused deps only when they remove real risk.                                                     |

**Out of scope for the MVP (say this so expectations are set):** Visual Studio VSIX, WPF/Blazor UI, a .NET engine,
commercial marketplace packaging, heavy vector DB / cloud backend, enterprise installer. These are _future optional wrappers_.

---

## 5. The packages — walk through each one

**What to say:** "There are **13 packages**. Here's what each owns. Notice the dependency direction always flows
_inward_ toward `shared` — nothing depends on the CLI except the user."

| Package                | Owns                                                                                                                                                                                           | ~Size               | Depends on (internal)                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| **`shared`**           | Serializable domain models, constants, artifact path helpers, JSON/trust utilities. The vocabulary everything speaks.                                                                          | ~717 LOC            | — (base of the graph)                             |
| **`adapters`**         | Language/framework/toolchain detection. One adapter per stack + a registry with confidence scoring + a generic fallback.                                                                       | ~2,650 LOC          | shared                                            |
| **`core`**             | Repo discovery, multi-repo **workspace** service, and **advanced analysis** (architecture/route/test detection, risk scoring, diagnostics).                                                    | ~2,150 LOC          | adapters, shared                                  |
| **`indexer`**          | Local file **indexing** and keyword **search** (single repo + across-workspace).                                                                                                               | ~860 LOC            | core, shared                                      |
| **`planner`**          | **Feature planning**, **handoff** prompt generation, and **workspace** (cross-repo) planning.                                                                                                  | ~1,780 LOC          | core, indexer, validator, shared                  |
| **`validator`**        | The **safety + validation engine**: validation runner, safety policy, command risk assessment, secret redaction, audit log, git checkpoint, rollback guides, artifact cleanup, command config. | ~2,690 LOC          | core, shared                                      |
| **`reviewer`**         | **Review report** generation from git diff + plan + validation evidence.                                                                                                                       | ~770 LOC            | shared                                            |
| **`agents`**           | Generates the **7 custom Copilot agent** templates (`.agent.md`).                                                                                                                              | ~1,040 LOC          | shared                                            |
| **`instructions`**     | Generates **Copilot instructions** (`.github/copilot-instructions.md`), prompts, and skill files.                                                                                              | ~850 LOC            | core, shared                                      |
| **`mcp-server`**       | The **local MCP server** + its 21 tools. Thin orchestration over the other packages.                                                                                                           | ~625 LOC            | agents, core, indexer, planner, validator, shared |
| **`cli`**              | The **CLI entry point** — argument parsing + command routing for all 23 commands. The `copilot-architect` binary.                                                                              | ~3,020 LOC (1 file) | _all of the above_                                |
| **`vscode-extension`** | **Thin** VS Code shell: activity bar view, command palette, `@architect` chat participant. Shells out to the CLI.                                                                              | ~1,460 LOC          | — (no business logic)                             |
| **`web`**              | **Thin** optional local web UI shell (`serve` command). Local-only, binds to `127.0.0.1`.                                                                                                      | ~740 LOC            | — (no business logic)                             |

**Talking point on the dependency graph:**
`shared` is the foundation → `adapters` → `core` → `indexer`/`validator` → `planner`/`reviewer`/`mcp-server` → `cli` on top.
The two UI shells have **zero** internal package dependencies because they only ever call the CLI. That's the architecture rule made visible.

---

## 6. Features & capabilities — the workflow story

**What to say:** "Rather than list features flatly, let me walk the actual workflow a developer follows."

### Stage 1 — Understand the repo

- **`init`** — scaffolds `.copilot-architect/` with `commands.json` (custom commands) and `policy.json` (safety policy).
- **`analyze`** — adapter-based detection of languages, frameworks, package managers, build/test commands; writes `repo-map.json`.
- **`index`** — builds the local JSON search index (supports full, incremental, and rebuild modes).
- **`search "query"`** — keyword search over the index with scoring.
- **`diagnostics`** — reports repo readiness and intelligence gaps (missing tests, stale index, no build script, etc.).

### Stage 2 — Plan a feature

- **`plan "feature"`** — the heart of the tool. Reads the repo map, refreshes the index, runs similar-feature search,
  and emits a deterministic **plan** (`.md` + `.json`) containing: request interpretation, architecture summary, relevant
  files, similar features, impacted stacks/modules, likely files to modify/create, frontend/backend/data/config/security/perf
  impacts, **test strategy**, validation commands, **step-by-step implementation**, risks, assumptions, open questions, and a
  **human approval checkpoint**. Planning is **read-only** for application code.

### Stage 3 — Set up the AI agents

- **`agents install`** — installs **7 Copilot agents** under `.github/agents/` (see §8).
- **`instructions generate`** — writes `.github/copilot-instructions.md`, `.github/prompts/*`, and `.github/skills/*`.
- **`mcp config`** — writes `.vscode/mcp.json` so Copilot Chat can connect to our MCP server.

### Stage 4 — Approve & hand off (the human gate)

- **`handoff --plan latest --approve`** — generates a ready-to-paste implementation prompt for the coding agent.
  **Requires `--approve`** — this is the deliberate human sign-off gate. Copies to clipboard where possible.

### Stage 5 — Validate & review

- **`validate [--build|--test|--lint|--format]`** — runs _allowed_ commands with no shell, with timeouts/retries and
  redacted streaming output; writes validation reports under `runs/`.
- **`review --plan latest --validation latest`** — diffs actual changes against the approved plan + validation evidence;
  flags unexpected files, missing tests, security-sensitive changes, possible breaking changes; emits an `@CodeReviewer` prompt.

### Stage 6 — Multi-repo workspaces

- **`workspace init / add / show / remove`** — register multiple repos with roles (e.g. `backend`, `frontend`).
- **`workspace index / search / impact / plan / validate-plan`** — index, search, analyze cross-repo impact, and plan
  across all registered repos at once.

### Stage 7 — Maintenance & ops

- **`status`** — artifact summary. **`audit list`** — view the audit log. **`cleanup --dry-run|--apply`** — retention cleanup
  (dry-run by default, preserves `latest-*` aliases). **`doctor`** — environment check (Node ≥ 20.11, packages, setup).
  **`demo`** — a 4-step end-to-end smoke test (analyze → index → search → diagnostics). **`version`**, **`serve`** (web UI), **`mcp`** (start server).

---

## 7. CLI command reference (the cheat sheet)

**What to say:** "Everything runs through `npm run cli -- <command>` from source, or just `copilot-architect <command>`
if you `npm link` it. There are **23 commands**."

| Command                                                                                 | What it does                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `demo`                                                                                  | End-to-end demo: analyze → index → search → diagnostics             |
| `init`                                                                                  | Create `.copilot-architect/` artifacts (commands.json, policy.json) |
| `analyze`                                                                               | Analyze repo/workspace, write `repo-map.json`                       |
| `index`                                                                                 | Build the local search index                                        |
| `search "q"`                                                                            | Search the local index                                              |
| `plan "feature"`                                                                        | Generate a feature implementation plan                              |
| `commands list / validate`                                                              | List or validate detected + custom commands                         |
| `validate`                                                                              | Run safe build/test/lint/format commands                            |
| `review`                                                                                | Generate a review report from git diff + validation                 |
| `handoff`                                                                               | Generate implementation handoff prompt (**requires `--approve`**)   |
| `agents install / list / validate / update / doctor`                                    | Manage the 7 Copilot agent templates                                |
| `instructions preview / generate / validate`                                            | Manage Copilot instructions + skills                                |
| `workspace init / show / add / remove / index / search / impact / plan / validate-plan` | Multi-repo workspace ops                                            |
| `policy show / validate`                                                                | Inspect/validate the safety policy                                  |
| `audit list`                                                                            | List audit log entries                                              |
| `cleanup`                                                                               | Preview/apply artifact retention cleanup                            |
| `diagnostics`                                                                           | Repo readiness + intelligence gaps                                  |
| `status`                                                                                | Local Copilot Architect status                                      |
| `doctor`                                                                                | Environment check (Node version, packages, setup)                   |
| `mcp` / `mcp config`                                                                    | Start the MCP server / write `.vscode/mcp.json`                     |
| `serve`                                                                                 | Start the optional local web UI                                     |
| `version`                                                                               | Print version / schema / runtime info                               |

**Common flags:** `--json` (structured output for automation), `--path PATH` (target repo/workspace), `--root PATH`
(treat as repo root, skip git-root climbing), `--help` (per-command help).

---

## 8. AI agent integration — Copilot Chat & MCP

**What to say:** "This is the part that connects to the actual coding agents. Two pieces: the **MCP server** (structured
tools) and the **generated agent files** (personas)."

### The MCP server — 21 repo-intelligence tools

Start with `npm run cli -- mcp [--path <repo>]`. Tools call the same package logic as the CLI and return structured JSON.
Grouped:

- **Maps:** `repo_map`, `workspace_map`
- **Detection:** `detect_languages`, `detect_frameworks`, `detect_package_managers`, `detect_build_commands`, `detect_test_commands`
- **Search & impact:** `search_repo`, `search_across_repos`, `find_similar_feature`, `find_impacted_files`, `analyze_impact`, `analyze_cross_repo_impact`
- **Planning:** `generate_plan_context` (read-only), `generate_feature_plan` (**requires `approved=true`** to write artifacts)
- **Evidence & policy:** `get_validation_commands`, `get_safety_policy`, `get_latest_plan`, `get_latest_validation`, `get_latest_review`, `agent_status`

> _Note: docs occasionally say "20 tools" — the server actually registers 21. Worth correcting in passing._

### The 7 generated Copilot agents (`.github/agents/*.agent.md`, model `gpt-4o`)

| Agent                  | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `@FeatureArchitect`    | Analyze repo, find patterns, produce a plan — **no code edits** |
| `@FeatureImplementer`  | Implement an approved plan with minimal changes                 |
| `@CodeReviewer`        | Review diff against the approved plan + validation evidence     |
| `@TestPlanner`         | Map features to test coverage strategies                        |
| `@Debugger`            | Classify validation failures, propose minimal fixes             |
| `@SecurityReviewer`    | Review changes for security risks                               |
| `@PerformanceReviewer` | Identify performance concerns                                   |

They include built-in **handoffs**: `FeatureArchitect → FeatureImplementer → CodeReviewer → Debugger` (when validation fails).

### Connecting Copilot Chat (the setup the team will actually run)

```bash
npm run cli -- agents install        # .github/agents/*.agent.md
npm run cli -- instructions generate # .github/copilot-instructions.md + prompts + skills
npm run cli -- mcp config            # .vscode/mcp.json
npm run cli -- agents doctor         # explains usage
```

Then in VS Code: Command Palette → **MCP: List Servers** → start `copilotArchitect` → open Copilot Chat in **Agent mode** → enable the tools.

---

## 9. Safety & security model (don't skip this — it's a selling point)

**What to say:** "Because this runs commands and feeds prompts to agents, safety is built into the `validator` package,
not bolted on. Four layers:"

1. **Local-first.** No code leaves the machine. No cloud backend, telemetry off by default.
2. **Blocked-command policy** (`DEFAULT_BLOCKED_PATTERNS` in `packages/validator/src/safety-policy-service.ts`):
   - `rm -rf`, `del /s`, `format`, `diskpart`, `git clean -fdx`, `git reset --hard`, `chmod -R 777`, `sudo rm`, `Remove-Item -Recurse`
   - Anything that tries to run **outside the workspace root** (path boundary enforcement).
   - Commands run **without a shell**, only from a vetted **allowlist** of safe executables (node, npm, pnpm, yarn, bun, deno, tsc, pytest, mvn, gradle, cargo, go, dotnet, etc.).
3. **Secret redaction** (`SecretRedactionService`) — scrubs logs, audit entries, validation reports, and handoffs of:
   env vars containing `TOKEN`/`SECRET`/`PASSWORD`/`API_KEY`/…, AWS keys, GCP keys, Stripe keys, PEM private key blocks,
   JWTs, DB connection strings (postgres/mysql/mongodb/redis/mssql), npm tokens, Slack tokens, Bearer headers, GitHub PATs.
4. **Audit + approval gates** — every mutating action is appended to `.copilot-architect/audit/audit.jsonl` (timestamp,
   actor, summary, artifact paths, secrets redacted). `handoff` **always** requires `--approve`. `cleanup` is dry-run by
   default and only ever touches `.copilot-architect/` retention dirs. Git checkpoints + rollback guides are captured for recovery.

> Reference: `docs/SECURITY_MODEL.md`.

---

## 10. File & directory structure

**What to say:** "Here's the repo layout. Three things to know: source lives in `packages/`, **runtime output** lives in
`.copilot-architect/`, and **Copilot integration files** land in `.github/` and `.vscode/`."

### Repository layout

```
Copilot_Assistant/
├── packages/                 ← all source (13 packages, see §5)
│   ├── shared/  core/  adapters/  indexer/  planner/  validator/
│   ├── reviewer/  agents/  instructions/  mcp-server/  cli/
│   └── vscode-extension/  web/
├── docs/                     ← 17 product docs (architecture, security, roadmap, …)
├── samples/                  ← 8 sample repos for testing detection (react, angular,
│                                python, java-maven, java-gradle, node-api, polyglot, generic)
├── tests/                    ← 33 Vitest files, 147 tests (integration + e2e)
├── templates/                ← agent / instruction / skill templates
├── scripts/                  ← setup.sh/.ps1, check-env.sh/.ps1, package-local.mjs
├── .copilot-architect/       ← the tool's OWN runtime artifacts (it dogfoods itself)
├── .github/workflows/        ← ci.yml, release-check.yml
├── .vscode/                  ← launch.json, tasks.json
├── README.md                 ← primary user-facing reference
├── AGENTS.md                 ← project brief / build directives
├── Requirement.md            ← original requirements
├── CHANGELOG.md              ← version history (0.1.0 → 0.1.1)
├── package.json              ← workspace root (scripts, engines: node ≥ 20.11)
├── tsconfig.json / eslint.config.js / vitest.config.ts / .prettierrc
```

### Generated runtime artifacts (created by the tool, per target repo)

```
.copilot-architect/
├── repo-map.json          ← analyze output (UniversalRepoMap)
├── commands.json          ← custom command config
├── policy.json            ← safety policy
├── workspace.json         ← multi-repo config
├── index/                 ← index.json + status.json
├── plans/                 ← <timestamp>-plan.{json,md} + latest-plan.*
├── handoffs/              ← approved handoff prompts
├── runs/                  ← validation reports + logs
├── reviews/               ← review reports
├── audit/audit.jsonl      ← append-only audit log
└── diagnostics/

.github/
├── agents/*.agent.md            ← 7 Copilot agents
├── copilot-instructions.md
├── prompts/*.prompt.md
└── skills/*/SKILL.md
.vscode/mcp.json                 ← Copilot Chat MCP server config
```

> Every top-level artifact carries a `schemaVersion` field so future migrations are explicit.
> Artifact paths are centralized in `packages/shared` — never hard-code them.

---

## 11. Tech stack & tooling

**What to say — the boring-but-important slide:**

- **Language/runtime:** TypeScript 5.6, Node.js **≥ 20.11** (enforced in `engines`, checked by `doctor`), ES modules.
- **Build:** `tsc -b` (TypeScript project references across the workspace).
- **Tests:** **Vitest** — 147 tests across 33 files. **All must pass before merge.**
- **Lint/format:** ESLint 9 (flat config) + Prettier 3.
- **Key runtime dependency:** `@modelcontextprotocol/sdk` (only in `mcp-server`). Otherwise dependency-light.
- **CI:** `.github/workflows/ci.yml` runs install → format → lint → build → test on PRs and pushes.

---

## 12. How to build, run, and test (do this live if you can)

```bash
# First-time setup (installs, builds, tests, verifies)
scripts/setup.sh                 # macOS/Linux
.\scripts\setup.ps1              # Windows PowerShell

# Manual equivalent
npm install
npm run build                    # tsc -b across all packages
npm test                         # 147 Vitest tests
npm run cli -- doctor            # environment check
npm run cli -- demo              # end-to-end smoke test on this repo

# Day-to-day
npm run cli -- <command>         # run any CLI command from source
npm run lint                     # ESLint
npm run format                   # Prettier check (format:write to fix)
```

**Talking point:** the tool **dogfoods itself** — there's already a populated `.copilot-architect/` folder in this repo
from running `analyze`/`index`/`plan` against its own source. Good way to show real output without setup.

---

## 13. Distribution model (how teammates get it)

**What to say:** "This is **not** a commercial product. It's internal team sharing with minimal setup. Three options:"

1. **Git clone + `scripts/setup.sh`** — recommended for active development.
2. **`npm link --workspace @copilot-architect/cli`** — gives a global `copilot-architect` command. Rebuild after pulling.
3. **`npm run package:local`** — builds a tarball under `dist/release/copilot-architect-<version>.tgz` to hand to teammates.

> Reference: `docs/INSTALLATION.md`, `docs/INTERNAL_TEAM_SETUP.md`.

---

## 14. Gotchas, conventions & "things I'd tell my replacement"

**What to say — the honest handover notes:**

- **The architecture rule is load-bearing.** If someone adds detection/planning logic into `cli`, `vscode-extension`, or
  `web`, that's a bug — it belongs in a `packages/*` service. Code review for this.
- **Always go through `packages/shared`** for artifact paths and domain models. Don't hard-code `.copilot-architect/...` strings.
- **Plans/handoffs are deterministic** by design (stable output) — keep them that way so tests and diffs stay meaningful.
- **`--approve` is sacred.** The handoff approval gate is the human checkpoint; don't add a bypass.
- **Version mismatch:** `package.json` says `0.1.0`, the changelog says `0.1.1`. Reconcile before any release.
- **"20 vs 21 tools":** the docs say 20 MCP tools; the server registers 21. Update the docs when you touch them.
- **Develop phase-by-phase** (the established style): implement → add tests → `npm test` → update docs → `npm run build`
  (zero TS errors) → summarize → list limitations.
- **The `samples/` repos are fixtures** — tests copy them to temp dirs; don't mutate the tracked sample files.

---

## 15. Suggested live demo script (10 minutes, run on screen)

```bash
# 1. Prove the environment is sane
npm run cli -- doctor

# 2. One command that tells the whole story
npm run cli -- demo
#    → watch it analyze → index → search → diagnostics and print next steps

# 3. Show real analysis output (the tool on itself)
npm run cli -- analyze
npm run cli -- search "validation"

# 4. Generate an actual plan and open it
npm run cli -- plan "Add a slack notification when validation fails"
#    → open .copilot-architect/plans/latest-plan.md  ← show the structured plan

# 5. Show the Copilot integration files it can produce
npm run cli -- agents list
npm run cli -- instructions preview

# 6. Show safety in action
npm run cli -- policy show
npm run cli -- audit list

# 7. (Optional) start the MCP server / web UI
npm run cli -- mcp        # Ctrl-C to stop
npm run cli -- serve      # opens local web UI on 127.0.0.1
```

End the demo on the **plan Markdown file** — it's the most concrete "aha" artifact.

---

## 16. Handover checklist

Use this to confirm the team is set up before you step away:

- [ ] Everyone has cloned the repo and run `scripts/setup.sh` successfully (`doctor` is green).
- [ ] Everyone has run `npm run cli -- demo` once and seen output.
- [ ] Walked through `README.md` and the `docs/` index together.
- [ ] Showed where business logic lives (`packages/`) vs. the thin shells (`vscode-extension`, `web`).
- [ ] Demonstrated `plan` → `handoff --approve` → `validate` → `review` end to end.
- [ ] Connected Copilot Chat to the MCP server on at least one machine.
- [ ] Reviewed the safety model + audit log location.
- [ ] Agreed who owns: releases/versioning, the safety policy, and the docs.
- [ ] Pointed to `docs/ROADMAP.md` for what's intentionally _not_ built yet.

---

## 17. Where to read more (the docs index)

All under `docs/`:

| Doc                                                   | Covers                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `ARCHITECTURE.md`                                     | Full architecture, package responsibilities, phase notes |
| `PRODUCT_SPEC.md` / `MVP_DEFINITION.md`               | What the product is and the MVP scope                    |
| `INSTALLATION.md` / `INTERNAL_TEAM_SETUP.md`          | Setup and team onboarding                                |
| `LANGUAGE_SUPPORT.md`                                 | Supported stacks and detection details                   |
| `MCP_TOOLS.md`                                        | MCP tool reference                                       |
| `AGENT_WORKFLOWS.md`                                  | How the Copilot agents are meant to be used              |
| `SECURITY_MODEL.md`                                   | The full safety/security model                           |
| `VSCODE_EXTENSION.md`                                 | VS Code extension usage                                  |
| `TESTING_STRATEGY.md`                                 | How testing is organized                                 |
| `ROADMAP.md` / `RELEASE_PLAN.md` / `UPGRADE_GUIDE.md` | Future direction and releases                            |
| `TROUBLESHOOTING.md`                                  | Common issues                                            |
| `AGENTS.md` (root)                                    | The original project brief / build directives            |

---

_Prepared as a handover briefing. Pair it with a live run of §15 and leave it in the repo root for the team to keep._
