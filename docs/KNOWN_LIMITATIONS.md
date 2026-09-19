# Known Limitations

Everything deliberately left undone or knowingly imperfect during the redesign,
recorded so it can be assessed as a whole once the phases land rather than
rediscovered one at a time.

Each entry says what is wrong, what it costs, and — where it matters — why it
was left. Items resolved by a later phase are listed in
[Closed](#closed-by-a-later-phase) rather than deleted, so the record stays
honest about what was traded and when.

**Status:** Phases 0–4b merged. Phases 5–8 outstanding.

---

## 1. Incomplete user-facing flow

These are the gaps a developer would actually notice.

### 1.1 The dashboard is a button panel, not a session view

**Phase 4a/4b.** `DASHBOARD_PRIMARY_ACTIONS` still renders Setup Repo, MCP
start/stop and agent install as links. The design calls for it to show the
current work: feature, phase, decisions, plan version and which version is
implemented, with an idle state showing readiness and insights.

**Cost:** the session's state is invisible unless you scroll the chat. Phases
1–4b now produce real state with nowhere to display it.

### 1.2 Nothing proposes decisions for the developer to confirm

**Phase 1/4a.** `recordDecision` exists, is tested, and renders in a plan draft
— but **no code path calls it**. Confirmed with a search: the only reference
outside the service is its own test.

**Cost:** the Decisions block always renders empty, so the mechanism the whole
session model rests on is inert. The model-proposes / developer-confirms flow
is the missing half.

### 1.3 `/create-plan` picks files by search relevance alone

**Phase 4a.** Every change is marked `update`; nothing reasons about additions
or deletions, and nothing asks the model which files genuinely need changing.

**Cost:** plans name plausible files rather than correct ones. This is the
planning intelligence, and it needs the model in the loop.

### 1.4 `/implement` regenerates whole files, with no dry run

**Phase 4b.** The model is asked for complete replacement contents from the
before-snapshot. There is no preview before writing.

**Cost:** wasteful and risky on a large file — a patch-based approach would be
safer, but needs the model to emit reliable diffs. Approval already gates the
write, so a preview is a safety improvement rather than a missing gate.

### 1.5 The CLI shell-outs are unreplaced

**Phase 3, deferred to Phase 7.** The extension still runs 13 CLI commands as
subprocesses. Not a Core Rule violation — the CLI is core — and the calls
stream progress into the output channel, which direct imports would have to
reproduce. VSIX bundling is what forces the change, since a packaged extension
cannot shell out to a path that does not exist on the user's machine.

---

## 2. Capability removed, pending a proper home

### 2.1 LM query expansion and HyDE

**Phase 3.** `expandQuery` and `generateHypotheticalSnippet` were deleted
rather than kept in the wrong layer. Query expansion is retrieval strategy, so
it belongs in core with the language model injected, not in a shell that
happens to have one.

**Cost:** a question whose wording does not match the codebase's vocabulary has
one fewer chance of landing. Mitigating factors: the graph signal, cross-repo
edges and the digit-boundary tokenizer fix have all strengthened retrieval
since expansion was added.

**Shape of the fix:** `search({ query, expand?: (q) => Promise<string[]> })`,
with core deciding how to fuse the variants — it already has the RRF machinery.

### 2.2 Embedding reranking

**Phase 3.** Removed with `cosineSimilarity` and its facade member. It was
guarded behind an optional `computeEmbeddings` that the facade itself declared
as possibly absent, and no test ever covered it.

**Cost:** probably none in practice — but this is an honest "probably". Whether
it ever ran in a stable VS Code was never established.

---

## 3. Layering compromises

### 3.1 The replacement-code prompt lives in the extension

**Phase 4b.** `/implement` builds the prompt asking the model for new file
contents inside the shell. Same tension as 2.1, resolved the opposite way for
expedience.

### 3.2 `buildRepoContext` reads `repo-map.json` directly

**Phase 3.** Artifact access rather than business logic, so defensible — but
going through a service would be tidier and would pick up multi-repo handling
for free.

### 3.3 `readFilesForLmContext` has its own snippet extraction

**Phase 4a.** Phase 2's `extractExcerpt` does the same job with line-precise
anchors. Two ways to take a window of a file is how the two-tokenizer problem
started.

---

## 4. Correctness edges

### 4.1 `verifyPlanFreshness` takes a single `repoRoot`

**Phase 2.** A plan whose changes span repos cannot be verified in one call.
`repoName` is carried on each change but not used for resolution.

**Cost:** multi-repo plans — exactly what the cross-repo work enables — cannot
be freshness-checked correctly. This is the most likely of these to bite.

### 4.2 `forbidPaths` matches exact paths and directory prefixes only

**Phase 1.** No glob support, deliberately: a constraint whose behaviour a
developer cannot predict is not one they can rely on.

**Cost:** `**/*Controller.java` cannot be expressed. Worth revisiting once real
constraints exist to learn from.

### 4.3 `extractExcerpt` takes one anchor per file

**Phase 2.** A change touching two distant parts of the same file gets one
window, not two.

### 4.4 Excerpt context is a fixed 30 lines

**Phase 2.** Fine for a method, likely too narrow for a large class and
wasteful for a one-line config change. Adaptive sizing needs real plans to tune
against.

### 4.5 Search result caps are untuned

**Phase 3.** 25 results and 8 anchors, carried over unchanged from the deleted
code. Now at least in one place, where tuning helps every surface at once.

### 4.6 Model-facing caps have no caller override

**Phase 0.** 12 symbols and 400 preview characters are fixed. A `detail`
parameter is easy to add when a phase needs it.

### 4.7 `analyze_query_intent` is unshaped

**Phase 0.** Confirmed: it does not go through `shapeSearchForModel`, because
it returns its own result type rather than a `SearchResponse`.

**Cost:** one MCP tool still returns an untrimmed payload.

### 4.8 `.git/HEAD` does not move on commit

**Phase 0.** It changes on a branch switch, not when a commit lands on the
branch you are already on. File timestamps cover that case and the two signals
are complementary — documented in the code, recorded here so it is not
rediscovered as a bug.

---

## 5. Scale and housekeeping

### 5.1 Parked sessions accumulate

**Phase 1.** No expiry, no cleanup. Fine for same-day work, which is the stated
v1 assumption; it will want attention if sessions start spanning weeks.

### 5.2 `SessionService.list()` reads every session file

**Phase 1.** Irrelevant at v1 volumes. An index file would be needed if the
count grows.

### 5.3 A workspace that later adds git parks its session once

**Phase 1.** The recorded `gitHead` changes from absent to present, which reads
as a branch change. Correct behaviour, mildly surprising.

### 5.4 The workspace-graph skip keys on the repo set

**Pre-phase.** A cross-repo dependency added between repos you already have is
not noticed until `graph-workspace.json` is deleted. The skip message says so.
Any signal strong enough to catch it requires the parse the skip exists to
avoid.

### 5.5 A workspace-level graph does not feed search ranking

**Pre-phase.** Fan-out search reads each sub-repo's own `graph.json`, and the
prefixed workspace paths do not line up with per-repo indexes. Pre-existing,
not a regression. The additive cross-repo expansion pass covers the common
case.

### 5.6 The extension test suite is slower

**Phase 3.** It now does real indexing rather than reading fixture JSON. Worth
it for realism; noted so the cause is known.

---

## 6. Documentation debt

### 6.1 `docs/SOLUTION_OVERVIEW.md` describes a design now partly built

Its measured figures predate Phase 0's payload trimming and therefore
understate the saving. Phase 8 should refresh it against reality.

### 6.2 `AGENTS.md` is the spec and is behind

Tool, command and test counts have drifted, the "Do Not Build: Visual Studio
VSIX" line is ambiguous now that a VS Code `.vsix` is planned, and the Core
Rule it states was violated until Phase 3. Phase 8 owns this.

### 6.3 Two plan formats coexist

`FeaturePlanningService` still produces the pre-redesign shape alongside the
new `PlanContract`. Deliberate during migration; Phase 8 cleans it up.

---

## Closed by a later phase

Kept so the record shows what was traded and when.

| Limitation                                             | Raised    | Closed                                         |
| ------------------------------------------------------ | --------- | ---------------------------------------------- |
| `resetIndexFreshnessCache` exported but unwired        | pre-phase | Phase 0 — `.git/HEAD` checked before the cache |
| Plan body opaque in the session                        | Phase 1   | Phase 2 — `PlanContract`                       |
| Nothing builds a plan contract end to end              | Phase 2   | Phase 4a                                       |
| `checkConstraints` never called against `plannedPaths` | Phase 2   | Phase 4b                                       |
| `runAgenticPlanLoop` — a third retrieval mechanism     | Phase 3   | Phase 4a                                       |
| No checkpoint captured                                 | Phase 4a  | Phase 4b                                       |
| Two tokenizers that had to be fixed twice              | pre-phase | Phase 3 — one exported tokenizer               |
