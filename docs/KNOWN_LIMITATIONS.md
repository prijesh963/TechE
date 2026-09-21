# Known Limitations

Everything deliberately left undone or knowingly imperfect during the redesign,
recorded so it can be assessed as a whole once the phases land rather than
rediscovered one at a time.

Each entry says what is wrong, what it costs, and — where it matters — why it
was left. Items resolved by a later phase are listed in
[Closed](#closed-by-a-later-phase) rather than deleted, so the record stays
honest about what was traded and when.

**Status:** Phases 0–40 merged. The redesign is complete; what is below is
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

### 1.12 The extension's review does not read the validation result

**Phase 19, narrowed in Phase 33.** The CLI does load it: an end-to-end run on
a real repository reported `Validation status: passed` once a report existed,
so `ReviewService` and the artifact wiring work. The extension's `/review`
still does not pass one, so a failing test does not become a review finding
there.

**Cost:** the loop's last two steps meet on the CLI and not in the editor,
which is where the four phases are actually driven. Passing `validation:` to
the review call would close it, and needs the run's path threaded through the
session. Recorded until Phase 33 as if neither path worked, which the record
now corrects.

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

### 1.19 A proposed new file is still a guess about placement

**Phase 33.** The CLI planner names a proposed file after the feature and puts
it in a folder that already holds that language, preferring a module the
request names. That is evidence, not knowledge: "add retry to the visits
client" lands in the visits module because the word matches, and a request
whose wording does not match any module falls back to wherever that language
is most present.

**Cost:** a plausible-looking path in the wrong module, which a developer has
to notice. The alternative is proposing nothing, which the repo-without-Java
case already does. Judging the right module needs a model, which is the
extension's path rather than the CLI's.

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

### 4.12 Orchestration and monorepo-tooling detection stops at "present"

**Phase 34.** Kubernetes, Helm, Docker Compose, Nx and Turborepo are detected —
by content where a signal exists, by canonical filename otherwise — but
detection stops at naming the tool. It does not read what `nx.json`'s
`implicitDependencies` or `turbo.json`'s task `dependsOn` actually say, so the
plan cannot answer "which other projects depend on the one being changed" —
only tell the developer to go check the tool's own graph themselves. The
planner guidance for Nx and Turborepo says exactly this rather than pretending
otherwise.

**Cost:** the one thing that would make this genuinely prevent the "looked
isolated but wasn't" failure — a real project dependency graph, the same
depth the symbol graph already gives TS/JS and Java — is not there yet for
the monorepo build graph. Detecting presence was the tractable first step;
parsing the graph is a second one.

Docker Compose also has no content signal at all (`strong: []`), relying
entirely on its canonical filename. A file merely named `docker-compose.yml`
with unrelated content would still be flagged — accepted because the
filename is unambiguous in practice, the same trade the Java adapter already
makes by treating `pom.xml` alone as high-confidence Maven evidence.

### 4.13 Cucumber detection stops at "this repo uses Cucumber"

**Phase 35.** Playwright, Cucumber and TestNG are detected the same way
everything else on this axis is — by content or canonical filename — and each
carries its own risk guidance into a plan. What Cucumber does not get is the
one thing that would make that guidance actionable on its own: linking a
specific `.feature` scenario to the step-definition code that implements it.

That link is not a filename convention the way a unit test's sibling file is —
a Gherkin step matches a step-definition by its text against a
Cucumber-expression or regex, and one step-definition file commonly backs many
`.feature` files and vice versa. Building it would be its own small parser,
closer in scope to the tree-sitter symbol work than to a detector entry.

**Cost:** the planner guidance already says "a step change can silently break
scenarios still phrased the old way" — true, but the tool cannot yet say
_which_ scenarios. A developer still has to search for callers of a changed
step by hand.

**Also open:** a third framework, referred to only as "FAST", was raised
alongside Playwright and Cucumber but never got a config filename, dependency
name or folder convention supplied — every concrete value needed to write a
real signal, as opposed to a guess dressed as one. Deferred rather than
built on a guess; the detection mechanism is ready and costs about fifteen
lines once those markers exist, the same size as each of the nine signals
already in `integration-detector.ts`.

### 4.14 Cross-repo interlinks are code-level and evidence-based, not runtime

**Pre-phase, surfaced assessing Phase 36. HTTP-route matching closed Phase
37, messaging matching closed Phase 39, package-name imports and
constant-held values closed Phase 40.** "Interlinks between repos" was
checked directly rather than assumed. What works:

- A relative import that crosses from one registered repo's folder into
  another's resolves in the symbol graph exactly like an in-repo import, and
  `graph-workspace.json`'s `crossRepoEdgeCount` reports it.
- A non-relative TS/JS import that matches a _different_ registered repo's
  own `package.json` name — the way a real consumer of the published
  package would write it, rather than a relative path — also resolves,
  exact or subpath (`@acme/order-client/lib/foo`), tried against that
  repo's `main`/`module`/`types` entry point first and its `index.*`/
  `src/index.*` convention as a fallback. Java already resolved this case
  through its qualified-name index; this closed the equivalent TS/JS gap.
- An HTTP client call in one repo — `axios.get(...)`, `fetch(...)`,
  `requests.get(...)`, an OpenFeign client method — whose path matches a
  route detected in a _different_ registered repo is reported as an
  `AdvancedAnalysis.interlinks` entry (`kind: "http-route"`), tagged with
  both repos, the calling and exposing file, and a confidence based on
  whether the HTTP methods agree. A `@FeignClient` interface's own
  `@GetMapping`-style annotations are read as the call they are, not
  misreported as a route the calling repo itself exposes.
- A producer in one repo — a kafkajs/kafka-python/confluent-kafka
  `.send(...)`/`.produce(...)`, a Spring `kafkaTemplate.send(...)`, an
  amqplib/pika/Spring-AMQP publish, a Spring `jmsTemplate.convertAndSend(...)`
  (the API IBM MQ and ActiveMQ are also normally driven through in Java) —
  whose topic/queue/destination name and broker match a consumer detected
  in a _different_ registered repo is reported as an interlink (`kind:
"messaging"`), confidence always `"high"` since a broker+channel match
  has no second discriminator like HTTP's verb to lower it against.
- Both matchers now resolve a path/topic argument given as a **named
  constant**, not only a repeated string literal — `kafkaTemplate.send(
ORDER_TOPIC, ...)` resolves `ORDER_TOPIC` against a `const`/module-level/
  `String`-field declaration in the same file, the norm rather than the
  exception in idiomatic Kafka code. An unresolved reference (the constant
  is declared elsewhere, or never declared) is dropped rather than
  guessed at. Fixing this also closed a real, adjacent bug: a Spring/Feign
  mapping annotation's argument (`@GetMapping(INVOICE_PATH)`) was
  previously read as literal path text regardless of whether it was
  quoted, so an unquoted constant reference silently became a fabricated
  route at `"/INVOICE_PATH"` — it is now resolved or dropped like every
  other case, never guessed.

What still does not work:

- A path built from a **variable** (not a named constant) — an interpolated
  template literal (`` `${apiBase}/invoices` ``) or string concatenation —
  is invisible to either matcher. This is a materially different problem
  from the constant case just closed: resolving it means tracking partial
  string composition, not a single-hop name lookup, and was not attempted.
  Two repos that happen to share a generic path (`/health`) or channel name
  without actually talking to each other would still be reported as linked.
- Messaging detection covers one client library per language per broker —
  Node's `amqp-connection-manager`, Python's lower-level `confluent_kafka`
  admin APIs, or a raw `javax.jms` producer without Spring's `JmsTemplate`
  are not matched, consistent with the same "one representative pattern per
  framework" scope the route detectors already have.

**Cost:** a plan touching a contract shared across repos — a REST endpoint,
a message payload, a published internal package — now gets its
callers/consumers/importers surfaced automatically for all the common
cases above. What remains is genuinely harder: resolving a dynamically
composed path or topic name needs partial evaluation of string
concatenation/interpolation, not just another lookup table.

### 4.15 Call-graph instance/local-variable resolution, closed with remaining edges

**Raised assessing Phase 36, closed in Phase 38, array/for-of and Java
enhanced-for/varargs closed in Phase 40.** `resolveIdentifier` and
`resolveJavaIdentifier` only ever matched a bare identifier against a
declared/imported/same-package type name — a call through a variable
(`repo.save(...)`) had no way to become a call on `OrderRepository` unless
`repo` happened to share its name with a real type, which it normally does
not. The most common real call site in both languages — a repository or
service reached through an injected field or a method-local variable — was
silently dropped rather than misresolved, consistent with the "never wrong,
just fewer nodes" contract, but it meant the edges most worth citing in a
plan (service → repository, controller → service) were usually the ones
missing.

Both extractors build a name → declared-type map before queuing a call
reference, and resolve the receiver against it first:

- **TypeScript/JS:** a class field's own type annotation, a constructor
  parameter property (`constructor(private repo: OrderRepository)`), a plain
  method/function parameter's type annotation, and a local variable's
  explicit annotation or its type inferred from a `new ClassName(...)`
  initializer. `this.field.method()` is recognized as a call site alongside
  the bare `field.method()`. A local shadowing a same-named field resolves
  to the local's type, matching real scoping. An array-typed field,
  parameter or local (`Repository[]` or `Array<Repository>`) additionally
  resolves a `for (const r of that binding)` loop's own variable to the
  array's element type — including `for (const r of this.repos)` over a
  field — so the loop variable's own method calls resolve too.
- **Java:** `findLocalVariableTypes` mirrors the existing `findFieldTypes`
  for a method's own parameters (varargs included) and `Type name = ...;`
  locals declared in its body, checked before the field map for the same
  shadowing reason. An enhanced-for loop's own variable (`for (Order order
: orders)`) resolves the same way — its `:` terminator needed a pattern of
  its own, since the plain declaration pattern requires `;`/`=`.

**Still not resolved**, consistent with the rest of each extractor's
documented scope:

- TypeScript: a generic type parameter itself (`Repository<Order>` still
  reads as plain `Repository`, which is already the useful outcome for a
  receiver's own type — this only matters for the _type argument_ `Order`,
  which is never a receiver) and union-typed fields/locals are unhandled —
  `typeReferenceName` only reads a plain `TypeReferenceNode`. A type
  inferred from a function's return annotation rather than an explicit
  variable annotation or a `new` expression (`const repo =
getRepository();`) is not read either.
- Both: a receiver reached through method chaining (`getRepo().save(...)`) or
  reassigned to a different type after declaration is still unresolved — the
  map is built once per scope from declarations, not from data flow. This is
  a structural boundary of the "AST/regex without a type checker" design
  both extractors are built on, not an oversight — real data-flow analysis
  is a different scale of work than a declaration-based lookup table.

**Cost:** these are all real misses, not wrong edges — the graph still never
points a citation at the wrong file. Verified against the actual CLI `graph`
command, not only the unit fixtures: a constructor-injected TypeScript field
(`this.repo.save(...)`), a Java local variable (`OrderRepository repo = new
OrderRepositoryImpl(); repo.save(...)`), and a `for (const order of
this.orders)` loop over a TypeScript field all resolve end to end.

---

### 4.16 Dashboard session-activity metrics: known boundaries

**Phase 41.** The Agent Insights card's session rollups (files referred from
the index, lines/files changed, decisions, plan/approval cycle, constraint
coverage) are all read from real data — the session record, the
search-activity log, and git — never estimated, but each has an honest edge:

- **Lines/files changed** (`collectSessionChangeStats`) diffs the working
  tree against the commit that was `HEAD` when the session opened, found via
  `git rev-list --before <session.createdAt>`. Git commit dates have
  one-second resolution: a commit landed in the same wall-clock second as
  the session's own `createdAt` instant can be included or excluded by that
  boundary check either way, rather than by which side of the session
  opening it actually happened on. In real usage this is far below the gap
  between a session opening and a developer's first commit; it showed up
  only in a fast automated test committing twice in immediate succession.
- **Untracked new files are not counted.** `git diff` does not see a file
  until it is added, so a session that adds whole new files without staging
  them undercounts rather than guesses at their size.
- **"Files referred from the index"** counts only `IndexingService.search()`
  calls — the retrieval path an agent actually reasons from. A workflow that
  only enumerates the repo via `listFiles`/`list_files` (used for "what's
  here", not "what's relevant") is not reflected, since enumeration is not
  the index "referring" a file into an answer.
- **No git repository, or no commit before the session opened**, returns
  `undefined` for the change stats rather than falling back to an
  empty-tree diff — the fallback was deliberately rejected because a shallow
  clone whose history does not reach back that far would otherwise report
  its entire checkout as newly added.

**Cost:** low — every fallback is a missing figure, never a wrong one, and
the card says so in place of a number rather than silently reading as zero.

---

### 4.17 IntelliJ edition, Phase 1: dashboard only, unverified Gradle build

**Phase 42.** A second shell, `packages/intellij-plugin` (Kotlin/Gradle),
alongside the VS Code extension. Phase 1 scope is deliberately narrow — the
same Core Rule the rest of the product follows ("a shell calls the CLI/
core/MCP services, it never owns the logic itself"), extended to a shell
that cannot import TypeScript at all:

- `createDashboardHtml` and its loaders (`loadDashboardArtifacts`,
  `loadDashboardSession`) moved out of `packages/vscode-extension` into a
  new `packages/dashboard`, which the extension now imports unchanged (a
  thin wrapper assembles VS Code's own `command:` action-row HTML and
  passes it in, so VS Code's rendered output is byte-for-byte identical to
  before the move — verified by the full existing test suite passing
  unmodified). A new CLI command, `copilot-architect dashboard [--path]
[--json]`, imports the same package and prints the HTML to stdout for a
  non-Node host to consume.
- The IntelliJ plugin's `DashboardPanel` spawns that CLI command
  (`CliBridge.kt`) and loads its stdout HTML into a JBCef (embedded
  Chromium) view — no rendering logic of its own, matching the extension.

**Known boundaries, by design or by environment, not by oversight:**

- **The Gradle build could not be compiled or verified in the sandbox it
  was written in.** That environment's egress policy allows Maven Central
  and the Gradle Plugin Portal (so the Kotlin and IntelliJ Platform Gradle
  plugins resolve) but returns 403 for every JetBrains-owned host
  (`cache-redirector.jetbrains.com`, `www.jetbrains.com`,
  `plugins.jetbrains.com`) — confirmed directly with `curl` before writing
  a single line of Kotlin, not assumed after the fact. `./gradlew build`
  there gets exactly as far as `Could not resolve all dependencies for
configuration ':compileClasspath': No IntelliJ Platform dependency
found.` — i.e. it never reaches compiling a single `.kt` file. The Kotlin
  sources lean on plain `javax.swing.UIManager`/`java.awt.Color` rather
  than less certain IntelliJ Platform SDK convenience methods specifically
  to reduce the odds of an uncaught API mistake (see `ThemeColors.kt`), but
  none of it is proven to compile yet — `.github/workflows/intellij-ci.yml`
  (path-filtered, targets the `intellij-main` branch) is the first place
  that will actually try, since GitHub-hosted runners are not behind this
  restriction.
- **No bundled CLI.** `CliBridge` resolves the CLI from a
  `COPILOT_ARCHITECT_CLI` environment variable or a relative dev-checkout
  path — there is no analogue yet to how the VS Code `.vsix` bundles
  `cli.mjs` (`scripts/bundle-extension.mjs`). Packaging one is Phase 2.
- **No action row.** The CLI's `dashboard` command has no caller-specific
  command/URI scheme to render, so it emits an empty one — Setup Repo,
  Build Index, etc. are not yet reachable from the IntelliJ dashboard.
- **`--vscode-*` CSS custom property names, reused verbatim.** `ThemeColors`
  maps IntelliJ's current Look and Feel onto the same variable names the
  shared dashboard HTML already uses, rather than the dashboard package
  taking a host-neutral theme parameter — functionally harmless (a CSS
  custom property name is just a string) but a naming leak worth a rename
  once a third host needs its own reason to.
- **The `--vscode-charts-*` accent colors are fixed**, not derived from the
  active IntelliJ theme — there is no IntelliJ theme key as standardized as
  VS Code's `charts.*` tokens to map from. They will not adapt to a Light
  theme the way the rest of the dashboard's colors, which are genuinely
  theme-derived, do.
- **Dashboard only.** No chat, plan approval, or diff surface — those are
  later phases; a real Tool Window UI for them needs the Gradle build
  actually verified first.

**Cost:** the Gradle-build gap is the one that matters — everything else is
a small, explicit, and reversible scope cut. Do not treat any of this
Kotlin code as working until it has compiled somewhere with real network
access.

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

| Limitation                                                                                                                                       | Raised    | Closed                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `resetIndexFreshnessCache` exported but unwired                                                                                                  | pre-phase | Phase 0 — `.git/HEAD` checked before the cache                                                                                        |
| Plan body opaque in the session                                                                                                                  | Phase 1   | Phase 2 — `PlanContract`                                                                                                              |
| Nothing builds a plan contract end to end                                                                                                        | Phase 2   | Phase 4a                                                                                                                              |
| `checkConstraints` never called against `plannedPaths`                                                                                           | Phase 2   | Phase 4b                                                                                                                              |
| `runAgenticPlanLoop` — a third retrieval mechanism                                                                                               | Phase 3   | Phase 4a                                                                                                                              |
| No checkpoint captured                                                                                                                           | Phase 4a  | Phase 4b                                                                                                                              |
| Two tokenizers that had to be fixed twice                                                                                                        | pre-phase | Phase 3 — one exported tokenizer                                                                                                      |
| Extension unusable without a monorepo clone                                                                                                      | pre-phase | Phase 7 — CLI bundled into the VSIX                                                                                                   |
| Generated artifacts named deleted agents                                                                                                         | Phase 5   | Phase 8 — `CHAT_COMMANDS` as one source                                                                                               |
| `AGENTS.md` behind the built product                                                                                                             | Phase 2   | Phase 8 — rewritten against measured figures                                                                                          |
| No solution overview on main                                                                                                                     | Phase 6   | Phase 8 — written with re-measured numbers                                                                                            |
| Phase 6 entries misfiled under documentation debt                                                                                                | Phase 6   | Phase 8 — refiled under correctness edges                                                                                             |
| Dashboard showed artifacts, never the session                                                                                                    | Phase 4a  | Phase 9 — Current work card, read via `peek`                                                                                          |
| Nothing ever called `recordDecision`                                                                                                             | Phase 1   | Phase 9 — proposals confirmed from `/create-plan`                                                                                     |
| A change of mind left two decisions active                                                                                                       | Phase 9   | Phase 10 — proposals carry what they replace                                                                                          |
| `templates/agents/` left empty after Phase 5                                                                                                     | Phase 5   | Phase 8 — directory removed                                                                                                           |
| Test suite leaked a temp directory per fixture                                                                                                   | Phase 28  | Phase 31 — one temp root per run, removed at end                                                                                      |
| `AdvancedAnalysisService.analyze()` only ever read `repoMap.repos[0]`, silently ignoring every other registered repo                             | pre-phase | Phase 36 — every repo is analyzed and tagged with `repoName`                                                                          |
| No cross-repo HTTP-route interlink matching; a `@FeignClient`'s own mappings misread as a route it exposes                                       | pre-phase | Phase 37 — outbound calls matched to routes in other repos, Feign calls no longer misread as routes                                   |
| Call-graph resolution never bound a receiver variable to its declared type, so a field/local/parameter call site was silently dropped            | pre-phase | Phase 38 — field, constructor-param-property, parameter, and local-variable types resolved in both extractors                         |
| No cross-repo messaging interlink matching (Kafka/RabbitMQ/JMS producer-consumer pairing)                                                        | pre-phase | Phase 39 — literal topic/queue names matched by broker across repos for kafkajs/kafka-python, amqplib/pika, and Spring Kafka/AMQP/JMS |
| Non-relative TS/JS import of another registered repo's own package name resolved to nothing                                                      | pre-phase | Phase 40 — resolved via each repo's declared `package.json` name, exact and subpath                                                   |
| Interlink matchers and Spring/Feign mapping annotations read literal strings only; an unquoted annotation argument was read as literal path text | pre-phase | Phase 40 — a named constant is resolved (or dropped, never guessed) in both interlink matchers and route detection                    |
| confluent-kafka's `Producer.produce(...)` unmatched despite claimed coverage                                                                     | pre-phase | Phase 40 — matched alongside kafka-python's `.send(...)`                                                                              |
| Java call-graph resolution missed varargs parameters and enhanced-for loop variables; TypeScript missed array/`for...of` element types           | pre-phase | Phase 40 — both resolved in their respective extractors                                                                               |
