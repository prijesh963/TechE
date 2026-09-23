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

1. **A release download** — the normal path. Every push to `main` builds the
   `.vsix` and attaches it to a release, so the recipient needs VS Code and
   Copilot, not Node, npm or a clone. The CLI is bundled inside the package
   and spawned by absolute path. The `.vsix` is a build output and is
   gitignored: it is never committed, so a source ZIP contains none.
   `npm run package:vsix` builds one locally, clearing older packages so the
   newest is the only one an install dialog offers.
2. Git clone + `scripts/setup.sh`, for developing the tool itself.
3. `npm link --workspace @copilot-architect/cli` for a global command.
4. `npm run package:local` to build a tarball for teammates.

## Core Architecture

A TypeScript-first monorepo, with one deliberate exception noted below:

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
│   ├── mcp-server/      MCP server and 28 tools
│   ├── dashboard/       shared dashboard render+load logic (used by vscode-extension and the CLI's `dashboard` command)
│   ├── cli/             CLI entry point and command routing
│   ├── vscode-extension the @architect chat participant and dashboard
│   ├── intellij-plugin  the IntelliJ edition — Kotlin/Gradle, the one
│   │                    non-TypeScript package, kept out of `tsc -b`/`vitest`
│   │                    entirely; see its own README.md. Lives on this
│   │                    branch (intellij-main), not on main.
│   └── web/             optional local web UI shell (thin)
├── templates/
│   ├── instructions/
│   └── skills/
├── samples/             8 representative repos (React, Angular, Python, Java, Go, polyglot)
├── tests/               51 files, 617 tests
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

One standing, explicitly accepted exception: `vscode-extension`'s own
Setup/Scan orchestration (`setupRepo`, `registerSubRepos`,
`shouldBuildWorkspaceGraph`) was left in place rather than extracted when
the IntelliJ edition needed the same behavior — see item 28 above and
`docs/KNOWN_LIMITATIONS.md` 4.18 for why, and for the drift risk that
decision carries.

## Do Not Build in MVP

- Visual Studio (the IDE) extensions — VSIX here means the **VS Code** package
  built by `npm run package:vsix`, which is in scope and shipping
- WPF / Blazor UI
- .NET core engine
- Commercial marketplace packaging
- Heavy vector database or cloud backend
- Enterprise installer

## Implemented

1. TypeScript CLI with 27 commands including `demo`.
2. Local MCP server with 28 tools, including the session, plan contract and
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
    checks the file that landed against it. The draft also says what the
    change does — an approach, and a step per file saying what happens to it,
    so approval is given to a change rather than to a file list. The steps
    are what `/implement` is instructed with and what `/review` compares
    against.
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
    relationships, risk scoring — computed for every registered repo in a
    workspace, not only the first, and each result tagged with the repo it
    came from.
21. VSIX packaging, internal setup docs, npm link support.
22. Integration detection: datastores, messaging, micro-frontend platforms,
    microservice platforms, deployment orchestration (Kubernetes, Helm,
    Docker Compose), monorepo build tooling (Nx, Turborepo) and test
    automation frameworks (Playwright, Cucumber, TestNG) — detected
    independently of language/framework, so an arbitrary combination composes
    without a detector per combination. Each detection carries its own risk
    guidance into `/create-plan`, and a detection with no guidance of its own
    still gets its category's baseline, so a new detector is never
    plan-silent.
23. One canonical, corrected `isTestFile`, used everywhere the question is
    asked. It existed as four separate, disagreeing implementations before —
    the same problem the Core Rule above describes for retrieval, just for a
    smaller helper — and one of the disagreements meant a root-level `test/`,
    `tests/` or `spec/` folder (no leading slash in a repo-relative path) was
    silently invisible to some of them, which is exactly Cucumber's common
    shape. Also recognizes `.feature` files and the JUnit/TestNG
    `SomethingTests.java` suffix convention.
24. Cross-repo interlink matching, both reported in
    `AdvancedAnalysis.interlinks`, tagged with both repos:
    - HTTP-route: an HTTP client call (`axios`/`fetch`/`requests`, an
      OpenFeign client method) whose path matches a route exposed by a
      *different* registered repo, confidence based on HTTP-method
      agreement. A `@FeignClient` interface's own `@GetMapping`-style
      annotations are read as the call they are, not misreported as a route
      the calling repo itself exposes.
    - Messaging: a producer (kafkajs/kafka-python/confluent-kafka,
      amqplib/pika, Spring Kafka/AMQP/JMS) whose topic/queue/destination
      name and broker match a consumer in a *different* registered repo —
      Kafka, RabbitMQ, and JMS (the API IBM MQ and ActiveMQ are also
      normally driven through in Java).
    - Both matchers resolve a path/topic given as a named constant
      (`kafkaTemplate.send(ORDER_TOPIC, ...)`), not only a repeated string
      literal — a value built from a variable at runtime (an interpolated
      template literal) is still not followed. A non-relative TS/JS import
      of another registered repo's own declared package name also resolves
      in the symbol graph. See `docs/KNOWN_LIMITATIONS.md` 4.14 for the
      full list of what each matcher does and does not catch.
25. Symbol-graph call resolution through a field, a constructor parameter
    property, a plain parameter (varargs included in Java), a local
    variable, or a `for...of`/enhanced-for loop variable resolved to an
    array's element type — not only a bare identifier or a single-level
    property access. `this.repo.save(...)`, a method-local
    `OrderRepository repo = new OrderRepositoryImpl(); repo.save(...)`, and
    `for (const order of this.orders) { order.approve(); }` all resolve now,
    in both the TypeScript and Java extractors, with a local variable
    correctly shadowing a same-named field. Remaining gaps (union-typed
    fields, method chaining, data-flow/reassignment) are in
    `docs/KNOWN_LIMITATIONS.md` 4.15.
26. `createDashboardHtml` and its loaders (`loadDashboardArtifacts`,
    `loadDashboardSession`) moved out of `vscode-extension` into a new
    `packages/dashboard`, which the extension now imports unchanged (a thin
    wrapper assembles its own `command:` action-row HTML and passes it in,
    so its rendered output is unaffected) — plus a new CLI command,
    `copilot-architect dashboard [--path] [--json]`, that imports the same
    package and prints the identical HTML (or the underlying data, with
    `--json`) for a host that cannot import it directly. Done ahead of an
    IntelliJ edition that needs the exact same dashboard without being able
    to import TypeScript at all — see the `intellij-main` branch.
27. That IntelliJ edition, Phase 1: `packages/intellij-plugin` (Kotlin/
    Gradle — the one non-TypeScript package). A single Tool Window renders
    the shared dashboard by spawning the CLI's `dashboard` command and
    loading its stdout HTML into a JBCef (embedded Chromium) view, themed to
    the current IntelliJ Look and Feel — the same "a shell calls the CLI,
    never reimplements the logic" rule the VS Code extension follows,
    extended to a shell that cannot import TypeScript at all. Its own
    path-filtered CI job (`.github/workflows/intellij-ci.yml`), since Gradle
    and `tsc -b`/`vitest` have nothing to say to each other. Chat, plan
    approval and diff are later phases; see `docs/KNOWN_LIMITATIONS.md` 4.17
    and `packages/intellij-plugin/README.md` for exactly what Phase 1 does
    and does not cover. The Gradle build itself could not be verified in
    the sandbox it was written in (JetBrains' distribution hosts are
    blocked by that environment's network policy, confirmed directly
    rather than assumed) — but has since built green in real CI on PR #3,
    six root-caused fixes later; see `docs/KNOWN_LIMITATIONS.md` 4.19 for
    the full account and for what a green build does and does not prove
    (compiles and passes the Plugin Verifier's static checks; nobody has
    run it inside a real IDE yet).
28. IntelliJ edition, Phase 2: every dashboard action link VS Code exposes —
    Setup Repo, Start & Setup MCP, Stop MCP, Generate Instructions, Open
    Repo, Scan & Register Sub-repos, Analyze Repo, Build Index, Build
    Symbol Graph — is now reachable from the IntelliJ dashboard too. The
    CLI's `dashboard` command renders them as `architect-action:<id>`
    links, a host-neutral scheme this plugin defines and intercepts itself
    (`ActionLinkInterceptor.kt`), and gained `--mcp-status`/
    `--last-command`/`--last-exit-code`/`--last-stdout`/`--last-stderr`
    flags so a long-lived caller can report its own accurate runtime state
    into an otherwise one-shot render. Two new general-purpose CLI commands
    back the orchestrated actions: `workspace scan <dir>` and
    `setup [--workspace]`, the full init→analyze→graph→diagnostics→
    index→mcp-config sequence. On the Kotlin side, `ActionDispatcher.kt`
    routes each id to the CLI, to a new `McpProcessManager.kt` (the
    project-level handle on this window's own long-lived MCP server
    process — a process cannot be reported by a one-shot CLI call, so this,
    not the CLI, is the source of truth `DashboardPanel` reads before every
    render), or to native IntelliJ APIs (`FileChooser`, `ProjectUtil
.openOrImport`) for the two actions — Open Repo, Stop MCP — that are
    IDE-native rather than repo intelligence, the same as their VS Code
    equivalents.

    **Explicit, accepted Core Rule exception:** VS Code's own
    `registerSubRepos`/`setupRepo`/`shouldBuildWorkspaceGraph`
    (`vscode-extension/src/index.ts`) were left completely untouched by
    deliberate instruction rather than refactored into a shared call both
    shells make — the CLI's `runSetupCommand`/`shouldBuildWorkspaceGraph`
    are an independent reimplementation of that same step sequence and
    skip heuristic, not a shared one, and the two copies can drift. See
    `docs/KNOWN_LIMITATIONS.md` 4.18 for the full account, including why
    this is the exact duplication-of-retrieval failure mode this file's own
    Core Rule section warns about, accepted here explicitly. The Kotlin
    side now builds and passes the IntelliJ Plugin Verifier in CI (PR #3) —
    see 4.19 — but has still never been run inside a real IDE.
29. A curated `intellij` MCP toolset, for an org where GitHub Copilot via
    MCP is the only sanctioned LLM route in IntelliJ (no chat participant
    API there, no BYO API key allowed) — so every tool schema Copilot
    Architect registers is a fixed cost paid on every single Copilot Chat
    turn, whether or not that turn uses it. `packages/mcp-server`'s
    `MCP_TOOLSETS` (in `tools.ts`, the one place the actual tool identity
    lives, so the curated list can't drift from what's really registered)
    names two: `full` (all 28 tools, unchanged default behavior) and
    `intellij` (12 tools — retrieval, planning, and read-only session/plan/
    grounding state). `--toolset <name>` on `mcp`/`mcp config` selects one;
    `mcp config` bakes it into the generated server's `args`. The other 16
    tools are excluded for two different reasons, not one: most (`detect_*`,
    `get_validation_commands`, `get_safety_policy`, `repo_map`,
    `workspace_map`, `get_symbol_graph`) are redundant — either already
    printed in generated Copilot instructions (item 26) or a one-time Setup
    Repo step rather than a per-turn conversational call — but `approve_plan`
    is excluded for safety, not tokens: if the model can call it, "approve
    it" typed in chat becomes a real approval, which is exactly what
    "approval is a button, not a phrase" (Safety Rules, below) exists to
    prevent. Approval stays a Tool Window click (see item 31) or
    `plan approve --revision <n> --by <name>` from a terminal.
    Generated Copilot instructions also gained a "Retrieval Workflow"
    section telling Copilot to search before reading a file directly and to
    stop re-discovering facts the instructions file already states — the
    two are complementary: the toolset limits what's callable, the
    instructions steer how what remains gets used.
30. `find_impacted_files` and `analyze_impact` no longer exist as separate
    MCP tools — both folded into `generate_plan_context` (28 tools total
    now, down from 30), which calls `FeaturePlanningService.
createPlanPreview()` once and returns search results, impact analysis,
    and likely-files-to-modify/add together, rather than three tools each
    independently re-running overlapping search/analysis for one
    conversation's "what would this touch" question. Verified against the
    real tool, not only the unit fixtures: one call now returns search
    results, `impactAnalysis` (with risks and affected commands), and
    `likelyFilesToModify` together, where three separate calls returned
    each piece on its own before. See `docs/KNOWN_LIMITATIONS.md` 4.21 for
    what each of the three used to return and why `find_impacted_files`'s
    own shape isn't reproduced separately — it was a strict subset of
    `likelyFilesToModify`, never additional information.
31. Plan review and approval from the IntelliJ Tool Window, closing the gap
    item 29 left open: `approve_plan` is excluded from the `intellij` MCP
    toolset by deliberate safety design, so until now the only way to
    promote an MCP-generated `FeaturePlanArtifact` revision to `approved`
    from IntelliJ was a terminal (`plan approve --revision <n> --by
<name>`). VS Code's own equivalent is a real chat button rendered directly
    under the plan's markdown (`stream.button({command: APPROVE_PLAN_COMMAND,
    ...})`); IntelliJ has no chat-button API to mirror, so the click surface
    is the Tool Window instead — the same place every other IntelliJ action
    already lives.
    - `FeaturePlanningService.diffRevisions()` (`packages/planner`), new:
      a field-level diff between two revisions, scoped to exactly the
      `PlanSectionOverrides` keys `revise_feature_plan` can change — every
      other `FeaturePlanArtifact` field is identity/schema/computed and
      never revision-editable, so it is never reported as a "change". List
      fields (`likelyFilesToModify`, `openQuestions`, etc.) report
      added/removed; scalar fields (`title`, `summary`, `impactAnalysis`,
      etc.) report before/after. Defaults to the immediately preceding
      revision (`to - 1`) — `from`/`to` are both overridable, and diffing a
      revision against itself, or revision 1 against a revision that does
      not exist, is rejected rather than silently returning nothing.
    - CLI: `plan diff [--from <n>] [--to <n>] [--path <repo>] [--json]`.
    - The `dashboard` command's action row gains two conditional links,
      parameterized by the revision the render actually showed rather than
      a fixed id like every other action — `showPlanDiff:<n>` (once a prior
      revision exists to diff against) and `approvePlan:<n>` (while the
      latest revision is still a draft) — so the exact revision approved can
      never drift from the one displayed, matching `approvePlan()`'s own
      "revision is required, never 'whatever is newest'" rule
      (`packages/planner/src/feature-planning-service.ts`).
    - Kotlin: `ActionDispatcher` routes `showPlanDiff:<n>` to a new,
      read-only `PlanDiffDialog` (plain `JTextArea`/`JBScrollPane`, matching
      this plugin's existing preference for the smallest Swing API surface
      that does the job) and `approvePlan:<n>` to a native
      `Messages.showYesNoDialog` confirm — an actual button, not a phrase
      typed into chat, the same gate the Safety Rules apply to `@architect`'s
      own chat button — before running `plan approve` with `approvedBy`
      taken from the OS account (an audit field, not a choice, so it is
      never prompted for).

32. Copilot Chat without MCP, from the IntelliJ Tool Window — for an
    organization whose Copilot policy blocks MCP servers, so Copilot cannot
    call Copilot Architect's tools at all and item 29's toolset never loads.
    The only channel left to the model is what a developer pastes into
    Copilot Chat, so the Tool Window gained a "Work with Copilot Chat" panel
    (a text box and one button per phase) and the product hands prompts over
    through the clipboard instead of tool calls:
    - `CopilotHandoffService` (`packages/planner`): Ask builds a prompt with
      the index's top matches quoted in, under the analyze role; Plan asks for
      all three `/create-plan` record kinds (selection, approach/steps,
      new-file outlines) in one reply, since each parser skips lines that are
      not its own; Import parses a pasted reply into the same `PlanContract`,
      in the same session, that `/create-plan` produces — invented paths
      dropped, cited symbols checked, snapshots read from disk; Approve
      promotes the exact version clicked and writes `plans/approved/`;
      Implement builds a prompt from the newest approved version and refuses
      if a planned file changed since the plan quoted it.
    - CLI: `copilot <ask|plan|import|approve|implement|state>`, prompts out
      via `--prompt-out`, replies in via `--response-file`, so the plugin
      never parses CLI output. `dashboard` gained `--task`/`--notice` and a
      host-supplied Current work hint (no `@architect` in IntelliJ).
    - Kotlin: `CopilotActions.kt` copies the prompt, opens Copilot Chat,
      reads Copilot's reply back off the clipboard for Import, and asks for
      approval in a real dialog. See `docs/KNOWN_LIMITATIONS.md` 4.26.

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

### Parsed symbol extraction

Go and Rust symbols come from a tree-sitter grammar rather than a regex,
so a declaration is found because the grammar says it is one. Both measured
zero symbols per file before this: not silence, but every true claim about
them reported as a fabrication. Every other language keeps the pattern
list unchanged.

### Architecture-level integration detection

Detected by content or by canonical filename (`nx.json` is evidence the same
way `pom.xml` is), independently of the language/framework adapters:

- **Datastores** — Oracle, MongoDB, PostgreSQL, MySQL, SQL Server, Redis.
- **Messaging** — Kafka, IBM MQ, JMS, ActiveMQ, RabbitMQ.
- **Micro-frontend** — Module Federation, single-spa, Web Components.
- **Microservice platform** — Spring Cloud, service discovery, API Gateway,
  OpenFeign.
- **Orchestration** — Kubernetes, Helm, Docker Compose.
- **Monorepo build tooling** — Nx, Turborepo.
- **Test automation** — Playwright, Cucumber (`.feature` files), TestNG.

A plain-service repo behind Kubernetes or Compose, or a monorepo wired
together by Nx or Turborepo, is a common shape outside the Java ecosystem
that Spring Cloud detection alone would miss — this is what catches it.
Test automation is a separate axis from the per-language test frameworks
(JUnit, pytest) the adapters already detect, because Playwright and Cucumber
both cross language boundaries on their own.

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

Use Vitest. All 617 tests must pass before merging.

Cover:

- adapter detection (all supported stacks)
- repo discovery (single and multi-repo)
- indexing (full, incremental, rebuild, staleness)
- search (scoring, filtering, cross-repo fan-out, graph expansion)
- symbol graph construction and cross-repo edges
- session lifecycle (phase, decisions, plan versions, park, end, read-only peek)
- decision proposal parsing, confirmation wiring and supersession
- dashboard session rendering, including the idle and moved-branch states
- dashboard session-activity rollups (decisions by kind, plan revision/approval
  cycle, constraint enforcement coverage, session duration) computed from the
  session record rather than estimated
- search-activity log (files a search call actually returned, read back
  since a given timestamp) backing the "files referred from the index" figure
- session git-diff stats (lines/files changed since a session opened, based
  on the commit that was `HEAD` at that time rather than `Session.gitHead`,
  which does not move for a same-branch commit) and its honest fallback when
  no git history reaches that far back
- the shared dashboard package's own contract in isolation (no host-specific
  actions/build-version wiring assumed, honest "unknown" build fallback,
  host-supplied action HTML rendered exactly as given) and the CLI's
  `dashboard` command (HTML on stdout, `--json` for the underlying data, no
  session/MCP process to introspect reported honestly rather than guessed)
- plan contract (freshness, approval gating, path constraints)
- change selection (invented paths, add-of-existing, traversal, caps)
- rationale evidence (verified, unverified, and honestly unchecked)
- new-file outlines (exports, unreal imports dropped, size bounds)
- plan approach and per-file steps (records parsed, unplanned paths
  dropped, caps, and the steps handed to `/implement`)
- outline checked against the written file, end to end through the index
- write previews (line deltas, truncation guard, staging lost on reload)
- staged diff URIs and the read-only content provider behind them
- apply reporting (notification, refused counts, the checks action and
  when it is withheld)
- file edits (unique-match requirement, all-or-nothing, literal replacement)
- grounding (claim extraction including prose calls, verification, honest "not checked")
- Java symbol extraction (methods indexed, control flow excluded)
- call-graph resolution through a field, a constructor parameter property, a
  plain parameter (varargs included in Java), and a local variable (explicit
  type or inferred from `new`), in both the TypeScript and Java extractors,
  including a local correctly shadowing a same-named field
- call-graph array/loop resolution: a `for...of` (TypeScript) or
  enhanced-for (Java) loop variable resolved to a param/field/local array's
  element type, `this.`-reached fields included
- cross-repo TS/JS package-name import resolution (exact and subpath, via
  `main`/`module`/`types` and the `index.*`/`src/index.*` fallback; a real
  external package still unresolved)
- parsed symbols (Go receivers, Rust items, start lines, kinds, and
  declining a language so the pattern list still runs)
- multi-repo path resolution (unique suffix, ambiguity, segment boundaries)
- advanced analysis across a multi-repo workspace (every registered repo
  represented and `repoName`-tagged, not only the first; workspace-wide
  repo-map/index diagnostics computed once rather than once per repo; a
  polyrepo workspace not mistaken for any one member being a monorepo)
- cross-repo HTTP-route interlinks (an outbound call matched to a route in a
  different repo; a same-repo match not reported as an interlink; a
  `@FeignClient`'s own mappings excluded from the routes it exposes)
- cross-repo messaging interlinks (Kafka producer matched to a consumer in
  another repo across kafkajs/kafka-python/confluent-kafka and Spring Kafka;
  RabbitMQ across Java and Python; JMS covering IBM MQ/ActiveMQ's own API; a
  different channel name not matched; a same-repo producer/consumer pair not
  reported)
- constant resolution in interlink matchers and Spring/Feign route detection
  (a named constant resolved to its declared value; an unresolved reference
  dropped rather than read as literal path text)
- the no-MCP Copilot handoff (grounded Ask prompt, one-reply Plan prompt,
  importing a pasted reply into a plan contract with invented paths dropped
  and unverified symbols reported, re-import as the next version, refusing a
  reply with no plan lines, approval of the exact version, implement refused
  for a draft or a drifted file, read-only state) and its CLI command and
  dashboard panel
- feature planning (JSON + Markdown output)
- plan revision diffing (added/removed list items, scalar before/after,
  defaulting to the immediately preceding revision, rejecting a
  revision-against-itself or a nonexistent prior revision) and its CLI
  surface (`plan diff`, text and JSON) and dashboard action links
  (`approvePlan:<n>`/`showPlanDiff:<n>`, gated on draft status and on a
  prior revision existing, carrying the exact revision rendered)
- integration detection (datastore/messaging/micro-frontend/microservice/
  orchestration/monorepo-tooling/test-automation, by content and by
  canonical filename, and the risk guidance each carries into a plan)
- isTestFile (root-level test folders, .feature files, the Tests.java
  suffix, and not false-positiving on an ordinary file whose name merely
  contains "test")
- custom command config (parse, validate, merge)
- validation safety (blocked commands, safe execution)
- MCP tools (all 28 tools)
- role prompt rendering
- instructions generation and validation
- handoff generation (approval gating, git checkpoint)
- review reports (diff, risk detection, missing tests)
- CLI commands (help, JSON output, exit codes)
- the invocation help names (bundled file, linked bin, workspace script,
  and an unfamiliar host)
- proposed new files (named from the feature, placed where the language
  lives, and omitted when the repo gives no evidence)
- extension chat phases and packaged CLI invocation
- multi-repo workspaces
- end-to-end sample repos
- demo command
- secret redaction patterns
- node version check in doctor
- the release workflow (full history for the build number, checks before
  packaging, one package or none)
- the packaged README (a repository for its relative links to resolve
  against, and no flag suppressing the check)
- the run's temp root (fixtures redirected into it, and the variables a
  spawned process reads)

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
