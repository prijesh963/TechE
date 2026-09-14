# Copilot Architect

Copilot Architect is a TypeScript/Node.js-first internal team tool for making AI coding agents more repo-aware. It analyzes repositories, detects languages and frameworks, builds a local searchable index, generates feature implementation plans, runs safe validation, creates custom Copilot agents and workspace instructions, exposes repo intelligence through a local MCP server, and produces review reports — all without sending your code anywhere.

---

## Quick Start

```bash
git clone <internal-repo-url>
cd copilot-architect
scripts/setup.sh          # installs, builds, tests, verifies
npm run cli -- demo       # end-to-end demonstration on the current repo
```

On Windows PowerShell:

```powershell
.\scripts\setup.ps1
npm run cli -- demo
```

**Minimum requirement:** Node.js 20.11 or newer. Run `npm run cli -- doctor` to verify your environment.

---

## Installation

### Option 1 — Run from source (recommended)

```bash
npm install
npm run build
npm test
npm run cli -- version
npm run cli -- doctor
```

### Option 2 — npm link (global command)

```bash
npm install && npm run build
npm link --workspace @copilot-architect/cli
copilot-architect version
copilot-architect doctor
```

Rebuild after pulling updates:

```bash
npm run build
copilot-architect version
```

Remove the link:

```bash
npm unlink --global @copilot-architect/cli
```

### Option 3 — Local tarball for teammates

```bash
npm run package:local
# outputs dist/release/copilot-architect-<version>.tgz
```

---

## All CLI Commands

Run any command with `npm run cli -- <command> [flags]` or `copilot-architect <command> [flags]` if you used npm link.

| Command                      | Description                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `demo`                       | **Quick end-to-end demo** — analyze, index, search, diagnostics                       |
| `init`                       | Initialize `.copilot-architect/` artifacts (commands.json, policy.json)               |
| `analyze`                    | Analyze the repo or workspace and write `repo-map.json`                               |
| `graph`                      | Build the symbol/dependency graph and write `graph.json`                              |
| `index`                      | Build the local searchable file index                                                 |
| `search "query"`             | Search the local index                                                                |
| `plan "feature"`             | Generate a feature implementation plan (revision 1)                                   |
| `plan revisions`             | List a plan's revisions with status and approval state                                |
| `plan show`                  | Show a plan revision (defaults to the latest draft)                                   |
| `plan approve`               | Approve a specific revision (`--revision <n> --by <name>`)                            |
| `commands list`              | List detected + custom validation commands                                            |
| `commands validate`          | Validate `.copilot-architect/commands.json`                                           |
| `validate`                   | Run safe build/test/lint/format commands                                              |
| `review`                     | Generate a review report from git diff + validation evidence                          |
| `review resolve`             | Accept or decline a review finding by id (`--finding-id --decision --reason --by`)    |
| `handoff`                    | Generate an implementation handoff prompt (requires `--approve` and an approved plan) |
| `agents install`             | Install custom Copilot agent templates under `.github/agents/`                        |
| `agents list`                | List available agent templates                                                        |
| `agents validate`            | Validate installed agent files                                                        |
| `agents update`              | Update existing agents (backs up first)                                               |
| `agents doctor`              | Explain how to use installed agents                                                   |
| `instructions preview`       | Preview `.github/copilot-instructions.md`                                             |
| `instructions generate`      | Write instructions and skill files                                                    |
| `instructions validate`      | Validate generated instructions                                                       |
| `workspace init`             | Create `.copilot-architect/workspace.json`                                            |
| `workspace show`             | Show workspace repos and roles                                                        |
| `workspace add`              | Add a repo to the workspace                                                           |
| `workspace remove`           | Remove a repo from the workspace                                                      |
| `workspace index`            | Index all repos in the workspace                                                      |
| `workspace search "query"`   | Search across all workspace repos                                                     |
| `workspace impact "feature"` | Analyze cross-repo impact                                                             |
| `workspace plan "feature"`   | Generate a multi-repo plan                                                            |
| `workspace validate-plan`    | Generate per-repo validation plans                                                    |
| `policy show`                | Show the current safety policy                                                        |
| `policy validate`            | Validate `.copilot-architect/policy.json`                                             |
| `audit list`                 | List audit log entries                                                                |
| `cleanup`                    | Preview or apply artifact retention cleanup                                           |
| `diagnostics`                | Report repo readiness and intelligence gaps                                           |
| `status`                     | Show Copilot Architect local status                                                   |
| `doctor`                     | Check environment (Node.js version, packages, setup)                                  |
| `mcp`                        | Start the local MCP server                                                            |
| `mcp config`                 | Write `.vscode/mcp.json` for Copilot Chat                                             |
| `serve`                      | Start the optional local web UI                                                       |
| `version`                    | Print the installed version                                                           |

### Common flags

```
--json          Structured JSON output
--path PATH     Target a specific repo or workspace directory
--root PATH     Treat PATH as the repo root (skip Git root climbing)
--help          Command help
```

---

## Typical Workflow

### 1. Initialize and analyze

```bash
npm run cli -- init                          # create commands.json and policy.json
npm run cli -- analyze                       # detect languages, frameworks, commands
npm run cli -- index                         # build local searchable index
npm run cli -- diagnostics                   # check repo readiness
npm run cli -- search "invoice"             # search the index
```

### 2. Plan a feature

```bash
npm run cli -- plan "Add invoice approval workflow"
# writes revision 1 to .copilot-architect/plans/latest-plan.md and latest-plan.json
```

Review the plan and revise as needed (each call edits the draft in place — nothing is discarded):

```bash
npm run cli -- plan revisions               # list revisions with status
npm run cli -- plan show --revision 1       # inspect a specific revision
```

Once the plan looks right, approve the exact revision — approval is required before a handoff can be generated:

```bash
npm run cli -- plan approve --revision 1 --by "your-name"
npm run cli -- handoff --plan latest --approve
# copies prompt to clipboard and writes .copilot-architect/handoffs/latest-handoff.md
```

### 3. Set up Copilot agents and instructions

```bash
npm run cli -- agents install                # installs .github/agents/*.agent.md
npm run cli -- instructions generate         # writes .github/copilot-instructions.md
npm run cli -- mcp config                    # writes .vscode/mcp.json
npm run cli -- agents doctor                 # explains how to use @FeatureArchitect etc.
```

### 4. Validate and review

```bash
npm run cli -- validate --test               # run detected test commands
npm run cli -- validate --lint               # run lint commands
npm run cli -- review --plan latest          # review diff vs approved plan
```

### 5. Workspace (multi-repo)

```bash
npm run cli -- workspace init
npm run cli -- workspace add customer-api ../customer-api --role backend
npm run cli -- workspace add customer-web ../customer-web --role frontend
npm run cli -- workspace index
npm run cli -- workspace search "authentication"
npm run cli -- workspace plan "Add SSO login"
```

### 6. Cleanup and maintenance

```bash
npm run cli -- status                        # show artifact summary
npm run cli -- cleanup --dry-run             # preview eligible artifacts
npm run cli -- cleanup --apply               # delete eligible artifacts
```

---

## GitHub Copilot Chat Integration

Copilot Architect integrates with GitHub Copilot Chat through supported repository customization files — it does not modify Copilot internals.

### Setup

```bash
npm run cli -- agents install        # .github/agents/*.agent.md
npm run cli -- instructions generate # .github/copilot-instructions.md and skills
npm run cli -- mcp config            # .vscode/mcp.json
npm run cli -- agents doctor         # explains usage
```

### Connect Copilot Chat To Copilot Architect MCP

1. Open the target repo in VS Code.
2. Run `npm run cli -- mcp config --path /path/to/target-repo`.
3. Open Command Palette → `MCP: List Servers`.
4. Start `copilotArchitect`.
5. Open Copilot Chat, switch to Agent mode, enable Copilot Architect tools.

Or start the MCP server directly:

```bash
npm run cli -- mcp --path /path/to/target-repo
```

### Installed Agents

| Agent                  | Purpose                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@FeatureArchitect`    | Analyze repo, find existing patterns, produce a detailed implementation plan — no code edits                                               |
| `@FeatureImplementer`  | Implement an approved plan with minimal, scoped changes and captured validation evidence                                                   |
| `@CodeReviewer`        | Review diff against approved plan; separate blocking from advisory findings                                                                |
| `@TestPlanner`         | Map features to unit, integration, and regression test coverage                                                                            |
| `@Debugger`            | Classify build/test/lint failures and propose the smallest correct fix                                                                     |
| `@SecurityReviewer`    | Review changes for auth, input validation, secrets handling, and access control                                                            |
| `@PerformanceReviewer` | Identify performance regressions in loops, queries, rendering, and caching                                                                 |
| `@DocumentationWriter` | Generate or update README, JSDoc/docstrings, and API docs following the repo's existing style                                              |
| `@DependencyAuditor`   | Audit dependencies for outdated packages, known CVEs, and licensing issues                                                                 |
| `@APIDesignReviewer`   | Review REST/GraphQL API changes for naming consistency, breaking changes, and auth coverage                                                |
| `@CodeAnalysisAgent`   | Scan the full codebase, map execution flows and module connections, identify issues, and produce an end-to-end system understanding report |

All agents use `gpt-4o`. Each installed agent file includes a **Repo Context** section auto-generated from `.copilot-architect/repo-map.json` at install time (languages, frameworks, test/build commands, entry points, architectural patterns), so agents understand your stack without needing to re-discover it.

### Example Chat Prompts

**Plan a feature:**

```text
@FeatureArchitect I want to add [describe feature]. Call repo_map and find_similar_feature
first, then produce a detailed implementation plan with impacted files and test strategy.
Do not modify any code yet.
```

**After plan approval:**

```text
@FeatureImplementer Implement the approved plan from .copilot-architect/plans/latest-plan.md.
Call get_latest_plan, make the minimal scoped change, add tests, then run
get_validation_commands and capture evidence.
```

**After implementation:**

```text
@CodeReviewer Review the implementation diff against the approved plan. Call get_latest_plan
and get_latest_validation, then report blocking findings and advisory findings separately.
```

**If validation failed:**

```text
@Debugger The last validation run failed. Call get_latest_validation to load the failing
output, classify the failure, find the root cause with search_repo, and propose the
smallest fix.
```

**Update documentation:**

```text
@DocumentationWriter Update the documentation for [feature]. Call repo_map and
get_latest_plan, match the existing docs style, then update the README and add JSDoc
comments to any new exported symbols.
```

**Audit dependencies:**

```text
@DependencyAuditor Audit project dependencies. Call detect_package_managers, find all
manifests, and produce a prioritised table: package | current version | recommended
version | reason | breaking changes.
```

**Full codebase analysis:**

```text
@CodeAnalysisAgent Scan this codebase and produce a full system understanding report.
Call repo_map first, trace execution flows from entry points, map module dependencies,
identify data flows, and flag issues. Include a quick-reference index of the 20 most
important files.
```

**Review an API change:**

```text
@APIDesignReviewer Review the proposed API changes. Call search_repo to map the existing
API surface, compare it to get_latest_plan, and report breaking changes, naming
inconsistencies, and missing auth coverage.
```

---

## Supported Languages and Toolchains

### Deep support (adapter-detected)

| Language / Framework    | Detection                                              | Commands                          |
| ----------------------- | ------------------------------------------------------ | --------------------------------- |
| JavaScript / TypeScript | package.json, tsconfig.json, eslint, prettier          | npm, pnpm, yarn, bun              |
| React                   | react dependency, Vite React plugin, Next.js           | npm test, npm run build           |
| Angular                 | angular.json, @angular/core                            | ng build, ng test                 |
| Python                  | pyproject.toml, requirements.txt, setup.py, pytest.ini | pytest, python3, poetry, uv, ruff |
| Java Maven              | pom.xml, mvnw                                          | mvn test, mvn package             |
| Java Gradle             | build.gradle, gradlew                                  | gradle test, gradle build         |

### Extended toolchain support

The validation safety layer also allows: `bun`, `deno`, `npx`, `tsc`, `biome`, `cargo`, `go`, `rustfmt`, `dotnet`, `vitest`, `jest`, `mocha`, `playwright`, `cypress`, `webpack`, `esbuild`, `turbo`, `nx`, `mypy`, `flake8`, `black`, `ruff`, `pylint`, and more.

### Generic fallback (all repos)

Any repo not matched by a specific adapter gets file scanning, docs detection, config detection, import scanning, test file pattern detection, and custom command support.

---

## Safety and Security

Copilot Architect is **local-first**. Repo data never leaves your machine.

### What is blocked by default

- `rm -rf`, `del /s`, `format`, `diskpart`
- `git clean -fdx`, `git reset --hard`
- `chmod -R 777`, `sudo rm`, `Remove-Item -Recurse`
- Any command outside the workspace root

### Secret redaction

Logs, audit entries, validation reports, and handoffs automatically redact:

- Environment variables containing `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, etc.
- AWS access key IDs and secret access keys
- GCP API keys
- Stripe secret, publishable, and restricted keys
- PEM private key blocks
- JWT tokens
- Database connection strings (postgres, mysql, mongodb, redis, mssql)
- npm auth tokens
- Slack tokens (`xoxb-`, etc.)
- HTTP `Authorization: Bearer ...` headers
- GitHub personal access tokens (`ghp_`, `gho_`, etc.)

### Audit log

Every mutating action is written to `.copilot-architect/audit/audit.jsonl` with timestamp, actor, summary, and artifact paths — with secrets redacted.

### Human approval gate

`handoff` always requires `--approve`. Plans are never applied without explicit human sign-off.

---

## MCP Server Tools

Start: `npm run cli -- mcp [--path <repo>]`

| Tool                        | Description                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `repo_map`                  | Return the full UniversalRepoMap for the target repo                                                                                |
| `get_symbol_graph`          | Build (or rebuild) the symbol/dependency graph: file, class, function, and method nodes with imports/calls/extends/implements edges |
| `workspace_map`             | Return the workspace-level map for multi-repo configs                                                                               |
| `detect_languages`          | Detected languages with confidence                                                                                                  |
| `detect_frameworks`         | Detected frameworks                                                                                                                 |
| `detect_package_managers`   | Detected package managers                                                                                                           |
| `detect_build_commands`     | Build commands                                                                                                                      |
| `detect_test_commands`      | Test commands                                                                                                                       |
| `search_repo`               | Keyword search the local index                                                                                                      |
| `search_across_repos`       | Search across all workspace repos                                                                                                   |
| `find_similar_feature`      | Find files similar to a described feature                                                                                           |
| `find_impacted_files`       | List files likely affected by a change                                                                                              |
| `analyze_impact`            | Summarize impact analysis for a feature request                                                                                     |
| `analyze_cross_repo_impact` | Cross-repo impact for workspace plans                                                                                               |
| `generate_plan_context`     | Return planning context without writing artifacts                                                                                   |
| `generate_feature_plan`     | Write plan revision 1 (requires `approved=true`; fails over an existing draft unless `restart=true`)                                |
| `revise_feature_plan`       | Edit the current draft in place with feedback, preserving revision history                                                          |
| `approve_plan`              | Approve one specific revision (`revision` required) and promote it to latest                                                        |
| `get_validation_commands`   | List safe validation commands                                                                                                       |
| `get_safety_policy`         | Return the active safety policy                                                                                                     |
| `get_latest_plan`           | Return the latest plan artifact                                                                                                     |
| `get_latest_validation`     | Return the latest validation report                                                                                                 |
| `get_latest_review`         | Return the latest review report                                                                                                     |
| `resolve_review_finding`    | Accept or decline one review finding by stable id (`reason` required for both)                                                      |
| `agent_status`              | Return installed agent status                                                                                                       |

---

## Artifact Locations

All runtime artifacts live under `.copilot-architect/` inside the repo root:

```
.copilot-architect/
├── repo-map.json             ← analyze output
├── graph.json                ← graph output (symbol/dependency graph)
├── commands.json             ← custom command config
├── policy.json               ← safety policy
├── workspace.json            ← multi-repo config
├── index/
│   ├── index.json            ← file index
│   └── status.json           ← index status
├── plans/
│   ├── <timestamp>-plan.json
│   ├── <timestamp>-plan.md
│   ├── latest-plan.json          ← mirrors the newest revision, or the
│   ├── latest-plan.md              approved one once approve_plan runs
│   ├── drafts/<planId>/
│   │   ├── rev-1.json            ← nothing is ever destroyed
│   │   ├── rev-1.md
│   │   ├── rev-2.json
│   │   └── rev-2.md
│   └── approved/
│       └── <planId>-rev<n>-plan.json  ← frozen copy from approve_plan
├── handoffs/
│   ├── <timestamp>-handoff.json
│   ├── <timestamp>-handoff.md
│   ├── latest-handoff.json
│   └── latest-handoff.md
├── runs/
│   ├── <timestamp>-validation.json
│   ├── <timestamp>-validation.md
│   └── <timestamp>-logs.txt
├── reviews/
│   ├── <timestamp>-review.json
│   ├── <timestamp>-review.md
│   ├── latest-review.*
│   └── dispositions.json     ← durable accept/decline record, keyed by finding id
├── audit/
│   └── audit.jsonl           ← append-only audit log
└── diagnostics/
```

GitHub Copilot Chat artifacts:

```
.github/
├── agents/
│   ├── FeatureArchitect.agent.md
│   ├── FeatureImplementer.agent.md
│   ├── CodeReviewer.agent.md
│   ├── TestPlanner.agent.md
│   ├── Debugger.agent.md
│   ├── SecurityReviewer.agent.md
│   ├── PerformanceReviewer.agent.md
│   ├── DocumentationWriter.agent.md
│   ├── DependencyAuditor.agent.md
│   ├── APIDesignReviewer.agent.md
│   └── CodeAnalysisAgent.agent.md
├── copilot-instructions.md
├── prompts/
│   ├── copilot-architect-plan.prompt.md
│   ├── copilot-architect-implement.prompt.md
│   ├── copilot-architect-review.prompt.md
│   └── copilot-architect-debug.prompt.md
└── skills/
    ├── feature-planning/SKILL.md
    ├── repo-analysis/SKILL.md
    ├── validation/SKILL.md
    ├── code-review/SKILL.md
    └── debugging/SKILL.md
.vscode/
└── mcp.json                  ← Copilot Chat MCP server config
```

---

## Development

```bash
npm run build     # compile all TypeScript packages
npm test          # run all 159 Vitest tests (11 agents)
npm run lint      # ESLint
npm run format    # Prettier check
npm run format:write  # Prettier fix
npm run package:local # build internal release tarball
```

### Project structure

```
copilot-architect/
├── packages/
│   ├── shared/          domain models, constants, artifact helpers
│   ├── core/            repo discovery, workspace service, advanced analysis
│   ├── adapters/        language/framework/toolchain adapters
│   ├── indexer/         file indexing and search
│   ├── graph/            symbol/dependency graph (classes, functions, imports, calls)
│   ├── planner/         feature planning, handoff, workspace planning
│   ├── validator/       validation engine, safety policy, audit, risk assessment
│   ├── reviewer/        review report generation
│   ├── agents/          Copilot agent template generation
│   ├── instructions/    Copilot instructions and skill generation
│   ├── mcp-server/      MCP server and tools
│   ├── cli/             CLI entry point
│   ├── vscode-extension VS Code extension shell
│   └── web/             optional local web UI shell
├── samples/             representative sample repos for testing
├── tests/               integration and e2e tests
├── docs/                product documentation
├── templates/           agent and instruction templates
└── scripts/             setup and packaging scripts
```

All business logic belongs in `packages/`. UI shells (`vscode-extension`, `web`) are thin shells that call CLI/core/MCP — they contain no business logic.

---

## Further Reading

- [Installation](docs/INSTALLATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Language Support](docs/LANGUAGE_SUPPORT.md)
- [MCP Tools](docs/MCP_TOOLS.md)
- [Agent Workflows](docs/AGENT_WORKFLOWS.md)
- [Plan Lifecycle Design](docs/PLAN_LIFECYCLE_DESIGN.md)
- [Security Model](docs/SECURITY_MODEL.md)
- [MVP Definition](docs/MVP_DEFINITION.md)
- [Roadmap](docs/ROADMAP.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Internal Team Setup](docs/INTERNAL_TEAM_SETUP.md)
