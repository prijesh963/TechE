# Known Limitations

Everything deliberately left undone or knowingly imperfect during the redesign,
recorded so it can be assessed as a whole once the phases land rather than
rediscovered one at a time.

Each entry says what is wrong, what it costs, and — where it matters — why it
was left. Items resolved by a later phase are listed in
[Closed](#closed-by-a-later-phase) rather than deleted, so the record stays
honest about what was traded and when.

**Status:** Phases 0–32 merged. The redesign is complete; what is below is
the backlog it leaves behind.

---

## 1. Incomplete user-facing flow

These are the gaps a developer would actually notice.

### 1.1 Decisions are proposed only at `/create-plan`

**Phase 9.** `/analyze` surfaces plenty worth deciding and proposes nothing;
`/review` findings that change an approach are not offered as decisions
either.

**Cost:** a developer who settles something during analysis has to wait until
planning for it to be recordable, or say it again.

### 1.2 A proposed decision cannot be amended in place

**Phase 9.** Confirm is a button; rejecting is not clicking; amending means
saying what is wrong so it lands in the next draft. There is no "edit this
wording and record it".

**Cost:** a proposal that is 90% right costs a redraft. An input box on
confirm would close it, at the price of a modal in the middle of a chat
turn.

### 1.3 A superseding proposal depends on the model spotting the conflict

**Phase 10.** Replacing a decision works, but only when the model notices its
proposal contradicts a recorded one and puts that id in the last field.
Nothing detects a contradiction independently, so two decisions that conflict
in substance but not in wording both stay active.

**Cost:** the failure is quieter than the one it replaced — a contradiction
survives rather than being offered for replacement. Detecting it properly
means comparing meaning, not text, which is a larger piece of work than the
id plumbing.

### 1.4 Only the cited symbol is checked, not the reason itself

**Phase 12.** A rationale verifies when the file declares the symbol it cites.
That proves the reason is _about that file_; it does not prove the reason is
_true_. "InvoiceService holds the invoice lifecycle" and "InvoiceService
handles retries" both verify against a file declaring `InvoiceService`.

**Cost:** the check catches a reason attached to the wrong file, which was the
common failure, and not a wrong reason attached to the right one. Checking the
latter means reading the file and judging the claim, which is a model call per
change.

### 1.5 A model that cites nothing is never flagged

**Phase 12.** Omitting the symbol yields `not-checked`, which shows no warning.
A model that learns to leave the field empty would silently disable the check
for every row.

**Cost:** nothing in the plan distinguishes "the model cited nothing" from "the
file has no indexed symbols", and neither is visible unless the developer looks
for absence. Requiring a citation would instead punish honest uncertainty,
which is the worse trade — but the asymmetry is real and unmeasured.

### 1.6 Only missing exports are checked, not extra ones

**Phase 14.** The index records every symbol a file declares, not just the
exported ones, so a name beyond the outline could equally be an internal
helper. Flagging those would put a warning on nearly every file, which is how
a warning stops being read.

**Cost:** a new file that quietly grows a second public surface is not
reported. Closing it means the index distinguishing exported symbols from
declared ones — a change in the indexer, not the planner.

### 1.7 A planned signature is never compared to the written one

**Phase 15.** An outline now says how each export is called, and the index
records the signature of what was actually written — but `checkOutlines`
compares names only.

**Cost:** a file can export everything it promised with entirely different
parameters and pass the check. Comparing them properly means tolerating
renamed parameters, inferred types and whitespace; an equality test would
report nearly every honest implementation as a broken contract, which is the
failure mode these checks exist to avoid.

### 1.8 A diff must be opened one file at a time

**Phase 17.** Each staged file gets its own button. A plan touching ten files
is ten clicks to inspect fully, and nothing marks which ones have been
looked at.

**Cost:** on a large plan the diffs most worth reading are the ones a
developer is least likely to reach. A multi-file diff view — VS Code has one
for source control — would show them together, and is a different piece of
work from serving one staged document.

### 1.9 Staged changes are lost on reload

**Phase 16.** Staging lives in memory, keyed by workspace. A window reload
loses it, and the apply button then says so and asks for `/implement` again.

**Cost:** regenerating costs a model call. Staging to disk would mean writing
before the write was agreed, and would leave stale content behind for every
run that was never applied — so this is a deliberate trade rather than an
oversight.

### 1.10 The model edits from an excerpt, not the whole file

**Phase 18.** An edit is applied to the file on disk, but the model is shown
only the plan's excerpt — a window around the anchor the index resolved. It
can only quote text it can see, so a change needed outside that window cannot
be proposed at all.

**Cost:** the edit either fails to be produced or comes back as an edit to
something irrelevant nearby. Search/replace responses are small, so a wider
excerpt is now affordable in a way it was not under whole-file rewriting —
this is a tuning decision that wants real usage behind it.

### 1.11 A refused edit costs a whole round trip

**Phase 18.** When an edit does not match, or matches twice, the file is left
untouched and the developer is told which edit failed. Nothing retries with
that information.

**Cost:** an ambiguous edit is exactly the case a model could fix if told —
"include more surrounding lines" is mechanical advice. One automatic retry
would close most of these, at the cost of a second model call whenever the
first was sloppy.

### 1.12 Validation runs, but nothing reads its result

**Phase 19.** The plan commits to checks, the button runs them safely, and the
outcome goes to the output channel and the dashboard. `/review` does not load
the validation report, so a failing test does not become a review finding
even though `ReviewService` accepts one.

**Cost:** the loop's last two steps do not meet. Passing `validation:` to the
review call would close it, and needs the run's path threaded through the
session.

### 1.13 Review reads a diff summary, not the diff

**Phase 19.** The model is given `ReviewService`'s diff summary — file names
and line counts — plus the automated findings, not the hunks. It is told to
say so, and does.

**Cost:** it cannot see a wrong change inside a file the plan expected, which
is the failure most worth catching. Sending real hunks means choosing which,
since a large diff is the context cost this design exists to avoid.

### 1.14 A path shared by several repos cannot be verified

**Phase 20.** Resolving a claimed path by its tail means
`src/main/resources/application.yml` matches every service that has one. It
is reported as ambiguous with the count, which is honest but still an
unverified claim against a real file.

**Cost:** answers about conventions shared across services — config layout,
a common package structure — collect warnings that are not findings. Closing
it means the model naming the repo, which is a prompt change with its own
failure mode.

### 1.15 A repo is recognised by its build file, not its contents

**Phase 20.** The workspace scan registers a directory when it carries a
known manifest — `pom.xml`, `package.json`, `go.mod` and a dozen others — or
a `.git` directory. A project built with something not on that list is
skipped.

**Cost:** it is named in the output channel rather than dropped silently, so
a developer can see why. But the list is a list, and the next unfamiliar
build system is a support question rather than a detection.

### 1.16 A refusal is indistinguishable from an answer

**Phase 21.** When the model declines — as it did on "identify the security
gaps", before the analyze role reached it — the refusal is streamed like any
other answer, followed by the usual receipts and next-step line. Nothing
notices that no question was answered.

**Cost:** "Sorry, I can't assist with that. Looked at 371 files across 12
repos." reads as though the tool worked and the repository had nothing to
say. Detecting a refusal reliably is hard; detecting an answer that cites
nothing at all is not, and would catch most of them.

### 1.17 A request naming nothing real is flagged, not refused

**Phase 23.** `/create-plan` checks the request's own premise and says when it
names a symbol that is not in the workspace — then plans anyway. It has to:
naming something that does not exist yet is how a new feature is asked for,
and refusing would block the tool's main use.

**Cost:** the developer is told, and can still approve a plan built on a
premise that does not hold. Telling apart "fix the thing that is there" from
"build a thing that is not" needs intent, which is a model call and its own
failure mode.

### 1.18 Symbol extraction is regex for everything but Go and Rust

**Phase 23, narrowed in Phase 32.** Go and Rust are parsed with a grammar.
Everything else still matches on convention: Java and C# methods on an access
modifier and a lowercase name, and a language whose pattern is not in the list
is invisible. Measured, Kotlin yields its class and not its functions; C, C++,
Swift and Ruby yield nothing.

**Cost:** every existence check is only as good as the extraction behind it,
and a symbol that is real but unextracted reads as a fabrication. Closing it
is now a row in a table rather than a new mechanism — the grammars exist on
npm — but each one costs package size, which is why only the two measured at
zero ship today.

### 1.19 Only two grammars ship, chosen by size

**Phase 32.** `tree-sitter-wasms` carries 36 grammars and weighs 50 MB. Go
(230 KB) and Rust (799 KB) ship because they measured zero symbols and are
cheap. C# (3.9 MB), Ruby (2 MB), Swift (3 MB) and C++ (4.5 MB) do not, and
Kotlin is 4 MB for a language the pattern list already half-covers.

**Cost:** a developer in a C# or Swift repository gets the old behaviour and
nothing says which languages are parsed and which are guessed. Downloading a
grammar on demand would decouple the two, at the price of a network call in a
tool that is otherwise entirely local.

### 1.19 A large plan is a long scroll

**Phase 25.** Every changed file's excerpt is shown inline. At the cap of
twelve files and thirty lines of context either side, a plan can run to
several hundred lines of chat.

**Cost:** the code most worth reading is the hardest to reach. Collapsing
them behind a button would fix the scroll and lose the point — an excerpt
nobody opens is an excerpt nobody read.

### 1.20 Apply speaks through a notification, not the chat

**Phase 26.** The chat turn that staged the changes is over by the time Apply
runs, so the result is an editor notification — written files, refused count,
and a "Run checks" action for the checks the plan committed to. The detail
still goes to the output channel.

**Cost:** a notification is dismissible and transient; a developer who clicks
away has no record in the conversation that the apply happened, and the chat
thread still ends at "Nothing has been written yet." Writing back into the
chat means holding the stream open past the turn, which the chat API does not
offer.

### 1.21 A refused edit is a count, not a name, in the notification

**Phase 26.** When some edits apply and others do not, the notification says
how many were refused; which ones, and why, are in the output channel behind
"Show details".

**Cost:** the most important case — a partly-applied plan — is the one where
the developer most needs the file names, and reads a number instead. A
notification has room for a sentence, not a list, so closing this means the
chat thread, which is 1.20.

### 1.22 A plan's steps are intent, and nothing checks them

**Phase 27.** The draft now says what the change does — an approach, and a
step per file. None of it is verified: a step is a sentence about code that
does not exist yet, so there is nothing to check it against the way a
rationale's cited symbol is checked against the index.

**Cost:** a plausible, wrong step reads exactly like a correct one, and it is
now what `/implement` is instructed with — so a bad step propagates into the
code rather than stopping at the draft. What can be checked is the symbols a
step names in a file the plan already quotes; that is a narrower check than it
sounds, and was left rather than half-built.

### 1.23 A file can be planned with no step against it

**Phase 27.** When the model returns an approach but says nothing about one of
the selected files, the draft says so under that file. The plan is not
redrafted and the file is not dropped.

**Cost:** approving that plan approves a file whose change was never
described, and `/implement` falls back to the rationale for it. Dropping the
file would silently narrow a plan the developer never saw; asking again costs
a round trip on every draft where the model was merely terse.

### 1.24 The approach is asked for in a separate model call

**Phase 27.** Selection, outlines, the approach and the decision proposals are
four calls. The approach is asked after the files are chosen, so it explains a
selection rather than driving one.

**Cost:** a draft costs another round trip, and the model cannot say "this
needs a file you did not give me" — it can only describe work in the files
already selected. Folding intent into the selection call would save the trip
and make the reply much harder to parse, which is how the selection format got
its own step in the first place.

### 1.25 A release is published per commit to `main`

**Phase 28.** The version is the commit count, so every push to `main` is a
distinct installable build and gets its own release. There is no notion of a
release worth cutting as against one that merely happened.

**Cost:** the releases page becomes a commit log with attachments, and
"latest" means most recent rather than most ready. Tagging deliberately would
fix it and put a manual step back in the path this phase exists to remove.

### 1.26 Packaging is only proven by packaging

**Phase 29.** The unit suite checks the packaging script's inputs — that a
repository is declared, that stale packages are cleared — but it does not run
`vsce`. Only CI does, at the end of a full build, and a packaging fault is
therefore found minutes after a push rather than seconds after an edit.

**Cost:** this is how the first release run failed. A relative link was added
to `docs/INSTALL.md`, which becomes the package README, and `vsce` refused it
because no repository was declared to resolve it against; the suite was green
throughout. Running `npm run package:vsix` in the suite would close it and
cost every test run an 11.5 MB bundle.

### 1.27 Nothing checks that the published package runs

**Phase 28.** The workflow runs format, lint, build and the suite before
packaging, then publishes whatever `vsce` produced. Nothing installs the
`.vsix` into a VS Code instance and activates it.

**Cost:** a bundling fault that the unit tests cannot see — a bad esbuild
shim, a missing contributed command — ships as a green release and is found by
whoever installs it. `@vscode/test-electron` would close it, and is a
different piece of work from packaging.

### 1.28 The CLI shell-outs are still subprocesses

**Phase 3, addressed differently in Phase 7.** The extension still runs its
command workflows as subprocesses. Phase 7 fixed the part that was broken —
they no longer shell out to `npm run cli --`, which does not exist on a
teammate's machine — by bundling the CLI into the package and spawning it by
absolute path. They were not converted to direct imports.

**Cost:** a process spawn per command, and the CLI's 11.5 MB bundle inside the
package. Not a Core Rule violation — the CLI is core — and the subprocess is
what streams progress into the output channel, which direct imports would have
to reproduce. Left as a subprocess deliberately.

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

### 4.9 Grounding checks paths and symbols, not statements

**Phase 6.** Only backticked paths, `file:line` citations and qualified symbols
are verified. A claim made in prose — "the service retries three times" — is
not checked at all, and a bare PascalCase word is deliberately ignored to avoid
flagging framework names.

**Cost:** the most consequential claims, about behaviour rather than existence,
are unverifiable by this mechanism. The precision trade is deliberate, and the
report says so.

### 4.10 Relation claims are not checked

**Phase 6, narrowed in Phase 7.** `useSymbolGraph` still defaults off, and the
`verifyRelation` implementation was deleted in Phase 7: importing the graph
package pulled the TypeScript compiler into the extension bundle, 9.5 MB for a
code path nothing called.

**Cost:** a claim that one symbol calls another is reported as not checked, and
restoring the check means routing it through the CLI rather than importing the
graph directly. The reason it defaulted off still stands — a graph is only as
current as its last build, and asserting a claim is wrong on stale data is the
mistake this module exists to prevent.

### 4.11 Grounding is wired into `/analyze` only

**Phase 6.** `/create-plan` and `/review` produce claims about the repo too and
do not verify them.

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

### 5.7 The CLI bundle is 11.5 MB of a 2 MB package

**Phase 7.** Almost all of it is the TypeScript compiler, which the symbol
graph uses to resolve references in TS and JS. It compresses to well under the
2 MB the VSIX weighs, so the download is not the problem; the disk footprint
per install is.

**Cost:** an installed extension takes ~12 MB on disk for a compiler that runs
during graph builds only. Marking `typescript` external would not help — it
would ship the same bytes as `node_modules`.

### 5.8 Fixtures still accumulate within a single run

**Phase 31.** The run's temp root is removed when the run ends, so nothing
survives it. During the run, every fixture any test makes is still there:
234 directories by the end, none reclaimed until teardown.

**Cost:** none on disk, which is why it was left. It does mean a very long
run holds everything it has ever made, so a suite that grew ten-fold would
feel it before the teardown arrived. Per-test cleanup would fix it and put
back the obligation to remember, which is what the run root exists to remove.

---

## 6. Documentation debt

### 6.3 Two plan formats coexist, in different surfaces

**Raised Phase 2, assessed Phase 8, narrowed Phase 19.** `FeaturePlan` is the
narrative plan the CLI produces and `handoff`, `measure` and four MCP tools
consume. `PlanContract` is the executable contract `/implement` applies. They
are different things and both are needed.

Phase 19 removed the part that actually hurt: the dashboard offered Generate
Plan, Validate and Review as buttons that wrote a `FeaturePlan`, so a
developer could produce two unrelated plans for one feature and `/review`
would only know about one. Those verbs now belong to `@architect` alone, and
`ReviewService` takes expected paths directly so it works from either format.

**Cost, still real:** a developer who uses the CLI `plan` command and
`@architect /create-plan` on the same feature still has two plans that do not
reference each other. Nothing stops that; nothing surfaces it either.

### 6.4 Seven specialist role instruction sets were dropped

**Phase 5.** `TestPlanner`, `Debugger`, `SecurityReviewer`, `PerformanceReviewer`,
`DocumentationWriter`, `DependencyAuditor` and `APIDesignReviewer` had no phase
to map onto in a four-command design, so their accumulated instructions went
with the `.agent.md` machinery.

**Cost:** real knowledge lost — the security role's "zero keyword hits means
your guesses missed, not that the repo is clean" is the kind of thing that took
a live failure to learn. They are recoverable from git history.

**Shape of the fix:** they are natural **aspects of the review phase** rather
than separate agents. `/review` could run security, performance and API-design
checks as passes over the same diff.

**Partly recovered in Phase 21:** the security role's most valuable line —
that searching for the wrong words and finding nothing is not a clean
repository — is now in the analyze role, along with the framing that
reviewing your own code for weaknesses is ordinary work. The performance,
API-design and dependency-audit knowledge is still only in git history.

### 6.5 Five docs describe the pre-redesign product

**Phase 8.** `AGENT_WORKFLOWS.md` was rewritten and the dead `@Agent` mentions
were corrected everywhere, but `PLAN_LIFECYCLE_DESIGN.md`, `ROADMAP.md`,
`TESTING_STRATEGY.md`, `MVP_DEFINITION.md` and `PHASE_26_VALIDATION_REPORT.md`
still describe the eleven-agent product as current.

**Cost:** a reader who starts from the wrong doc builds the wrong mental model
— the failure that produced a bug report about "the Code Analysis Agent" that
was really about `@architect`. Corrected only where a doc named a mention that
no longer resolves; a full rewrite of each is a phase of its own.

### 6.6 `--help` still says `npm run cli --`

**Phase 7.** The CLI's usage and example lines name the monorepo's npm script.
Correct for a developer with a clone, wrong for the copy inside the VSIX,
which is invoked by absolute path.

**Cost:** low — the bundled CLI is driven by the extension, not typed by hand.
Fixing it means threading the actual invocation through `getHelpText` and
`commandUsage`, which is a wider change than it looks.

---

## Closed by a later phase

Kept so the record shows what was traded and when.

| Limitation                                             | Raised    | Closed                                            |
| ------------------------------------------------------ | --------- | ------------------------------------------------- |
| `resetIndexFreshnessCache` exported but unwired        | pre-phase | Phase 0 — `.git/HEAD` checked before the cache    |
| Plan body opaque in the session                        | Phase 1   | Phase 2 — `PlanContract`                          |
| Nothing builds a plan contract end to end              | Phase 2   | Phase 4a                                          |
| `checkConstraints` never called against `plannedPaths` | Phase 2   | Phase 4b                                          |
| `runAgenticPlanLoop` — a third retrieval mechanism     | Phase 3   | Phase 4a                                          |
| No checkpoint captured                                 | Phase 4a  | Phase 4b                                          |
| Two tokenizers that had to be fixed twice              | pre-phase | Phase 3 — one exported tokenizer                  |
| Extension unusable without a monorepo clone            | pre-phase | Phase 7 — CLI bundled into the VSIX               |
| Generated artifacts named deleted agents               | Phase 5   | Phase 8 — `CHAT_COMMANDS` as one source           |
| `AGENTS.md` behind the built product                   | Phase 2   | Phase 8 — rewritten against measured figures      |
| No solution overview on main                           | Phase 6   | Phase 8 — written with re-measured numbers        |
| Phase 6 entries misfiled under documentation debt      | Phase 6   | Phase 8 — refiled under correctness edges         |
| Dashboard showed artifacts, never the session          | Phase 4a  | Phase 9 — Current work card, read via `peek`      |
| Nothing ever called `recordDecision`                   | Phase 1   | Phase 9 — proposals confirmed from `/create-plan` |
| A change of mind left two decisions active             | Phase 9   | Phase 10 — proposals carry what they replace      |
| `templates/agents/` left empty after Phase 5           | Phase 5   | Phase 8 — directory removed                       |
| Test suite leaked a temp directory per fixture         | Phase 28  | Phase 31 — one temp root per run, removed at end  |
