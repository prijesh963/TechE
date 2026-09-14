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

## 1. Symbol/Dependency Graph (`packages/graph`)

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
