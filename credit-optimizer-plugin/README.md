# Credit Optimizer

An IntelliJ plugin for a Java/Spring Boot microservices codebase where
GitHub Copilot runs on a fixed monthly AI-Credit budget. It answers
factual questions (a route's contract, who consumes a topic, which bean
implements an interface) from a local index, for free, and only hands
genuine generation tasks to Copilot — with a minimal, exact bundle
instead of whole files.

See the design discussion this was built from for the full architecture,
the token-economics reasoning, and the UI mockups. This README covers
what actually exists in code, what is verified, and what is not.

## Three modules, on purpose

- **`:core`** — repo discovery, the lightweight Java parser, local JSON
  storage, the free-path router, the usage log. Plain Kotlin/JVM, **no
  IntelliJ Platform dependency at all.** Fully built and tested in any
  environment, including the sandbox this was developed in.
- **`:mcp-server`** — exposes `:core`'s router/retrieval as an MCP tool,
  so Copilot Chat can call directly into the local index. Also plain
  Kotlin/JVM (the MCP Kotlin SDK is an ordinary Maven Central library,
  not an IntelliJ Platform dependency) — **buildable, runnable, and
  actually exercised in this sandbox**, unlike `:plugin`: compiled
  against the real SDK API (confirmed via `javap` on the resolved jars,
  not guessed from docs that turned out to disagree with each other on
  one call), and run end-to-end against a real index fixture to confirm
  it starts, doesn't crash, and doesn't exit before a client would ever
  connect. See "MCP server" below.
- **`:plugin`** — the IntelliJ Platform shell (tool window, quick-ask
  action, settings) that calls `:core` for every real decision. Requires
  resolving the IntelliJ Platform distribution from JetBrains' own hosts,
  which this development sandbox cannot reach (confirmed with `curl`, not
  assumed — see `plugin/build.gradle.kts`). **Written against the stable,
  documented IntelliJ Platform APIs; never built or run in this
  sandbox.** Its real verification is `.github/workflows/plugin-ci.yml`,
  on a runner with no such restriction — the same "written here, proven
  in CI" split the `intellij-main` branch's own plugin uses, for the same
  reason.

## ADR-001: PSI vs. JavaParser for the index

IntelliJ's PSI gives exact, compiler-grade resolution — but only for code
that is part of the *currently open* IntelliJ project, because PSI needs
a resolved module/classpath. A sibling microservice repo sitting on disk,
not opened in this window, has no PSI available for it at all.

The index therefore uses a **standalone parser (JavaParser)** for every
configured repo, not PSI — including the one currently open. This means
every service is indexed the same way, with the same (real, useful,
slightly-less-than-PSI-exact) fidelity, rather than the currently-open
service getting one kind of resolution and every sibling getting another.
A future phase can layer PSI on top for the currently-open file
specifically (see "Not yet built" below) without changing how sibling
repos are indexed.

## What's actually built, and tested

`:core` — 67 tests, all passing (`gradle :core:test`):

- **`JavaServiceParser`** (`core/src/main/kotlin/.../parse/JavaServiceParser.kt`)
  — extracts from `.java` source on disk, no compiled classpath needed:
  - REST routes: HTTP method, combined class+method path, the
    `@RequestBody` parameter's type, and the return type unwrapped from
    `ResponseEntity<T>`/`Mono<T>`/`Flux<T>`.
  - Kafka `@KafkaListener` consumers and `kafkaTemplate.send(...)`/
    `rabbitTemplate.convertAndSend(...)` producers — a topic/queue name
    given as a same-file `static final String` constant is resolved; one
    built at runtime is dropped, never guessed at (there's a test for
    exactly this).
  - `@Service`/`@Component`/`@Repository` beans and the interface(s) they
    implement, with `@Profile`/`@ConditionalOnProperty` captured as the
    bean's condition.
  - Every method as a symbol, with its file and start line.
  - **Call graph** (`CallFact`): every method call inside a class, with the
    receiver resolved through a field, a method parameter, a local
    variable with an explicit type, or a for-each loop variable — `this.`
    reached fields included, a local correctly shadowing a same-named
    field or parameter. An unqualified call is attributed to its own
    class. A `var`-typed local's real type isn't recoverable without a
    resolved classpath, so its raw identifier is kept rather than guessed.
  - **Outbound HTTP calls** (`HttpClientCallFact`): a `RestTemplate`
    call (`getForObject`/`postForObject`/`exchange`/...) whose path is a
    literal or same-file constant; a `WebClient` fluent call, verb read
    from its `.get()`/`.post()`/... in the same chain; and a
    `@FeignClient` interface's own `@GetMapping`-style methods — the call
    it declares, not a route it exposes (kept out of the route extractor
    the same way a `@FeignClient` already was).
  - A file that fails to parse (invalid syntax, an unsupported
    construct) is skipped, not fatal to the rest of the service.
- **`DependencyParser`** (`core/src/main/kotlin/.../parse/DependencyParser.kt`)
  — declared build dependencies, repo-wide (`parseRepo`), not one build
  file in isolation:
  - Maven: every `pom.xml` in the repo is parsed together — `${property}`
    resolution and `<dependencyManagement>` version lookup are pooled
    across all of them, so a child module's dependency with no
    `<version>` resolves from a parent `pom.xml` elsewhere in the same
    repo. This is an approximation of real Maven inheritance (it doesn't
    follow the actual `<parent>`/`relativePath` chain, and never reaches
    outside the repo to a published parent or a BOM import), documented
    as such rather than passed off as the real thing.
  - Gradle: `implementation("group:artifact:version")` literals (Groovy
    or Kotlin DSL), plus a `libs.xxx.yyy` version-catalog accessor
    resolved against `gradle/libs.versions.toml` when the repo has one —
    both the shorthand `alias = "group:artifact:version"` form and the
    `{ module = "...", version.ref = "..." }` table form. The
    accessor-to-alias mapping is a dot-to-kebab heuristic, not the real
    Gradle accessor grammar, so an unusual alias name can miss.
- **`IntegrationDetector`** (`core/src/main/kotlin/.../parse/IntegrationDetector.kt`)
  — the datastores and messaging brokers a service is wired to: Oracle,
  PostgreSQL, MySQL, SQL Server, MongoDB, Redis, Kafka, RabbitMQ,
  ActiveMQ, IBM MQ, TIBCO EMS, TIBCO Rendezvous. Detected two independent
  ways, either sufficient alone — a dependency coordinate matching a
  known driver/client, or a connection string/config key found in
  `application.yml`/`.properties` (including `application-<profile>`
  variants). This is keyword/coordinate matching against a fixed table,
  not a schema or a live connection check: it says a service is *wired
  for* Oracle/Kafka/TIBCO/etc., never that the connection works, and a
  technology this table doesn't name is invisible to it.
- **`IndexStorage`** — one JSON file per service, round-tripped losslessly;
  a service that was never indexed loads as nothing, not an error.
- **`InterlinkResolver`** (`core/src/main/kotlin/.../router/InterlinkResolver.kt`)
  — real computed cross-repo messaging edges: a producer in one service
  paired with a consumer in a *different* one on matching channel name
  (case-insensitive) and broker. A same-service producer/consumer pair is
  never reported as a link, and a different channel or broker is never
  matched.
- **`FreePathRouter`** — answers seven question shapes directly from the
  index (a route's contract — including which *other* service calls
  it, resolved across all configured repos — who consumes/produces a
  channel, including the real cross-repo producer/consumer pairing from
  `InterlinkResolver`; which bean implements an interface; who calls/what
  a method calls; a service's declared dependencies; and a service's
  datastore/messaging integrations) and returns `NeedsGeneration` for
  everything else, on purpose — this router does no fuzzy/LLM-like
  guessing; a wrong "free" answer would be worse than admitting a
  question needs Copilot. A method must be named with `()`
  (`"who calls processOrder()"`), and a question naming a specific known
  technology the service doesn't actually have (`"does X use MongoDB?"`
  when it doesn't) falls through rather than listing unrelated
  integrations — the same "an explicit signal, not a guess" rule every
  other matcher already followed.
- **`UsageLog`** — an append-only JSONL log tagging every question INDEX
  or COPILOT, and `localAnswerShare()` — the actual, measured version of
  the earlier discussion's percentage estimate (see "Measuring it for
  real," below).
- **`IndexService`** — ties discovery, parsing and storage together;
  re-indexing one service doesn't touch another's stored index.
- **`ContextRetrieval`** (`core/src/main/kotlin/.../handoff/ContextRetrieval.kt`)
  — deterministic keyword-overlap retrieval over every fact type, used to
  ground an Ask/Plan prompt with real facts instead of nothing or a whole
  file dump. It only picks which true facts are worth quoting; it never
  guesses at what they mean — that's still Copilot's job, same boundary
  `FreePathRouter` draws.
- **`CopilotHandoffService`** (`core/src/main/kotlin/.../handoff/CopilotHandoffService.kt`)
  — builds the Ask/Plan/Implement prompts and turns Copilot's output
  back into a [FeaturePlan] two ways: `importPlan` parses a pasted reply
  (clipboard flow), `recordPlan` takes already-structured files/steps
  directly (the MCP `draft_plan` tool's call). Both apply the same rule:
  an `UPDATE`/`DELETE` naming a path the index has never indexed for
  that service is dropped, never trusted. `buildImplementPrompt` refuses
  (`null`) for a draft plan and quotes an `UPDATE` file's real current
  on-disk content, not Copilot's memory of it.
- **`PlanStorage`** — every plan revision, one JSON file per plan id,
  same shape as `IndexStorage`; revisions are kept, not overwritten.

### Cross-repo linking — what's real now, and what deliberately isn't

- **HTTP, real:** an `HttpClientCallFact` in one service is matched
  against a `RouteFact` in every *other* configured service by path
  (`{id}` vs `{orderId}` normalized to the same shape before comparing) —
  this is an actual resolved link, not a name coincidence, and shows up
  directly in a route answer as "called from."
- **Messaging, real:** `InterlinkResolver.messagingInterlinks` computes
  an actual producer→consumer edge across services (matching channel and
  broker, same-service pairs excluded) — a "who consumes X" answer now
  shows "produced by: order-service (...)" from that computed edge, not
  a flat channel-name filter.
- **No cross-repo call graph, on purpose.** Independently-deployed
  microservices don't share a compile-time classpath, so there's no real
  Java-method-to-Java-method call across two separate service repos the
  way there is within one — HTTP and messaging are the two things that
  actually connect them, and both are now real computed links rather
  than one of the two being just a name filter.
- **Config files are read now, but only for integration detection.**
  `IntegrationDetector` scans `application.yml`/`.properties` for
  connection strings and config keys — but still nothing reads
  Dockerfiles, K8s manifests, or certificates/keystores, and a
  `@Value("${...}")` placeholder is still recorded as text, never
  resolved against a properties file.

`:plugin` — written, not yet run in a real IDE:

- `plugin.xml`, a Tool Window (status, Reindex button, an ask box wired
  to `IndexBridge.ask()`, and a history view), and a Ctrl+Alt+K quick-ask
  popup — both call the same `IndexBridge`, so there is exactly one path
  from a question to an answer, not two that could disagree.
- **Plan a feature / Paste Copilot's reply / Current plan / Approve /
  Copy Implement Prompt** — a Plan/Implement section in the same Tool
  Window, clipboard-mediated end to end: Draft Plan copies a grounded
  prompt; a pasted reply is parsed into a plan revision (an invented
  path dropped, per `CopilotHandoffService`); Approve gates Implement,
  which is disabled until a plan is approved and copies a prompt quoting
  each `UPDATE` file's real current content. One plan in flight at a
  time — no plan-id field, matching the old Copilot Architect project's
  "one feature at a time" session rule. A question that needs Copilot
  now also auto-copies its own grounded prompt to the clipboard, instead
  of just saying so.
  **Why clipboard, not `@mention` or an MCP prompt, for Plan/Implement:**
  GitHub Copilot Extensions (the only mechanism that ever let a
  third-party tool respond to a typed `@mention` across IDEs) were shut
  down entirely on November 10, 2025 — that path is gone for good, not
  just for this org. MCP is the real modern replacement, and it's what
  `:mcp-server` now provides for Q&A (`ask_index`) — no clipboard needed
  there once the org's "MCP servers in Copilot" admin policy is turned
  on (off by default). Drafting a plan is also now available over MCP
  (`draft_plan`) — but Approve and Implement still aren't: handing
  Copilot a tool that can write files or approve its own plan is a real
  governance line, and this project draws it there on purpose, not by
  omission. See "MCP server" below.
- `PluginSettings` — per-project, persisted sibling-repo paths.
- `CreditOptimizerSettingsConfigurable` (Settings > Tools > Credit
  Optimizer) — a real settings page: a list with `+`/`-` toolbar buttons,
  `+` opening a directory-only file chooser rather than a free-text
  field, bound to the exact same `PluginSettings` state the XML already
  round-trips. Hand-editing `.idea/creditOptimizer.xml` still works, it's
  just no longer the only way in.

## MCP server

Two tools, deliberately scoped where the line is drawn:

- **`ask_index`** — answers a question the same way the Tool Window's
  Ask box does (`FreePathRouter` first, falling back to
  `ContextRetrieval`'s closest facts), but callable by Copilot's own
  agent loop instead of requiring a developer to open the Tool Window.
- **`draft_plan`** — takes a feature request plus Copilot's own
  structured summary/files/steps (Copilot does the reasoning; this tool
  just records it) and saves it as the next plan revision — the exact
  same [FeaturePlan] the Tool Window's "Current plan" reads, via the
  exact same invented-path-dropped rule `importPlan` already applies to
  a pasted reply. It **never writes a source file and never sets a plan
  approved** — those stay a human action in the Tool Window. A plan
  drafted over MCP shows up there immediately, ready to Approve.

Both read and write the exact same on-disk state
(`.idea/creditOptimizer/`) the plugin's Tool Window does — this process
never builds the index itself, so there's exactly one indexing path,
not two that could disagree.

**Requires the org's "MCP servers in Copilot" admin policy to be on** —
disabled by default; blocks any MCP server for anyone in the org until
an admin enables it. Setup once that's done:

1. Download the `credit-optimizer-mcp-server` artifact from a green CI
   run (same place the plugin's own zip comes from — no local Gradle
   build needed, and CI already builds it on every push). Unzip it
   anywhere; the launcher scripts are `mcp-server/bin/mcp-server.bat`
   (Windows) and `mcp-server/bin/mcp-server` (Unix). Building it
   yourself (`gradle :mcp-server:distZip`) still works, but the wrapper
   has to reach `services.gradle.org` to download Gradle itself the
   first time — the CI artifact skips that entirely.
2. In IntelliJ: **Tools > GitHub Copilot > Model Context Protocol (MCP)
   > Configure**, and add (Windows path shown; use `mcp-server` with no
   extension on macOS/Linux):
   ```json
   { "servers": { "credit-optimizer": {
       "command": "C:\\absolute\\path\\to\\mcp-server\\bin\\mcp-server.bat",
       "args": ["C:\\absolute\\path\\to\\your\\project"]
   } } }
   ```
   (the project path is the same one the plugin already indexes into
   `.idea/creditOptimizer/` — reindex there first, via the Tool Window,
   or the MCP tool has nothing to read).
3. In Copilot Chat, type `/mcp.credit-optimizer.ask_index` or
   `/mcp.credit-optimizer.draft_plan`, or just talk naturally — agent
   mode can call either tool on its own once approved (there's a
   per-server/per-tool auto-approve setting if you don't want to confirm
   every call).

**Approve and Implement are still not exposed over MCP, on purpose** —
see the Tool Window section above for the governance reasoning. After
`draft_plan` records a draft, open the Tool Window to Approve it and
Copy Implement Prompt.

## Not yet built

- **PSI-based exact resolution for the currently-open file**, layered on
  top of the JavaParser baseline every service gets (see ADR-001).
- **Gutter icons / line markers** for passive discovery (hover a Feign
  call, see its resolved route) — deferred rather than shipped as
  speculative, unverifiable `LineMarkerProvider` code in a first slice.
- **A cross-repo call graph.** Deliberately not built — see "Cross-repo
  linking" above for why that isn't a meaningful concept for
  independently-deployed services beyond HTTP and messaging, both of
  which are now real.
- **A complete Maven/Gradle model.** `DependencyParser.parseRepo` now
  pools `<dependencyManagement>`/`<properties>` across the repo's own
  POMs and resolves Gradle version-catalog accessors — but there's still
  no real `<parent>`/`relativePath` chain resolution, no BOM
  (`platform(...)`) import, and no reach outside this one repo.
- **Dockerfiles, K8s manifests, certificates/keystores.**
  `IntegrationDetector` reads `application.yml`/`.properties` now, but
  nothing here reads deployment/infra config or credentials — a
  `@Value("${...}")` placeholder is recorded as text, never resolved.
- **Running inside a real IDE at all.** Every claim above about the
  `:plugin` module is "written correctly against the API," not "seen to
  work" — the same honest distinction the `intellij-main` branch's own
  plugin draws between a green CI build and a real install.
- **Plan/Implement over MCP.** `:mcp-server` exposes read-only Q&A only.
  Adding tools that stage or write a plan raises a real governance
  question (should the model be able to call the tool that approves its
  own plan) that this pass deliberately left for the clipboard flow to
  keep answering, not solved by exposing it and hoping for the best.
- **A full MCP protocol round-trip, verified end to end.** Both
  `:mcp-server` tools are confirmed to compile against the real SDK API
  (verified via `javap` on the resolved jars), and the process starts,
  stays running, and never crashes when fed real requests in this
  sandbox - including a full `draft_plan` call. What isn't confirmed by
  hand: a successful JSON-RPC response actually observed over stdout
  (output buffering made that awkward to check without a real MCP
  client), so `draft_plan`'s write side-effect (a plan file appearing
  under `.idea/creditOptimizer/plans/`) wasn't observed from a live call
  either, only from `:core`'s own unit tests of the same
  `recordPlan`/`PlanStorage` code the tool calls into. The real proof for
  both tools is wiring it into a live IntelliJ + Copilot Chat session.
- **Implement over MCP.** Deliberately not built - see "MCP server"
  above for the governance line this project draws around it.

## Measuring it for real

The design discussion's "50–80%" token-savings estimate was explicitly a
model, not a measurement — and said the one thing that would turn it into
a real number was your team's actual mix of lookup-vs-generation
questions. `UsageLog.localAnswerShare()` is that measurement: once this
is running for real, `IndexBridge.status().localAnswerShare` in the Tool
Window shows the real, current percentage of questions answered for free,
computed from your own usage — not estimated.

## Building

```bash
cd credit-optimizer-plugin
gradle :core:test          # runs today, anywhere
gradle :mcp-server:distZip # runs today, anywhere - but CI already builds and uploads this, see below
gradle :plugin:buildPlugin # needs JetBrains' distribution hosts — CI only from here
```

Both `:mcp-server` and `:plugin` are built and uploaded as downloadable
CI artifacts on every push to this branch — `credit-optimizer-mcp-server`
and `credit-optimizer-plugin` respectively. Building either locally is
only for development; end users should download the CI artifact instead
of running Gradle themselves (Gradle's wrapper needs to reach
`services.gradle.org` the first time it runs, which fails behind some
corporate proxies even when a browser works fine).
