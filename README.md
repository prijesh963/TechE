# Copilot Architect

Copilot Architect is a TypeScript/Node.js-first internal team tool that grounds
AI coding agents in what is actually in your repository.

It analyzes repositories, detects languages and frameworks, builds a local
searchable index and symbol graph, generates feature plans a human approves,
applies them, runs safe validation, and produces review reports — all locally.
Nothing leaves your machine except what Copilot itself sends.

Two surfaces, for different situations: the **`@architect` VS Code extension**,
which walks one feature from analysis to review in a single session, and a
**local MCP server** exposing the same intelligence as 30 tools to any MCP
client.

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
| `intent "query"`             | Classify a query's intent and resolve likely components/tests/recent changes          |
| `plan "feature"`             | Generate a feature implementation plan (revision 1)                                   |
| `plan revisions`             | List a plan's revisions with status and approval state                                |
| `plan show`                  | Show a plan revision (defaults to the latest draft)                                   |
| `plan approve`               | Approve a specific revision (`--revision <n> --by <name>`)                            |
| `measure "feature"`          | Measure how much a plan's file selection narrows context vs the whole repo            |
| `commands list`              | List detected + custom validation commands                                            |
| `commands validate`          | Validate `.copilot-architect/commands.json`                                           |
| `validate`                   | Run safe build/test/lint/format commands                                              |
| `review`                     | Generate a review report from git diff + validation evidence                          |
| `review resolve`             | Accept or decline a review finding by id (`--finding-id --decision --reason --by`)    |
| `handoff`                    | Generate an implementation handoff prompt (requires `--approve` and an approved plan) |
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

### 3. Set up Copilot instructions and MCP

```bash
npm run cli -- instructions generate         # writes .github/copilot-instructions.md
npm run cli -- mcp config                    # writes .vscode/mcp.json
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

There are two ways in, and they are for different situations.

### The extension: `@architect`

The normal path. Install the VS Code extension (see
[docs/INSTALL.md](docs/INSTALL.md)) and drive a feature through four phases in
Copilot Chat:

| Type this                 | What it does                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@architect /analyze`     | Explains what is in the repo, grounded in a real index of the files.                                                                                  |
| `@architect /create-plan` | Turns the request into a plan you can read, correct, and approve: what the change does, what happens in each file, and the code as it stands today.   |
| `@architect /implement`   | Diffs what the plan comes to, then applies it on a click. The apply reports back as a notification — written, refused, and the checks the plan named. |
| `@architect /review`      | Compares what was built against what was approved.                                                                                                    |

A prompt with no slash command is treated as `/analyze`.

The session holds the feature, the decisions you have made and the approved
plan until you end it explicitly, so later phases do not re-ask what earlier
ones established. **Approve Plan** and **End Session** are buttons, not
phrases: the step that authorizes writing code must not depend on a model
reading approval out of "looks good to me".

```text
@architect /create-plan Add invoice approval to the billing service
```

Earlier versions installed eleven `@FeatureArchitect`-style agents under
`.github/agents/`. They are gone. A menu of eleven mentions in front of a
developer who wanted one thing is how a bug report about "the Code Analysis
Agent" turned out to describe a different system entirely — and coordination
written as "Step N: call X" in a markdown file is advisory, because a model
can skip it. The four phases are code, and code cannot skip its steps.

### MCP: everything outside the extension

The MCP server exposes the same repo intelligence as 30 tools, for plain
Copilot agent mode, Codex, Claude Code, or any other MCP client. This is the
interoperability surface, and the path that still works where policy forbids
installing extensions.

```bash
npm run cli -- mcp config --path /path/to/target-repo   # writes .vscode/mcp.json
npm run cli -- instructions generate                    # .github/copilot-instructions.md
```

Then in VS Code:

1. Command Palette → `MCP: List Servers`.
2. Start `copilotArchitect`.
3. Open Copilot Chat, switch to Agent mode, enable the Copilot Architect tools.

Or run the server directly:

```bash
npm run cli -- mcp --path /path/to/target-repo
```

Copilot Architect integrates through supported repository customization files
and the MCP protocol. It does not modify Copilot internals.

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

| Tool                        | Description                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo_map`                  | Return the full UniversalRepoMap for the target repo                                                                                                  |
| `get_symbol_graph`          | Build (or rebuild) the symbol/dependency graph: file, class, function, and method nodes with imports/calls/extends/implements edges                   |
| `workspace_map`             | Return the workspace-level map for multi-repo configs                                                                                                 |
| `detect_languages`          | Detected languages with confidence                                                                                                                    |
| `detect_frameworks`         | Detected frameworks                                                                                                                                   |
| `detect_package_managers`   | Detected package managers                                                                                                                             |
| `detect_build_commands`     | Build commands                                                                                                                                        |
| `detect_test_commands`      | Test commands                                                                                                                                         |
| `list_repo_files`           | Enumerate the indexed files as `path\|language\|kind\|symbols` lines, with per-language counts — use before searching when there is no query to guess |
| `search_repo`               | Hybrid search the local index (keyword + path/symbol + graph-connected + recency; see `signals` per result)                                           |
| `analyze_query_intent`      | Classify a query's intent (debugging/feature/refactor/test) and resolve likely components, tests, and recent changes                                  |
| `search_across_repos`       | Search across all workspace repos                                                                                                                     |
| `find_similar_feature`      | Find files similar to a described feature                                                                                                             |
| `find_impacted_files`       | List files likely affected by a change                                                                                                                |
| `analyze_impact`            | Summarize impact analysis for a feature request                                                                                                       |
| `analyze_cross_repo_impact` | Cross-repo impact for workspace plans                                                                                                                 |
| `generate_plan_context`     | Return planning context without writing artifacts                                                                                                     |
| `measure_context_reduction` | Measure a request's naive-whole-repo vs plan.relevantFiles context cost (file counts, bytes, estimated tokens, reduction %)                           |
| `generate_feature_plan`     | Write plan revision 1 (requires `approved=true`; fails over an existing draft unless `restart=true`)                                                  |
| `revise_feature_plan`       | Edit the current draft in place with feedback, preserving revision history                                                                            |
| `approve_plan`              | Approve one specific revision (`revision` required) and promote it to latest                                                                          |
| `get_validation_commands`   | List safe validation commands                                                                                                                         |
| `get_safety_policy`         | Return the active safety policy                                                                                                                       |
| `get_latest_plan`           | Return the latest plan artifact                                                                                                                       |
| `get_latest_validation`     | Return the latest validation report                                                                                                                   |
| `get_latest_review`         | Return the latest review report                                                                                                                       |
| `resolve_review_finding`    | Accept or decline one review finding by stable id (`reason` required for both)                                                                        |

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
npm test          # run all 478 Vitest tests
npm run lint      # ESLint
npm run format    # Prettier check
npm run format:write  # Prettier fix
npm run package:local # build internal release tarball
npm run package:vsix  # build the installable VS Code extension (.vsix)
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
│   ├── intent/           query intent classification (debugging/feature/refactor/test)
│   ├── planner/         feature planning, handoff, workspace planning
│   ├── measurement/      naive-vs-selected context/token measurement harness
│   ├── validator/       validation engine, safety policy, audit, risk assessment
│   ├── reviewer/        review report generation
│   ├── session/          one feature at a time: phase, decisions, plan versions
│   ├── grounding/        verifies the model's claims against the index
│   ├── agents/          the four phase role prompts
│   ├── instructions/    Copilot instructions and skill generation
│   ├── mcp-server/      MCP server and 30 tools
│   ├── cli/             CLI entry point
│   ├── vscode-extension VS Code extension: the @architect chat participant
│   └── web/             optional local web UI shell
├── samples/             representative sample repos for testing
├── tests/               integration and e2e tests
├── docs/                product documentation
├── templates/           instruction and skill templates
└── scripts/             setup and packaging scripts
```

All business logic belongs in `packages/`. UI shells (`vscode-extension`, `web`) are thin shells that call CLI/core/MCP — they contain no business logic.

---

## Further Reading

- [Install the extension](docs/INSTALL.md)
- [Solution overview](docs/SOLUTION_OVERVIEW.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Installation from source](docs/INSTALLATION.md)
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
