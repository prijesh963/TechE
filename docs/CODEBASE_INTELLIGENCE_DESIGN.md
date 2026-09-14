# Codebase Intelligence Design

Design for the symbol/dependency graph, hybrid retrieval, query/intent
classification, graph-based citations, git-history signals, and the
token/context measurement harness.

Source: architecture feedback review (2026-09-14) of an external product
discussion on Copilot Architect's original premise — "index the codebase,
reduce Copilot token usage, reason about the code." That discussion's core
recommendation: don't build "index everything, stuff it in every prompt";
build a **Codebase Intelligence Layer** (architecture map, symbol index,
dependency graph, module relationships, git history, existing patterns)
feeding a **Context Retriever** that returns only the relevant slice, stay
LLM-agnostic, and measure the actual token-reduction claim rather than
assume it.

## Problem Statement

Copilot Architect already produces a repo map, detected languages/
frameworks, and a keyword-scored (BM25 + RRF) file index
(`packages/indexer`), and `AdvancedAnalysisService` detects
architecture patterns, API routes, test relationships, and risk scores.
But every one of those signals operates at the **file** level. There is no
representation of what is inside a file — no classes, functions, imports,
call edges, or inheritance — so the tool can say "this file scored high on
keyword overlap" but never "this file is relevant because it's called by
the thing you're changing" or "here's the existing pattern to follow."
That reasoning-with-citation capability is the feedback's stated
differentiator, and it does not exist yet.

## Recommendations and Current-State Gap

| #   | Recommendation                                                   | Current state                                                                                                                                                 |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Symbol/dependency graph package                                  | Missing. `AdvancedAnalysisService` only detects _manifest_-level dependencies (package.json, pom.xml), not an import/call graph between classes or functions. |
| 2   | Hybrid retrieval (keyword + symbol + semantic + graph traversal) | Partial. `packages/indexer` is BM25 + reciprocal-rank-fusion lexical search over a JSON file only.                                                            |
| 3   | Query/intent classification ahead of retrieval                   | Partial. `find_similar_feature`/`analyze_impact` score by keyword match; no intent (debug vs. build) or entity extraction.                                    |
| 4   | "Why relevant" citations using the graph                         | Missing. `PlanFileReference.reason` is currently `"Matched X, Y in local index search"`.                                                                      |
| 5   | Token/context measurement harness                                | Missing entirely.                                                                                                                                             |
| 6   | Git-history-derived signals (recency/hotspots)                   | Missing. Git usage today is diff-only (review, handoff checkpoint).                                                                                           |

Already aligned with the feedback (no change needed):

- **LLM-agnostic.** MCP server + CLI already target Copilot, Codex, and
  Claude Code equally — nothing is hard-coded to one provider.
- **Positioned as a layer, not "another indexer."** Planning, validation,
  and review sit in front of whichever coding agent is in use.
- **Only relevant context, not everything.** `relevantFiles` /
  `likelyFilesToModify` are already capped (top 8), not a full-repo dump.

## Dependency Graph Between Items

```text
        ┌─────────────────────────┐
        │ 1. Symbol/dependency    │  (foundational — nothing else can
        │    graph (packages/     │   safely start without it)
        │    graph)               │
        └───────────┬─────────────┘
                     │
       ┌─────────────┼─────────────────┐
       ▼             ▼                 │
┌─────────────┐ ┌───────────────┐      │
│ 6. Git-      │ │ 2. Hybrid     │◄─────┘
│    history   │─│    retrieval  │
│    signals   │ │  (packages/   │
│ (independent,│ │   indexer)    │
│  feeds #2)   │ └───────┬───────┘
└──────────────┘         │
                          ▼
                  ┌───────────────┐
                  │ 3. Query/     │
                  │    intent     │
                  │    classifier │
                  └───────┬───────┘
                          │
                          ▼
                  ┌───────────────┐
                  │ 4. "Why       │
                  │    relevant"  │
                  │    citations  │
                  │  (packages/   │
                  │   planner)    │
                  └───────┬───────┘
                          │
                          ▼
                  ┌───────────────┐
                  │ 5. Measurement│
                  │    harness    │
                  │  (run against │
                  │   baseline    │
                  │   snapshot)   │
                  └───────────────┘
```

**Hard dependency:** #1 blocks #2 and #4 outright — graph-traversal
ranking and "here's why" citations are literally reads off the graph.

**Soft dependencies:** #3 and #6 have no hard dependency and could be
built standalone, but their value is realized once #1/#2 exist to plug
into (#3's entity resolution, #6's recency signal as a ranking input).
Building them first would mean reworking them once #2 lands with
somewhere for their output to go.

**#5 is two-phase.** The harness code has no dependency, but a
measurement is only meaningful against something. A baseline snapshot is
captured **before** item #1 lands (see below); the harness itself is built
last and re-runs the same methodology against the finished system.

## Build Order

1. **#1 — Symbol/dependency graph** (`packages/graph`)
2. **#6 — Git-history signals** (independent; ready to feed #2 the
   moment it exists)
3. **#2 — Hybrid retrieval**, consuming #1's graph and #6's recency
   signal together
4. **#3 — Query/intent classification**, resolving entities against the
   real graph from #1
5. **#4 — "Why relevant" citations**, explaining an already hybrid-ranked,
   intent-aware candidate list
6. **#5 — Measurement harness**, run against the baseline snapshot

## Baseline Snapshot (before #1)

`scripts/context-baseline.mjs` captures a "before" data point ahead of any
of this work: for each sample repo under `samples/`, it runs
`FeaturePlanningService.createPlanPreview()` with a canonical request (no
artifacts written to the sample repos) and compares the byte size of the
files it flags as relevant against the byte size of the whole repo's
source files, converting to a rough token estimate
(chars ÷ 4 — directional only, not a real tokenizer or a Copilot billing
measurement).

Output: `docs/benchmarks/baseline-context-snapshot.json`. Re-run the same
script after items #1–#4 land to get the "after" numbers for the same
sample repos and the same request — that comparison is what the
measurement harness (#5) formalizes.

## 1. Symbol/Dependency Graph (`packages/graph`) — Implemented

### Scope for this phase

Real, structural extraction — not regex heuristics — for the languages
`packages/adapters` already treats as first-class: TypeScript/JavaScript
first (most sample repos, and Copilot Architect's own codebase), with a
generic fallback for other languages that degrades gracefully rather than
failing. Depth over breadth: get the TS/JS path right (imports, classes,
functions, call edges within a file's import graph, inheritance) before
widening to Python/Java.

### New package: `packages/graph`

Follows the existing single-service-package convention (`packages/
indexer`, `packages/reviewer`): one `SymbolGraphService` class with a
`build()` method.

```ts
export interface SymbolGraphOptions {
  startPath?: string;
  strictRoot?: boolean;
}

export interface SymbolGraphResult {
  repoRoot: string;
  graph: SymbolGraph;
  jsonPath: string;
}

export interface SymbolGraph extends GeneratedArtifact {
  repoRoot: string;
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

export interface SymbolNode {
  id: string; // stable: `${filePath}#${symbolName}` or filePath for file-level nodes
  kind: "file" | "class" | "function" | "interface" | "method";
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exported: boolean;
}

export interface SymbolEdge {
  kind: "imports" | "calls" | "extends" | "implements";
  from: string; // SymbolNode id
  to: string; // SymbolNode id
}
```

### Behavior

1. Reuse `RepoDiscoveryService`'s file enumeration (do not re-walk the
   filesystem independently — one source of truth for "what files are in
   this repo").
2. For each TS/JS file: parse imports (resolve relative imports to
   in-repo file nodes; leave package imports as unresolved external
   references, not nodes), top-level class/function/interface
   declarations, `extends`/`implements` clauses.
3. Emit file-level nodes always (cheap, universal); emit symbol-level
   nodes only where extraction succeeds. A parse failure on one file must
   not fail the whole build — degrade to a file-level node with a
   diagnostic, matching the existing `DiagnosticMessage` pattern used
   elsewhere in `packages/shared`.
4. Write `.copilot-architect/graph.json`
   (new `ArtifactFileKey` in `packages/shared/src/constants.ts`), and
   surface it as a new MCP tool `get_symbol_graph` (read-only) once the
   service lands, mirroring `repo_map`.

### Parsing approach

TypeScript's own compiler API (`typescript`, already a repo dependency)
is enough for the TS/JS scope above — no new dependency required for
phase 1. Tree-sitter (as the feedback suggests) is worth revisiting only
if/when this expands to Python/Java/Go with the same fidelity; introducing
it now for a TS/JS-only phase would be scope creep against "depth over
breadth."

### Compatibility

- Purely additive: a new artifact file, a new package, one new MCP tool.
  Nothing existing changes shape.
- `CURRENT_SCHEMA_VERSION` bump not required — no existing artifact
  gains or loses fields.

### Implementation Notes

- Shipped as designed: `SymbolGraphService.build()` in `packages/graph`,
  writing `.copilot-architect/graph.json`; `get_symbol_graph` MCP tool
  (read-only, mirroring `repo_map`); `graph` CLI command. File enumeration
  reuses `scanRepository`/`findRepoRoot` from `packages/shared` directly
  (the same primitives `RepoDiscoveryService` itself builds on) rather than
  depending on the heavier `RepoDiscoveryService`/`adapters` — keeps
  `packages/graph`'s own dependency footprint to just `shared` +
  `typescript`.
- Parser: the TypeScript compiler API (`ts.createSourceFile`, no full
  `Program`/type-checker), not Tree-sitter — sufficient for the TS/JS-only
  scope and avoids a new dependency, per the "depth over breadth, revisit
  Tree-sitter only when expanding language coverage" call above.
- Edge resolution is precision-first by design: `extends`/`implements`
  and `calls` are only recorded when the callee/heritage identifier
  resolves unambiguously to a same-file symbol or an imported binding
  (with the import specifier resolved to an in-repo file); anything
  ambiguous or pointing at a global/external symbol is dropped rather than
  guessed. `service.method()`-style calls resolve to the specific method
  node when the receiver identifier is known to be that class; `this.x()`
  and deeper property chains are intentionally not attempted without a
  type checker.
- Verified end to end against this repo's own `packages/planner` (110
  nodes, 98 edges, 0 diagnostics) and against `samples/node-api`, in
  addition to the unit/integration suite in `tests/graph.test.ts` and
  `tests/mcp-server.test.ts`.

## 6. Git-History Signals (`AdvancedAnalysisService`) — Implemented

### Scope for this phase

Independent of #1, per the dependency graph above — no code dependency on
the symbol graph. Built now so it's ready to feed #2 (hybrid retrieval's
recency-as-a-ranking-signal) and #3 (intent classification's "recent
changes" field) the moment they land, rather than being bolted on
afterward.

Two signals, both derived from one `git log` walk over a bounded lookback
window, matching the "lightweight addition" framing — not a full git
mining subsystem:

- **Recency**: when a file was last touched.
- **Frequency ("hotspot")**: how many commits in the window touched it —
  a proxy for coupling/importance that a one-shot repo scan cannot see.

### Schema changes

Added to `packages/shared/src/models.ts`:

```ts
export interface FileChangeActivity {
  filePath: string;
  /** Commits touching this file within the lookback window. */
  commitCount: number;
  /** ISO timestamp of the most recent commit touching it. */
  lastChangedAt: string;
  lastChangedDaysAgo: number;
}
```

Added to `AdvancedAnalysis` as `gitActivity: FileChangeActivity[]` —
additive, so `CURRENT_SCHEMA_VERSION` does not need a bump, matching #1.

### Behavior

`AdvancedAnalysisService.analyze()` gains one more `detect*`-style step,
`collectGitActivity(repoRoot)`:

1. One `git log -n <maxCommits> --pretty=format:%x00%aI --name-only` call
   (default `maxCommits = 500`) — a single walk, not one `git log` per
   file, so cost stays bounded regardless of repo size.
2. Parse into `{ filePath -> { commitCount, lastChangedAt } }`; git's
   porcelain output already uses `/`-separated paths on every OS, so no
   extra normalization is needed. Merge commits are excluded by
   `--name-only`'s default behavior (no incidental double-counting).
3. Sort by `commitCount` desc, then recency, and cap to the top 50 —
   consistent with every other "top N" cap already used in this codebase
   (`relevantFiles`, `likelyFilesToModify`, etc.) rather than returning
   the whole repo's history.
4. Never fails the analysis: no `.git` directory, git not installed, or
   an empty/shallow history all degrade to `gitActivity: []` via the same
   try/catch-and-return-undefined pattern `ReviewService`'s own git calls
   already use.

### Feeding into risk scoring

Rather than inventing a new `AdvancedRiskScore` category (which would
ripple into every consumer that pattern-matches on the category union),
`gitActivity` strengthens the existing `missing-test` category's reasons
and score: a source file with no adjacent test **and** a high commit
count in the window is a stronger signal than either fact alone — a
file that changes often without test coverage compounds risk. The
category, its score range, and its shape are unchanged; only the
`reasons` text and score gain a recency-aware case.

### Compatibility

- Purely additive: one new field, one new interface. No existing shape
  changes.
- Every existing test fixture builds repos without `git init` (see
  `tests/advanced-analysis.test.ts`), so `gitActivity: []` is the
  observed behavior there — confirms the degrade-gracefully path is
  exercised by the existing suite, not just a new one.

### Implementation Notes

- `collectGitActivity` reuses the same `execFile`/`promisify` pattern
  already present in `advanced-analysis-service.ts` — no new dependency.
- Verified against this repo's own git history (multi-hundred commits)
  in addition to fixture-repo tests with a handful of commits.

## 2. Hybrid Retrieval (`packages/indexer`) — Implemented

### Scope for this phase

`packages/indexer` already had two fused signals — BM25 lexical scoring
and a path/symbol "structural" score, combined via Reciprocal Rank Fusion
(RRF) — well before this design doc existed. What it did not have is
exactly the two signals #1 and #6 unlocked: a **graph** signal (files
connected to a top match via the symbol/dependency graph, even with zero
shared vocabulary) and a **recency** signal (frequently/recently changed
files rank slightly higher). This phase adds both into the existing RRF
fusion rather than replacing it.

### Design decisions

- **Graph: read-only, never builds one.** `search()` tries to read
  `.copilot-architect/graph.json` (via the same `getArtifactFilePath`
  helper `get_symbol_graph` writes through) and silently skips the graph
  signal if it doesn't exist. Building a graph is a full AST parse of the
  repo — running that inline on every `search_repo` call (which agents
  call often, and `findSimilarFeatures`/planning call internally) would
  make search noticeably slower. The signal is a free bonus once someone
  has run `graph` / `get_symbol_graph` — degrades to exactly the
  pre-existing 2-signal behavior otherwise.
- **Recency: precomputed at index build time, not per search.** Unlike
  the graph traversal (which is inherently query-dependent — "boost
  neighbors of _this query's_ top matches" cannot be precomputed),
  recency is the same for a given moment regardless of what's being
  searched for. `collectGitActivity` runs once per `index()` call and is
  cached on `LocalIndex.gitActivity`, mirroring how `searchStats` is
  already precomputed once per index build and reused across searches —
  not re-shelling out to git on every query.
- **Graph traversal, not static centrality.** The signal seeds from the
  top files the lexical/structural signals already found (top 8 from
  each, deduped), then walks the symbol graph's edges outward: 1-hop
  neighbors score higher than 2-hop, and seed files themselves are
  excluded from the graph list (they already rank highly on lexical/
  structural — the graph signal's value is surfacing files that don't).
  Symbol-level edges collapse to file-level, undirected — for "is this
  file related," direction doesn't matter.
- **`SearchResult.signals` exposes which signal(s) fired.** A generalized
  `fuseSignals` helper replaces the old two-list-only RRF loop with one
  that runs over any number of named ranked lists and records, per
  result, which signals contributed a non-zero rank. This is diagnostic
  value now and becomes the direct input to item #4 ("why relevant"
  citations) later — no rework needed when #4 lands.

### Schema changes

`LocalIndex` gains `gitActivity?: FileChangeActivity[]` (optional, same
backward-compatibility pattern as `searchStats`). `SearchResult` gains
`signals: SearchSignal[]` where
`SearchSignal = "lexical" | "structural" | "graph" | "recency"`.

### Compatibility

- Additive only: existing 2-signal fusion behavior is reproduced exactly
  when no graph exists and the repo has no git history — confirmed by the
  full existing test suite passing unchanged.
- `packages/indexer` gains a new dependency on `@copilot-architect/graph`
  (type-only import of `SymbolGraph`) alongside its existing dependency
  on `@copilot-architect/core` (already used for `WorkspaceService`; now
  also for the exported `collectGitActivity`).

### Implementation Notes

- Verified end to end with a 3-file fixture (`payment-service.ts` calling
  an imported `RetryUtility.run`, plus an unrelated file): searching
  "process payment" surfaced `retry-utility.ts` with `matchedFields: []`
  (zero keyword overlap) and `signals: ["graph", "recency"]` — the exact
  differentiator this whole design doc set out to build. The unrelated
  file, sharing no vocabulary and no graph edge with the query, correctly
  never entered the results at all.
- New coverage in `tests/indexer.test.ts`: graph signal surfacing a
  zero-keyword-overlap file, no graph signal when no graph exists,
  recency signal from precomputed `gitActivity`, and ordinary lexical/
  structural signals still reported for a plain keyword match.
