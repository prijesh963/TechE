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

## Two modules, on purpose

- **`:core`** — repo discovery, the lightweight Java parser, local JSON
  storage, the free-path router, the usage log. Plain Kotlin/JVM, **no
  IntelliJ Platform dependency at all.** Fully built and tested in any
  environment, including the sandbox this was developed in.
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

`:core` — 20 tests, all passing (`gradle :core:test`):

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
  - Incremental: a file whose content hash is unchanged from the last run
    keeps its previously-extracted facts rather than being re-parsed —
    there's a test that proves reuse, not just unchanged output, by
    planting a marker into the "previous" facts and checking it survives.
  - A file that fails to parse (invalid syntax, an unsupported
    construct) is skipped, not fatal to the rest of the service.
- **`IndexStorage`** — one JSON file per service, round-tripped losslessly;
  a service that was never indexed loads as nothing, not an error.
- **`FreePathRouter`** — answers three question shapes directly from the
  index (a route's contract, who consumes/produces a channel, which bean
  implements an interface) and returns `NeedsGeneration` for everything
  else, on purpose — this router does no fuzzy/LLM-like guessing; a wrong
  "free" answer would be worse than admitting a question needs Copilot.
- **`UsageLog`** — an append-only JSONL log tagging every question INDEX
  or COPILOT, and `localAnswerShare()` — the actual, measured version of
  the earlier discussion's percentage estimate (see "Measuring it for
  real," below).
- **`IndexService`** — ties discovery, parsing and storage together;
  re-indexing one service doesn't touch another's stored index.

`:plugin` — written, not yet run in a real IDE:

- `plugin.xml`, a Tool Window (status, Reindex button, an ask box wired
  to `IndexBridge.ask()`, and a history view), and a Ctrl+Alt+K quick-ask
  popup — both call the same `IndexBridge`, so there is exactly one path
  from a question to an answer, not two that could disagree.
- `PluginSettings` — per-project, persisted sibling-repo paths. No
  settings *UI* yet (edited by hand in `.idea/creditOptimizer.xml` for
  now) — a fast-follow `Configurable` page binds to the same state shape.

## Not yet built

- **How a "needs Copilot" bundle actually reaches Copilot Chat.** This
  was flagged as the one open integration question in the design
  discussion and still is — nothing here fakes an answer to it.
- **PSI-based exact resolution for the currently-open file**, layered on
  top of the JavaParser baseline every service gets (see ADR-001).
- **Gutter icons / line markers** for passive discovery (hover a Feign
  call, see its resolved route) — deferred rather than shipped as
  speculative, unverifiable `LineMarkerProvider` code in a first slice.
- **A real Settings UI**, instead of hand-editing the XML.
- **Running inside a real IDE at all.** Every claim above about the
  `:plugin` module is "written correctly against the API," not "seen to
  work" — the same honest distinction the `intellij-main` branch's own
  plugin draws between a green CI build and a real install.

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
gradle :core:test              # runs today, anywhere
gradle :plugin:buildPlugin     # needs JetBrains' distribution hosts — CI only from here
```
