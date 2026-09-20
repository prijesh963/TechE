## Project

We are building **Copilot Architect**.

Copilot Architect is an internal developer tool that grounds GitHub Copilot,
Codex, Claude Code and other AI coding agents in what is actually in a
repository, instead of in a model's general sense of how projects like this
usually look.

A developer types a high-level task:

> Add invoice approval workflow based on the current repo.

The tool walks one feature from question to reviewed change, in one session:

1. Analyzes the repo or multi-repo workspace and indexes it locally.
2. Answers questions about it from that index, not from guesses.
3. Drafts a plan carrying the current contents of every file it would change.
4. Takes the developer's corrections and redrafts, versioned.
5. Waits for explicit approval — a button, not a phrase.
6. Edits existing files by quoting what to replace rather than rewriting them,
   refusing any edit it cannot match exactly once; offers a real diff of each
   against what is on disk, and applies them on a click.
7. Reviews what was built against what was approved.
8. Exposes the same repo intelligence through a CLI and a local MCP server.

## Quick Start

```bash
git clone <repo>
cd copilot-architect
scripts/setup.sh              # install, build, test, verify
npm run cli -- demo           # end-to-end demo: analyze → index → search → diagnostics
npm run package:vsix          # build the installable VS Code extension
```

Then install the `.vsix` and drive a feature from Copilot Chat:

```text
@architect /analyze        what is in this repo
@architect /create-plan    propose a change
                           (Approve Plan — a button)
@architect /implement      apply the approved plan
@architect /review         check it against the plan
```

The CLI path, for scripting and for clients that are not the extension:

```bash
npm run cli -- init
npm run cli -- analyze
npm run cli -- index
npm run cli -- plan "Add X feature"
npm run cli -- instructions generate
npm run cli -- mcp config
npm run cli -- handoff --plan latest --approve
npm run cli -- validate
npm run cli -- review
npm run cli -- mcp
```

## Important Direction

This project must be **TypeScript/Node.js-first**.

Do not implement the MVP in C#/.NET.

Do not assume target repos are C#/.NET.

Most target repositories are:

- Python
- Java
- JavaScript
- TypeScript
- Angular
- React
- Node.js
- mixed frontend/backend repos
- monorepos

## Distribution Model

This is not a commercial product. The goal is internal team sharing with
minimal setup.

1. **`npm run package:vsix`** — an installable VS Code extension. This is the
   normal path: the recipient needs VS Code and Copilot, not Node, npm or a
   clone. The CLI is bundled inside the package and spawned by absolute path.
2. Git clone + `scripts/setup.sh`, for developing the tool itself.
3. `npm link --workspace @copilot-architect/cli` for a global command.
4. `npm run package:local` to build a tarball for teammates.

## Core Architecture

A TypeScript monorepo:

```text
copilot-architect/
├── packages/
│   ├── shared/          domain models, constants, artifact helpers
│   ├── core/            repo discovery, workspace service, advanced analysis
│   ├── adapters/        language/framework/toolchain adapters
│   ├── indexer/         file indexing, keyword search, staleness detection
│   ├── graph/           symbol/dependency graph
│   ├── intent/          query intent classification
│   ├── planner/         plan contract, feature planning, handoff
│   ├── session/         one feature at a time: phase, decisions, plan versions
│   ├── grounding/       verifies model claims against the index
│   ├── measurement/     naive-vs-selected context measurement
│   ├── validator/       validation engine, safety policy, audit, risk
│   ├── reviewer/        review report generation
│   ├── agents/          the four phase role prompts
│   ├── instructions/    Copilot instructions and skill generation
│   ├── mcp-server/      MCP server and 30 tools
│   ├── cli/             CLI entry point and command routing
│   ├── vscode-extension the @architect chat participant and dashboard
│   └── web/             optional local web UI shell (thin)
├── templates/
│   ├── instructions/
│   └── skills/
├── samples/             8 representative repos (React, Angular, Python, Java, Go, polyglot)
├── tests/               44 files, 449 tests
├── docs/                product documentation
└── scripts/             setup, bundling and packaging scripts
```

## Core Rule

Business logic must not live inside UI shells.

All real product logic must live in `packages/`, excluding `vscode-extension`
and `web`.

UI shells must only call CLI/core/MCP services.

This rule was violated once and it mattered: the extension re-implemented
retrieval rather than calling the indexer, so `@architect` and the MCP tools
answered the same question differently, and a fix applied to one never reached
the other. If a shell needs repo intelligence, it imports the service.

## Do Not Build in MVP

- Visual Studio (the IDE) extensions — VSIX here means the **VS Code** package
  built by `npm run package:vsix`, which is in scope and shipping
- WPF / Blazor UI
- .NET core engine
- Commercial marketplace packaging
- Heavy vector database or cloud backend
- Enterprise installer

## Implemented

1. TypeScript CLI with 24 commands including `demo`.
2. Local MCP server with 30 tools, including the session, plan contract and
   grounding — so a policy-blocked developer gets the same product.
3. VS Code extension with the `@architect` chat participant and four phases.
4. Repo analysis and discovery; language/framework/package-manager detection.
5. Adapter architecture with registry, confidence scoring, generic fallback.
6. Local JSON index with full, incremental and rebuild modes, plus staleness
   detection so a session's own edits are not answered from a stale snapshot.
7. Keyword search with scoring, cross-repo fan-out and symbol-graph expansion.
8. Symbol/dependency graph for TS/JS (compiler API) and Java.
9. Session model: one feature, recorded decisions, versioned plans, explicit
   end, parked rather than deleted on a branch change. `/create-plan` proposes
   decisions for the developer to confirm; only confirmed ones are recorded,
   and a proposal that contradicts an earlier decision supersedes it rather
   than sitting beside it.
   The dashboard's Current work card shows the live session, read through
   `peek` so a repaint never parks it.
10. Plan contract carrying each changed file's content and hash at plan time.
    Files are selected by the model from search candidates — with a reason and
    an add/update/delete kind each — not by search relevance alone. Each reason
    cites a symbol checked against the index, so a reason about the wrong file
    is flagged rather than read as fact. A new file carries an outline —
    each export's signature and purpose, imports, rough size — so an `add` is
    approved as something concrete rather than a sentence, and `/implement`
    checks the file that landed against it.
11. Grounding: claims verified against the index, unverified ones flagged. A
    path is resolved by unique suffix, so an answer that writes a path the way
    its own repo does is not reported as a fabrication.
12. Safe validation runner with timeouts, retries and streaming.
13. Safety policy engine with blocked patterns and approval gates.
14. Audit logs (append-only `.copilot-architect/audit/audit.jsonl`).
15. Secret redaction (AWS, GCP, Stripe, JWT, PEM, DB connection strings, etc.).
16. Copilot instructions and prompt-file generation.
17. Handoff prompt generation (requires `--approve`).
18. Review report generation from git diff and validation evidence.
19. Multi-repo workspace support.
20. Advanced intelligence: architecture detection, route/API detection, test
    relationships, risk scoring.
21. VSIX packaging, internal setup docs, npm link support.

Known gaps are recorded in [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)
rather than left to be rediscovered.

## Language and Toolchain Support

### Deep adapter support

- JavaScript / TypeScript (npm, pnpm, yarn, bun, deno)
- Angular
- React
- Node.js
- Python (pytest, poetry, uv, ruff, mypy, flake8, black)
- Java Maven
- Java Gradle

### Extended validation allowlist

`bun`, `deno`, `npx`, `tsc`, `biome`, `cargo`, `go`, `rustfmt`, `clippy`,
`dotnet`, `mocha`, `jasmine`, `playwright`, `cypress`, `webpack`, `esbuild`,
`turbo`, `nx`, `python3`, `py`, `pipenv`, `uv`, and more.

### Generic fallback

All repos get file scanning, docs detection, config detection, import scanning,
test pattern detection, and custom commands through `GenericTextAdapter`.

## Adapter Responsibilities

Each adapter must detect:

- language and version hints
- framework
- package manager
- source folders
- test folders
- config files
- build, test, lint, format commands
- likely entry points
- common architectural patterns

## Safety Rules

Analysis is **read-only by default**.

Block dangerous commands by default (see `DEFAULT_BLOCKED_PATTERNS` in
`packages/validator/src/safety-policy-service.ts`):

- `rm -rf`, `del /s`, `format`, `diskpart`
- `git clean -fdx`, `git reset --hard`
- `chmod -R 777`, `sudo rm`, `Remove-Item -Recurse`

Redact secrets from all logs and reports (see `SecretRedactionService`):

- Env-var assignments with `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`,
  `ACCESS_KEY`, `PRIVATE_KEY`, etc.
- AWS, GCP, Stripe, JWT, PEM, database connection strings, npm tokens, Slack
  tokens, Bearer headers, GitHub tokens.

Never write outside the repo/workspace root without explicit permission.

Writing code requires an approved plan. Approval is explicit and per-version:
a button in the extension, `--approve` on the CLI. Silence, a question, or
qualified agreement are not approval.

## Generated Artifacts

All runtime artifacts live under:

```text
.copilot-architect/
├── repo-map.json
├── workspace.json
├── commands.json
├── policy.json
├── graph.json
├── index/
├── sessions/
├── plans/          drafts, and approved/ for plans that were signed off
├── handoffs/
├── runs/
├── reviews/
├── audit/
└── diagnostics/
```

GitHub Copilot integration artifacts:

```text
.github/
├── copilot-instructions.md
├── prompts/         *.prompt.md
└── skills/          SKILL.md files
.vscode/
└── mcp.json
```

Generated text must name the real front door. `CHAT_PARTICIPANT` and
`CHAT_COMMANDS` in `packages/shared/src/constants.ts` are the single source:
never hard-code a mention. A generated artifact naming an agent that does not
exist sends a developer to type into the void and report that "the agent" is
broken.

## Testing

Use Vitest. All 449 tests must pass before merging.

Cover:

- adapter detection (all supported stacks)
- repo discovery (single and multi-repo)
- indexing (full, incremental, rebuild, staleness)
- search (scoring, filtering, cross-repo fan-out, graph expansion)
- symbol graph construction and cross-repo edges
- session lifecycle (phase, decisions, plan versions, park, end, read-only peek)
- decision proposal parsing, confirmation wiring and supersession
- dashboard session rendering, including the idle and moved-branch states
- plan contract (freshness, approval gating, path constraints)
- change selection (invented paths, add-of-existing, traversal, caps)
- rationale evidence (verified, unverified, and honestly unchecked)
- new-file outlines (exports, unreal imports dropped, size bounds)
- outline checked against the written file, end to end through the index
- write previews (line deltas, truncation guard, staging lost on reload)
- staged diff URIs and the read-only content provider behind them
- file edits (unique-match requirement, all-or-nothing, literal replacement)
- grounding (claim extraction including prose calls, verification, honest "not checked")
- Java symbol extraction (methods indexed, control flow excluded)
- multi-repo path resolution (unique suffix, ambiguity, segment boundaries)
- feature planning (JSON + Markdown output)
- custom command config (parse, validate, merge)
- validation safety (blocked commands, safe execution)
- MCP tools (all 30 tools)
- role prompt rendering
- instructions generation and validation
- handoff generation (approval gating, git checkpoint)
- review reports (diff, risk detection, missing tests)
- CLI commands (help, JSON output, exit codes)
- extension chat phases and packaged CLI invocation
- multi-repo workspaces
- end-to-end sample repos
- demo command
- secret redaction patterns
- node version check in doctor

```bash
npm test                      # run all tests
npm run cli -- demo           # end-to-end smoke test
npm run cli -- doctor         # environment check
```

## Development Style

Work phase by phase.

For every phase:

1. Implement code.
2. Add tests.
3. Run tests (`npm test`).
4. Update docs.
5. Run `npm run build` and confirm zero TypeScript errors.
6. Summarize changed files.
7. List limitations — in `docs/KNOWN_LIMITATIONS.md`, not only in the summary.
8. Stop before moving to the next phase.

When a test fails, fix the cause or the fixture. Do not relax the assertion to
make it pass.
