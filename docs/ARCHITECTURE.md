# Architecture

## Shape

Copilot Architect uses a TypeScript monorepo-style structure:

```text
packages/
  shared/
  core/
  adapters/
  indexer/
  planner/
  validator/
  reviewer/
  agents/
  instructions/
  mcp-server/
  cli/
  vscode-extension/
  web/
templates/
samples/
tests/
docs/
scripts/
```

## Boundaries

Business logic lives in these packages:

- `packages/shared`
- `packages/core`
- `packages/adapters`
- `packages/indexer`
- `packages/session`
- `packages/planner`
- `packages/validator`
- `packages/reviewer`
- `packages/agents`
- `packages/instructions`
- `packages/mcp-server`
- `packages/cli`

UI shells must not contain business logic. `packages/vscode-extension` and `packages/web` call CLI, core, or MCP services and render results.

## CLI-First

The CLI is the primary local entry point. It orchestrates package APIs without duplicating detection, planning, validation, review, or generation logic.

Expected commands include:

- `init`
- `analyze`
- `index`
- `search`
- `plan`
- `validate`
- `review`
- `handoff`
- `agents`
- `instructions`
- `workspace`
- `mcp`
- `serve`
- `status`
- `doctor`

Phase 12 completes the CLI shell with per-command help, JSON output for automation, human-readable defaults, non-zero exit codes for validation or configuration failures, and cross-platform path parsing through Node `path` helpers. Commands that need behavior beyond argument parsing call package services instead of embedding domain logic in `packages/cli`.

## MCP-First

The MCP server exposes repo intelligence tools to local agent hosts. It uses the TypeScript MCP SDK, connects over stdio through `npm run cli -- mcp`, and calls the same package APIs as the CLI. MCP is first-class because agent hosts need structured access to repo maps, plans, validation evidence, policy checks, custom instructions, and review reports.

## Adapter System

Adapters detect repository characteristics and provide commands, folders, entry points, and architectural hints. Deep adapters are prioritized for JavaScript, TypeScript, Angular, React, Node.js, Python, Java Maven, and Java Gradle. Generic adapters provide fallback support for unknown or custom repositories.

Phase 3 defines the adapter contract in `packages/adapters`:

- `IAdapter` is the base interface for every adapter.
- Specialized interfaces cover languages, frameworks, package managers, build commands, test commands, lint commands, format commands, and repo heuristics.
- `AdapterRegistry` registers adapters, runs all matching adapters, sorts detection results by confidence, merges results, and de-duplicates commands.
- `GenericTextAdapter` is the fallback adapter when no specialized adapter matches.

Adapter outputs stay serializable and use shared models from `packages/shared`.

Phase 4 adds first-class adapters for:

- JavaScript and TypeScript package/config/script detection.
- React framework and file-pattern detection.
- Angular workspace, project, command, and file-pattern detection.
- Python config, framework, package tooling, and test command detection.
- Java Maven/Gradle framework, package tooling, and build/test command detection.

The generic text adapter remains the fallback for unknown or custom repositories.

## Repo Discovery

`packages/core` owns repo discovery orchestration. `RepoDiscoveryService` finds the effective repo root, detects Git presence, scans repository files with common dependency/build folders ignored, builds adapter context, runs the default adapter registry, infers documentation files and project roots, creates a `UniversalRepoMap`, and writes `.copilot-architect/repo-map.json`.

The CLI `analyze` command calls this service. It does not duplicate discovery logic.

## Local Index

`packages/indexer` owns local indexing and search. The MVP uses a JSON index at `.copilot-architect/index/index.json` with a status artifact at `.copilot-architect/index/status.json`.

Indexed documents include relative path, extension, language guess, content hash, modified time, file size, text preview, extracted symbols, imports/includes, and test/config/doc flags. The indexer skips common dependency, build, cache, and IDE folders.

The CLI `index` and `search` commands call `IndexingService`; they do not implement indexing logic directly.

## Work Sessions

`packages/session` owns the work session: one feature, from first question to
finished review, stored under `.copilot-architect/sessions/<id>.json`.

A session exists so that a planning conversation is reproducible. It records
**decisions** — what the developer chose that the tool would not have chosen
itself — rather than raw transcript, so a plan can be rebuilt from request plus
repo facts plus decisions instead of from whatever the model happened to recall.
Only deviations are recorded; defaults are the tool's suggestions, not the
developer's decisions, and a confirmation list nobody reads is worse than none.

Scope is the **workspace**, not the repo, because a feature can legitimately
span several repos. One session is active at a time; opening another parks the
previous one rather than discarding it. A session is bound to the branch it
opened on, and `current()` parks it when the branch moves — a check every caller
would otherwise have to remember.

Plan versions live here too. A version is a `draft` until `approvePlan` is
called, and `latestApprovedPlan` is what implementation applies, so a newer
unapproved draft cannot be acted on. `markImplemented` refuses a version that
was never approved.

`checkConstraints` turns a confirmed constraint into something enforceable: "do
not modify `InvoiceController`" becomes a rule with an answer rather than a
sentence a model may overlook. Constraints carrying no machine-checkable
enforcement are reported as **unenforceable** rather than counted as passing.

`diffCheckpoint` compares the index's per-file content hashes against a
checkpoint taken when implementation began, so review can separate this
feature's changes from everything else in the tree — including in a workspace
with no git repository.

## Plan Contract

`packages/planner/src/plan-contract.ts` owns the implementation contract:
everything `/implement` needs, so it never reads the repository again.

This is the idea the product rests on. Retrieval happens once, during planning,
and the contract is its durable output. If a later phase re-read the repo, the
work would be paid for twice and the tool would be no better than using Copilot
directly.

Two properties follow, and both are enforced by code rather than requested:

- **The model never writes the "before" code.** `buildPlannedChange` reads the
  file itself and there is no API to pass snapshot text in. A model asked to
  reproduce existing code paraphrases it, and a paraphrase applied as a patch
  corrupts the file. Copying is also cheaper than paying a model to retype what
  is already on disk.
- **Excerpts are windows, not whole files.** `extractExcerpt` centres on the
  symbol anchor the index already resolved. Whole files would make a twenty-file
  plan the expensive prompt this design exists to avoid; a bare path would make
  the plan useless without re-reading the repo.

Each change carries a content hash of the file at plan time.
`verifyPlanFreshness` compares those hashes before implementation — a
verification, not a re-read, so it does not break the retrieve-once rule. Drift
is small on same-day work but not zero, and patching a file that moved
underneath corrupts it silently.

Session decisions are embedded rather than referenced, so a plan can be read and
defended by someone who never saw the session.

`writeApprovedPlan` is called only on approval, to
`.copilot-architect/plans/approved/vN.json` with a `latest.json` pointer. A
draft lives in the session and nowhere else — the reverse of the previous order,
where a plan was written first and marked approved afterwards.

## Plan Execution

`packages/planner/src/plan-execution.ts` is the only place in the product that
modifies a developer's working tree, so the guards live there rather than in
whichever shell called it.

`applyPlanChanges` resolves every path and refuses anything outside the
workspace root. A plan is data, and data naming `../../etc/passwd` must not
reach outside the repo because a model produced it. Refusals are reported
rather than thrown: one bad path should not abandon the rest half-applied. An
update with no replacement content is refused rather than written as an empty
file.

`compareAgainstPlan` classifies what changed against what was approved —
changed as planned, planned but untouched, and **changed but never planned**.
That last category is the one a review reading only the plan would miss, and
scope creep used to pass silently because nothing compared the two.

`/implement` passes four gates before writing: an approved plan (a draft is not
authorization), `verifyPlanFreshness` (a file that moved since the plan quoted
it must not be patched blind), the constraints the developer confirmed, and the
workspace boundary. The checkpoint is captured before the first write.

## Feature Planning

`packages/planner` owns feature plan generation. `FeaturePlanningService` reads or creates `.copilot-architect/repo-map.json`, reads optional workspace/custom command context, detects available instruction files, refreshes the local index, runs similar-feature search, and renders deterministic JSON and Markdown plan artifacts under `.copilot-architect/plans/`.

Plan artifacts include request interpretation, repo architecture summary, planning context, relevant files, similar feature candidates, impacted stacks and modules, likely files to modify, likely new files, frontend/backend/data/config/security/performance impacts, test strategy, validation commands, implementation steps, risks, assumptions, open questions, and a human approval checkpoint.

The CLI `plan` command calls `FeaturePlanningService`; it does not duplicate planning logic. Planning is read-only for application code and only writes Copilot Architect artifacts.

## Custom Command Configuration

`packages/validator` owns custom command configuration for `.copilot-architect/commands.json`. `CommandConfigService` creates the template during `init`, parses categorized `build`, `test`, `lint`, `format`, and `validation` entries, validates schema errors with actionable messages, normalizes command strings into structured validation commands, and merges custom commands ahead of detected commands.

The CLI `init`, `commands validate`, and `commands list` commands call `CommandConfigService`.

## Validation Engine

`packages/validator` also owns Phase 9 validation execution. `ValidationService` builds a validation plan from repo-discovered commands and custom command config, filters by requested category, assesses command risk, runs allowed commands without a shell, supports timeouts and retries, streams redacted output, and writes validation artifacts under `.copilot-architect/runs/`.

Validation artifacts include timestamped and latest JSON/Markdown reports plus timestamped logs. Reports summarize passed/failed/blocked/timed-out commands, include command risk assessments, capture failure summaries, and generate a fix prompt for failed validation.

The CLI `validate`, `validate --build`, `validate --test`, `validate --lint`, and `validate --format` commands call `ValidationService`.

## Safety Policy And Audit

`packages/validator` owns safety and internal team control services. `SafetyPolicyService` loads or creates `.copilot-architect/policy.json`, `CommandRiskAssessmentService` blocks dangerous commands and warns on git history mutations, `PathBoundaryService` prevents workspace escapes, `SecretRedactionService` redacts likely secrets, `AuditLogService` writes JSONL audit entries under `.copilot-architect/audit/`, `GitCheckpointService` captures current git state, `RollbackGuideGenerator` creates human-readable rollback guidance, and `ArtifactCleanupService` applies retention policy to local artifacts.

The policy includes command allow/block lists, required approval gates, telemetry disabled by default, local-first operation, configurable artifact retention, admin agent template paths, and trust metadata for generated files. The CLI `policy show`, `policy validate`, `audit list`, and `cleanup` commands call validator services. Validation execution uses the same policy, risk, redaction, and audit services.

The `cleanup` command is dry-run by default when policy says so. It only considers files under `.copilot-architect/` retention directories, preserves latest aliases such as `latest-plan.json`, records a redacted audit entry, and deletes only when a human passes `--apply`.

## Local MCP Server

`packages/mcp-server` owns the Phase 11 MCP integration. `createCopilotArchitectMcpServer` registers tools on an MCP SDK server, while `startMcpServer` attaches stdio transport for local agent hosts. The CLI `mcp` command is a thin shell around this package.

The server exposes `repo_map`, `workspace_map`, language/framework/package-manager/command detection tools, repo and workspace search, similar feature lookup, impact/context generation, approval-gated feature plan generation, validation command lookup, safety policy lookup, latest plan/validation/review artifact readers, and `agent_status`.

Tools return structured JSON in MCP text content and call `packages/core`, `packages/indexer`, `packages/planner`, and `packages/validator` rather than duplicating business logic. Read-only tools do not write plan artifacts; `generate_feature_plan` requires `approved=true` before it writes `.copilot-architect/plans/` artifacts.

`CopilotChatMcpConfigService` writes `.vscode/mcp.json` with a `copilotArchitect` stdio server for GitHub Copilot Chat in VS Code. This is a supported MCP configuration file, not a Copilot internal modification.

## CLI Completion Services

Phase 12 adds small package-owned services for command families that were previously placeholders:

- `WorkspaceService` in `packages/core` owns `workspace init`, `workspace show`, and `workspace add` artifacts.
- `HandoffService` in `packages/planner` owns approval-gated handoff prompt generation under `.copilot-architect/handoffs/`.
- `ReviewService` in `packages/reviewer` owns initial git-diff review report artifacts under `.copilot-architect/reviews/`.
- `InstructionService` in `packages/instructions` owns preview, generation, validation, and backup behavior for instruction artifacts.

Workspace `index`, `search`, `impact`, `plan`, and `validate-plan` commands orchestrate existing indexer/planner services across workspace config. The optional `serve` command is intentionally a thin status shell until the local web UI phase.

## Custom Copilot Agents

`packages/agents` owns Phase 13 custom agent generation. `AgentService` defines and renders seven first-class Copilot agents: `FeatureArchitect`, `FeatureImplementer`, `CodeReviewer`, `TestPlanner`, `Debugger`, `SecurityReviewer`, and `PerformanceReviewer`.

The default install target is `.github/agents/`, with `--output <dir>` available for custom locations. Generated files use the `.agent.md` suffix and include frontmatter, model and tools metadata, required instruction/handoff/safety sections, trust metadata, and references to `.copilot-architect/` artifacts.

The `agents install`, `agents update`, `agents validate`, and `agents doctor` CLI commands call `AgentService`. Existing files are skipped by default, while `--force` and `agents update` create timestamped backups before overwriting. `--dry-run` reports planned actions without writing files. Teams can add admin-owned `.agent.md` templates in policy-configured paths such as `templates/agents` or `.copilot-architect/agent-templates`; install/update copies those templates alongside built-ins.

Generated agents are Copilot Chat-ready. Their frontmatter includes `copilotArchitect/*` MCP tool access and handoffs for `FeatureArchitect` to `FeatureImplementer`, `FeatureImplementer` to `CodeReviewer`, and `CodeReviewer` to `Debugger` when validation failed. `agents doctor --path <repo>` checks agent files and `.vscode/mcp.json` readiness.

## Custom Instructions And Skills

`packages/instructions` owns Phase 14 custom instruction and skill generation. `InstructionService` reads repo analysis through `RepoDiscoveryService`, previews repo-aware content, writes `.github/copilot-instructions.md`, and generates skill files under `.github/skills/`.

Generated instructions include repo architecture summary, detected languages, frameworks, package managers, build/test/lint/format commands, coding conventions, safety rules, trust metadata, planning workflow, approval workflow, validation workflow, and review workflow. The generated block records timestamp and repo-map source metadata. `instructions generate` also writes `.github/prompts/*.prompt.md` files for planning, implementation, review, and debugging in GitHub Copilot Chat.

Existing instruction and skill files are backed up before overwrite. Instruction regeneration preserves user-authored content outside the Copilot Architect generated block under a preserved notes section. The `instructions preview`, `instructions generate`, and `instructions validate` CLI commands call `InstructionService`.

## Implementation Handoff

`packages/planner` owns Phase 15 implementation handoff generation through `HandoffService`. Handoff generation requires explicit approval through `--approve` and never edits target repository code.

`HandoffService` loads an approved plan from `.copilot-architect/plans/latest-plan.json` or a provided path, refreshes repo-map context through `RepoDiscoveryService`, loads the active safety policy, captures a git checkpoint through `GitCheckpointService` where possible, and writes `.copilot-architect/handoffs/<timestamp>-handoff.{json,md}` plus latest aliases.

The Markdown handoff starts with `@FeatureImplementer`, includes the required rules, references the approved plan, lists validation commands, includes safety rules and repo context, and works with GitHub Copilot custom agents, Copilot chat, Codex, Claude Code, and generic coding agents. Clipboard copy is attempted where a platform clipboard tool is available, but failure to copy does not block artifact generation.

## Review Workflow

`packages/reviewer` owns Phase 16 review report generation through `ReviewService`. It reads the git diff, loads the approved plan from `.copilot-architect/plans/latest-plan.json` or a provided path, loads validation evidence from `.copilot-architect/runs/latest-validation.json` or a provided path, and writes `.copilot-architect/reviews/<timestamp>-review.{json,md}` plus latest aliases.

Review reports include changed files, expected files from the plan, unexpected file changes, missing-test signals, config and dependency changes, security-sensitive file or diff signals, possible breaking-change signals, validation failures, risk summaries, and an `@CodeReviewer` prompt. The CLI `review --plan latest --validation latest` command is a thin shell over this package-owned workflow.

## VS Code Extension Shell

`packages/vscode-extension` owns Phase 17 as a thin VS Code wrapper.

Retrieval goes through `IndexingService`, and the tokenizer is imported from
`packages/indexer` rather than copied. It used to re-implement both — its own
tokenizer, its own reciprocal-rank fusion, LM query expansion and embedding
reranking — which meant `@architect` and the agents could give different answers
to the same question and neither was wrong. It also meant a tokenizer fix had to
be made twice: the digit-boundary change that made `R2D2` findable was applied
to one copy and then the other. One engine removes that class of bug rather than
fixing instances of it. Its manifest contributes a Copilot Architect activity-bar container, a `Copilot Architect` webview, command-palette commands, an **Open Repo in New Window** command, and a **GitHub Copilot Chat participant** (`@architect`) with slash commands for all major workflows.

The extension does not implement repo analysis, planning, validation, review, agent, or instruction behavior. Commands delegate to `npm run cli -- ...` in the active workspace root, and MCP startup delegates to `npm run cli -- mcp` through a VS Code terminal or Node child process fallback. The webview renders high-level sections for repo summary, languages/frameworks, plans, validation runs, review reports, agent status, and MCP status.

The `openRepoInNewWindow` command opens a folder picker and calls `vscode.openFolder` with `forceNewWindow: true`, allowing users to analyze any repository without leaving the current window. The chat participant (`copilot-architect.architect`) handles slash commands (`/analyze`, `/index`, `/plan`, `/validate`, `/review`, `/search`, `/diagnostics`, `/agents`, `/instructions`, `/help`) and plain-text prompts by running the corresponding CLI command and streaming output back into the chat panel.

See [VSCODE_EXTENSION.md](VSCODE_EXTENSION.md) for full usage details.

## Local Web UI

`packages/web` owns Phase 18 as an optional local-only browser UI. The CLI `serve` command starts a Node HTTP server bound to `127.0.0.1` by default and prints the local URL. The server rejects non-local requests and has no cloud backend.

The web UI displays `.copilot-architect/repo-map.json`, latest plan, latest validation, latest review, workspace config, agent files, and MCP status. Workflow buttons call local API endpoints that delegate to `npm run cli -- ...` actions for analyze, index, search, plan, validate, review, workspace init/show, agent install, and instruction generation. MCP start/stop is handled as a local child process. The UI does not implement repo discovery, indexing, planning, validation, review, agents, instructions, or MCP behavior itself.

## Multi-Repo Workspaces

`packages/core` owns Phase 19 workspace configuration through `WorkspaceService`. It parses `.copilot-architect/workspace.json`, supports named repos with relative paths and roles, normalizes older `repoRoots` configs, adds/lists/removes repos, resolves absolute repo roots, and generates a workspace-level `.copilot-architect/repo-map.json` by aggregating repo discovery results.

`packages/indexer` owns workspace indexing and search orchestration. `IndexingService.indexWorkspace` indexes each configured repo and refreshes the workspace repo-map. `IndexingService.searchWorkspace` searches each repo index and returns combined results annotated with repo name, role, and root.

`packages/planner` owns cross-repo impact and workspace plans through `WorkspacePlanningService`. It identifies impacted repos from cross-repo search, creates per-repo validation plans from detected commands, and augments workspace plan artifacts with a `multiRepo` section. The CLI workspace commands and MCP tools call these package APIs rather than duplicating multi-repo logic.

## Advanced Intelligence

`packages/core` owns Phase 21 advanced local intelligence through `AdvancedAnalysisService`. It scans local files, combines that evidence with repo maps, and detects architecture patterns, dependency manifests, route/API surfaces, source-to-test relationships, readiness diagnostics, and risk scores. It remains local-first and does not require a network service or vector database.

The service detects React apps, Angular apps, Node APIs, Python services, Java Spring services, monorepos, library/package layouts, and CLI apps. Route detection covers Express, FastAPI, Flask, Django URL configs, Spring mappings, Angular routes, React Router, and Next.js file routes. Dependency manifest detection covers `package.json`, `requirements.txt`, `pyproject.toml`, `pom.xml`, and `build.gradle`.

`packages/planner` embeds the advanced analysis in generated plans. Plan Markdown and JSON include architecture signals, routes/APIs, test relationships, risk scores, plan quality checks, and repo readiness diagnostics. The CLI `diagnostics` command calls `AdvancedAnalysisService.diagnose` and reports readiness issues such as missing package manager evidence, missing build scripts, missing tests, missing repo maps, and stale indexes.

## Sample Matrix And CI

Phase 22 adds fixture repositories under `samples/`: `react-app`, `angular-app`, `python-service`, `java-maven-service`, `java-gradle-service`, `node-api`, `polyglot-monorepo`, and `generic-repo`. The samples are intentionally small and dependency-light, but they include real manifests, source files, route/API examples, and nearby tests so detection paths are exercised against files on disk.

`tests/sample-matrix.test.ts` copies samples into temporary workspaces and runs the MVP flow without mutating tracked fixture files. It covers discovery, indexing, search, planning, command detection, safety blocking, MCP tools, agent installation, instruction generation, handoff generation, validation, review, workspace support, CLI commands, and end-to-end flow. `.github/workflows/ci.yml` runs install, format, lint, build, and tests for pull requests and pushes.

## Internal Setup Scripts

Phase 20 adds clone-friendly setup scripts in `scripts/`. `check-env.sh` and `check-env.ps1` verify Node.js 20.11+ and npm. `setup.sh` and `setup.ps1` run the environment check, install dependencies, build packages, and run the Vitest suite. These scripts do not replace npm scripts; they are a team convenience for first-time setup.

## Internal Packaging

Phase 23 keeps distribution local and team-oriented. The root package owns the internal sharing workflow through `npm run package:local`, which builds the TypeScript project, verifies `npm run cli -- version`, verifies `npm run cli -- doctor`, runs `npm pack`, and writes release artifacts under `dist/release/`.

The local package artifact is a convenience tarball for team handoff and extraction. Active development should use a Git checkout or `npm link --workspace @copilot-architect/cli`. Marketplace publishing, commercial packaging, and enterprise installers remain out of scope for the MVP.

The CLI `version` command reports the internal package version, schema version, Node runtime, package manager, and distribution channel. `doctor` includes packaging checks for the version command, local tarball script, and installation docs.

## Artifacts

All runtime artifacts are stored under `.copilot-architect/`:

```text
.copilot-architect/
  repo-map.json
  workspace.json
  commands.json
  policy.json
  index/
  sessions/
  plans/
  handoffs/
  runs/
  reviews/
  audit/
  diagnostics/
```

Shared artifact constants and JSON helpers live in `packages/shared`. All packages should use these helpers instead of hard-coding artifact paths.

## Shared Domain Models

`packages/shared` owns serializable TypeScript interfaces for repo context, workspace context, repo maps, commands, feature plans, validation results, review reports, safety policy, audit logs, handoff prompts, agent templates, instruction generation, MCP tool results, workspace config, enterprise policy, and diagnostics.

Top-level artifacts include `schemaVersion` fields so future migrations can be handled explicitly.

## Dependency Strategy

The MVP uses a minimal dependency strategy: TypeScript, Node.js, npm, Vitest, and focused packages only when they remove meaningful implementation risk. The local index starts with JSON or SQLite rather than a heavy vector database.
