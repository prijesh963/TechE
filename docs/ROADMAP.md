# Roadmap

## Phase 0 - Product Docs And Boundaries

Document the product vision, TypeScript/Node.js direction, MVP boundaries, security model, MCP role, agent workflows, testing strategy, and release plan.

## Phase 1 - TypeScript Monorepo Skeleton

Create the npm workspace, package folders, placeholder CLI commands, TypeScript config, Vitest config, lint/format config, quickstart README, and initial tests.

## Phase 2 - Shared Domain Models

Add serializable shared models for repository context, workspace context, repo maps, plans, validation results, review reports, safety policies, audit logs, handoff prompts, agents, instructions, MCP results, and diagnostics.

Status: implemented as the shared Phase 2 model surface with JSON and artifact helpers.

## Phase 3 - Adapter Architecture

Implement adapter interfaces, registry, scoring, merging, capabilities, and generic fallback behavior.

Status: implemented with registry selection, confidence sorting, result merging, command de-duplication, and generic text fallback.

## Phase 4 - Language And Toolchain Adapters

Add first-class JavaScript/TypeScript, Angular, React, Node.js, Python, Maven, and Gradle adapters. Add generic fallback adapters for other languages.

Status: implemented for JavaScript/TypeScript, React, Angular, Python, Java Maven, and Java Gradle, with enhanced generic text fallback.

## Phase 5 - Repo Discovery And Analysis

Build repo discovery, multi-repo workspace discovery, artifact generation, and architecture summaries.

Status: implemented as `RepoDiscoveryService` with CLI `analyze`, `--json`, and `--output` support for single-repo analysis and monorepo/project-root inference.

## Phase 6 - Indexing And Search

Implement local scanning, ignore rules, JSON or SQLite index storage, text search, and similar feature search.

Status: implemented as JSON index storage with full indexing, incremental indexing, rebuild, status, ranked search, and similar feature search.

## Phase 7 - Planning

Generate feature plans, impact summaries, validation strategy, Markdown output, and JSON plan artifacts.

Status: implemented as `FeaturePlanningService` with CLI `plan` and `--json` support, repo-map and index integration, optional workspace/custom-command/instruction context, similar-feature candidates, stack-specific planning, validation command suggestions, Markdown/JSON artifacts, and human approval checkpoints.

## Phase 8 - Custom Command Configuration

Implement `.copilot-architect/commands.json`, command config parsing, schema validation, detected/custom command merging, override behavior, helpful errors, and CLI support for `init`, `commands validate`, and `commands list`.

Status: implemented as `CommandConfigService` with categorized command parsing, template initialization, helpful validation errors, override-aware merge behavior, CLI commands, and planner integration.

## Phase 9 - Universal Validation Engine

Run safe commands only, support timeouts and retries, stream output, save logs and reports, redact secrets, summarize failures, and generate fix prompts.

Status: implemented as `ValidationService` with detected/custom command planning, category filters, dangerous-command blocking, safe command execution, timeout/retry support, redacted logs, JSON/Markdown reports, latest artifacts, failure summaries, fix prompts, and CLI `validate` flags.

## Phase 10 - Safety Policy And Audit

Implement the safety policy engine, command risk assessment, audit logging, secret redaction, workspace boundary checks, and approval gates.

Status: implemented as safety policy, command risk assessment, audit logging, secret redaction, path boundary, git checkpoint, and rollback guide services with CLI `policy show`, `policy validate`, and `audit list` support.

## Phase 11 - Local MCP Server

Implement the local MCP server and expose repo intelligence, search, planning, validation, and safety tools.

Status: implemented with `packages/mcp-server`, the TypeScript MCP SDK, stdio startup through `npm run cli -- mcp`, structured JSON responses, read-only repo/search/impact/policy/latest-artifact tools, and approval-gated `generate_feature_plan`.

## Phase 12 - CLI Completion

Complete the CLI command surface, help text, JSON output, exit codes, and command coverage across init, analyze, index, search, plan, validate, review, handoff, agents, instructions, workspace, commands, policy, audit, mcp, serve, status, and doctor.

Status: implemented with per-command help, JSON-capable output paths, consistent exit codes, `status`, `serve`, review, approval-gated handoff, agents, instructions, and workspace command families. Package-owned services back non-core command behavior so CLI orchestration does not become business logic.

## Phase 13 - Custom Copilot Agents

Generate custom Copilot agents, validate metadata and required sections, install under `.github/agents/`, support configurable output paths, dry runs, backup-before-overwrite behavior, update commands, and doctor guidance.

Status: implemented as `AgentService` with seven required `.agent.md` templates, YAML frontmatter, tools/model metadata, safety and handoff sections, `.copilot-architect` artifact references, install/list/validate/update/doctor CLI support, dry-run/force/custom-output/JSON behavior, backups before overwrite, and validation for malformed agent files.

## Phase 14 - Custom Instructions And Skills

Generate Copilot instructions, AGENTS.md suggestions, skill templates, backup-before-overwrite behavior, and instruction validation/update commands.

Status: implemented as `InstructionService` with repo-aware `.github/copilot-instructions.md` preview/generation/validation, backup-before-overwrite behavior, generated-block preservation of user-authored sections, generated timestamp and repo-map source metadata, and five skills under `.github/skills/`.

## Phase 15 - Implementation Handoff

Generate implementation handoff prompts from approved plans, repo maps, validation commands, and safety policy for Copilot custom agents, Codex, Claude Code, and other coding agents.

Status: implemented as `HandoffService` with explicit `--approve` gating, latest or path-based plan loading, repo-map and safety-policy context, validation command inclusion, git checkpoint creation where possible, clipboard copy attempts where supported, JSON/Markdown handoff artifacts, and required `@architect /implement` prompt format.

## Phase 16 - Review Reports

Generate review reports from git diff, validation evidence, plan-vs-diff comparison, risk analysis, missing-test detection, and reviewer prompts.

Status: implemented as `ReviewService` with git diff reading, approved plan loading, optional validation report loading, expected-vs-actual file comparison, unexpected-change findings, missing-test detection, config/dependency/security/breaking-change signals, JSON/Markdown review artifacts, latest aliases, and a generated `@architect /review` prompt.

## Phase 17 - VS Code Extension Shell

Add a basic VS Code extension shell with activity-bar entry, Copilot Architect webview, and commands for analyze, index, plan, validate, review, MCP startup, agent installation, and instruction generation.

Status: implemented as `packages/vscode-extension` with manifest contributions, activity-bar icon, webview dashboard sections, command registration, CLI delegation through `npm run cli -- ...`, MCP terminal/process startup, cross-platform npm executable handling, and smoke tests using a fake extension host.

## Phase 18 - Optional Local Web UI

Add a local-only browser UI for repo analysis, indexing, search, planning, artifact viewing, validation, review, workspace config, agent installation, instructions generation, and MCP start/stop.

Status: implemented as `packages/web` with a local Node HTTP server, compact browser UI, repo-map/latest-plan/latest-validation/latest-review/workspace/agent artifact display, CLI-delegated workflow actions, local MCP child-process management, `npm run cli -- serve` startup, host/port/path flags, and local-port smoke tests.

## Phase 19 - Multi-Repo Workspace Support

Support `.copilot-architect/workspace.json` with named repos, paths, and roles; add/list/remove repos; index and search across repos; analyze cross-repo impact; generate multi-repo plans and per-repo validation plans; and expose workspace map/search/impact through MCP.

Status: implemented with `WorkspaceService` config parsing and repo management, workspace-level repo-map generation, `IndexingService.indexWorkspace` and `searchWorkspace`, `WorkspacePlanningService` cross-repo impact and `multiRepo` plan augmentation, CLI `workspace list/remove` plus enhanced add/index/search/impact/plan/validate-plan behavior, and MCP `workspace_map`, `search_across_repos`, and `analyze_cross_repo_impact` tools.

## Phase 20 - Internal Team Controls

Add team-friendly setup scripts, local-first policy controls, command allow/block lists, required approval gates, telemetry disabled by default, artifact retention cleanup, secret redaction, admin-configurable agent template paths, trust metadata for generated files, and CLI `doctor`, `status`, `policy show`, `policy validate`, `audit list`, and `cleanup` coverage.

Status: implemented with expanded `.copilot-architect/policy.json` defaults and validation, `ArtifactCleanupService`, dry-run/apply cleanup CLI, enriched status and doctor output, redacted cleanup audit entries, generated trust metadata in agents/instructions/policy, policy-driven admin agent templates, and cross-platform setup/check-env scripts.

## Phase 21 - Advanced Intelligence Additions

Add local-first architecture pattern detection, dependency manifest detection, route/API detection, test relationship detection, risk scoring, plan quality scoring, and repo readiness diagnostics.

Status: implemented with `AdvancedAnalysisService`, CLI `diagnostics`, plan-embedded advanced analysis/risk scores/quality checks/readiness diagnostics, and tests covering React, Angular, Python, and Java sample repos.

## Phase 22 - Testing Matrix And Sample Repos

Create representative sample repos for React, Angular, Python, Java Maven, Java Gradle, Node API, polyglot monorepo, and generic fallback support. Add tests for adapter detection, repo discovery, indexing, search, planning, validation command detection, safety blocking, MCP, agents, instructions, handoff, review, workspace support, CLI commands, and the MVP e2e flow. Add CI coverage.

Status: implemented with the `samples/` matrix, `tests/sample-matrix.test.ts`, an end-to-end CLI flow from analyze through review, and `.github/workflows/ci.yml`.

## Phase 23 - Packaging For Internal Sharing

Add clone-friendly install docs, npm link guidance, optional local tarball packaging, release artifacts, version command, changelog, troubleshooting guide, and upgrade guide for internal team distribution.

Status: implemented with `npm run cli -- version`, enhanced `doctor` packaging guidance, `npm run package:local`, `.npmignore`, `scripts/package-local.mjs`, root `CHANGELOG.md`, and internal installation, setup, troubleshooting, and upgrade docs.

## Phase 24 - MVP Definition And Lock

Lock the MVP boundary around the required TypeScript CLI, repo discovery, adapters, local indexing/search, planning, command config, validation, safety, MCP, agents, instructions, handoff, review, multi-repo basics, VS Code shell, and internal setup docs. Document explicit non-goals and require tests to keep proving the MVP path before new major scope is added.

Status: implemented in `docs/MVP_DEFINITION.md` with the exact required capability list, non-goals, MVP user path, lock rules, acceptance gates, and tests that enforce the documented boundary.

## Phase 25 - Development Governance

Add execution rules, PR guardrails, CI/release validation, and tests that keep MVP development disciplined.

Status: implemented with mandatory governance rules in `docs/DEVELOPMENT_EXECUTION_INSTRUCTIONS.md`, `.github/pull_request_template.md`, `.github/workflows/ci.yml`, `.github/workflows/release-check.yml`, and governance tests that validate the artifacts.

## Phase 26 - End-To-End MVP Validation

Prove the locked MVP works across representative React, Angular, Python, Java, polyglot, MCP, agents/instructions, safety, and review workflows without adding major new scope.

Status: implemented with strict `--root` support for nested sample validation, clean-machine command detection fixes, `docs/PHASE_26_VALIDATION_REPORT.md`, and regression coverage in `tests/phase26-validation.test.ts`.

## Phase 27 - Developer Experience Polish

Improve internal usability through better CLI help, error messages, a one-command demo, a setup verification flow, cleaner doctor output, and a cleanup command for generated artifacts.

Status: implemented with:

- `npm run cli -- demo` — 4-step end-to-end demonstration (analyze → index → search → diagnostics) with actionable next steps and `--json` support.
- `doctor` now performs a real Node.js version check (≥ 20.11) and reports `status: "error"` with an upgrade link for unsupported runtimes, instead of always returning `"ok"`.
- Help text updated with a `Quick start: npm run cli -- demo` hint.
- All 7 agent templates corrected from fictional `gpt-5.2` to `gpt-4o`.
- Expanded secret redaction (AWS, GCP, Stripe, JWT, PEM, database connection strings, npm tokens, Slack tokens) in both `SecretRedactionService` and the policy default patterns.
- Extended safe executable set: `bun`, `deno`, `npx`, `tsc`, `biome`, `cargo`, `go`, `rustfmt`, `clippy`, `dotnet`, `mocha`, `jasmine`, `playwright`, `cypress`, `webpack`, `esbuild`, `turbo`, `nx`, `python3`, `uv`, `ruff`, `mypy`, `flake8`, `black`, `pipenv`.
- 6 new tests (147 total passing).
- Documentation updated: README, CHANGELOG, INSTALLATION, LANGUAGE_SUPPORT, SECURITY_MODEL, MCP_TOOLS, AGENT_WORKFLOWS, TROUBLESHOOTING, INTERNAL_TEAM_SETUP, UPGRADE_GUIDE.

## Later Optional Features

- Semantic search (embeddings-based) for the local index.
- Enterprise policy packs.
- Cloud sync.
- Commercial packaging.
- Visual Studio VSIX.
- .NET wrapper.
- GitHub Issues/PR context in feature planning.
- Plan cost estimation (hours, tokens, complexity).
- Dependency vulnerability scanning (npm audit, pip safety integration).
- Telemetry system (opt-in, local-only).
