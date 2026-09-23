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

### 4.17 IntelliJ edition, Phase 1: dashboard only (Gradle build now verified — see 4.19)

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
  was written in** — that environment's egress policy returns 403 for
  every JetBrains-owned host, confirmed directly with `curl` before
  writing a single line of Kotlin, not assumed after the fact. This was
  the state of things until PR #3's own CI actually built it, six fixes
  later — see 4.19 for the full account. The Kotlin sources lean on plain
  `javax.swing.UIManager`/`java.awt.Color` rather than less certain
  IntelliJ Platform SDK convenience methods specifically to reduce the
  odds of an uncaught API mistake (see `ThemeColors.kt`); that bet paid
  off — none of the six real build failures CI found were in this file.
- **No bundled CLI.** `CliBridge` resolves the CLI from a
  `COPILOT_ARCHITECT_CLI` environment variable or a relative dev-checkout
  path — there is no analogue yet to how the VS Code `.vsix` bundles
  `cli.mjs` (`scripts/bundle-extension.mjs`). Packaging one is a later phase.
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
  later phases.

**Cost:** was the Gradle-build gap, now closed — see 4.19. Everything else
above is a small, explicit, and reversible scope cut. A green CI build is
not the same claim as a developer having clicked through the plugin in a
real IDE, which still has not happened; treat that gap as open.

---

### 4.18 IntelliJ edition, Phase 2: action row wired, orchestration duplicated by explicit decision (Kotlin now CI-verified — see 4.19)

**Phase 43.** Every dashboard action link VS Code exposes — Setup Repo,
Start & Setup MCP, Stop MCP, Generate Instructions, Open Repo, Scan &
Register Sub-repos, Analyze Repo, Build Index, Build Symbol Graph — is now
reachable from the IntelliJ dashboard, closing the "No action buttons" gap
4.17 left open.

- **CLI side (verified — builds, and 581/581 tests pass):**
  `packages/cli`'s `dashboard` command now renders every action as an
  `architect-action:<id>` link (`buildDashboardActionsHtml`) — a host-neutral
  scheme this plugin defines and intercepts itself, since JCEF has no
  built-in analogue to VS Code's webview `command:` URIs. Two new CLI
  commands back the orchestrated actions: `workspace scan <dir>` (registers
  every real-repo subdirectory of a folder, mirroring VS Code's
  `registerSubRepos`) and `setup [--workspace]` (the full
  init→analyze→graph→diagnostics→index→mcp-config sequence VS Code's
  `setupRepo` runs, single-repo or across every registered repo). The
  `dashboard` command also gained `--mcp-status`/`--last-command`/
  `--last-exit-code`/`--last-stdout`/`--last-stderr` flags, since a one-shot
  CLI render has no running process or command history of its own to
  report honestly — a long-lived caller (this plugin) supplies its own.
- **Kotlin side (compiles and passes the IntelliJ Plugin Verifier in CI as
  of 4.19; the click path confirmed in a real IDE per 4.25):**
  `ActionLinkInterceptor.kt` routes `architect-action:` link clicks to the
  plugin (through the browser console since 0.1.4 — see 4.25);
  `ActionDispatcher.kt` routes each id to `CliBridge` (for
  `setup`/`analyze`/`index`/`graph`/`instructions generate`/`workspace
scan`), to a new `McpProcessManager.kt` (a project-level service holding
  the long-lived `mcp` server `Process` handle — the same shell-local state
  VS Code's `activeMcpProcess` is, since a process cannot be reported by a
  one-shot CLI call), or to native IntelliJ APIs (`FileChooser` for the
  folder pickers Scan and Open Repo need, `ProjectUtil.openOrImport` for
  Open Repo itself, reusing the current window to match VS Code's own
  `forceNewWindow: false`). `DashboardPanel` now supplies `McpProcessManager`
  status and the last action's outcome back into every render via the new
  CLI flags. One real API mistake surfaced by CI and fixed in this chain:
  `ProjectUtil.openOrImport`'s second parameter is an `OpenProjectTask`,
  not a `Project` — the original line was never a valid overload; see 4.19.

**Deliberate duplication, not a silent Core Rule violation.** VS Code's
`registerSubRepos`/`setupRepo`/`shouldBuildWorkspaceGraph` (in
`vscode-extension/src/index.ts`) were left completely untouched, by explicit
user instruction, rather than refactored into a shared call both shells make
— the safer option was available and named at the time, and declined in
favor of shipping IntelliJ's action row sooner. The CLI's `runSetupCommand`
and `shouldBuildWorkspaceGraph` in `packages/cli/src/index.ts` are therefore
an **independent reimplementation** of that same step sequence and skip
heuristic, not a shared one. The two copies can drift: a fix to one (a new
setup step, a change to the workspace-graph skip condition) will not
propagate to the other unless someone remembers to also change it. This is
the same failure mode the Core Rule's own preamble in `AGENTS.md` names —
`@architect` and the MCP tools once answered questions differently because
retrieval was reimplemented rather than shared — accepted here explicitly
rather than repeated by accident.

**Also new, smaller:**

- `McpProcessManager` starts the server with stdout/stderr redirected to
  `ProcessBuilder.Redirect.DISCARD`, not streamed anywhere — VS Code's
  `outputChannel` shows the same server's logs live; this plugin currently
  cannot. Started at all only to avoid a blocked pipe stalling a
  long-running process that was never being read.
- `--last-stdout`/`--last-stderr` are truncated to 4000 characters
  (`ActionDispatcher.truncate`) before being passed as CLI flags on the next
  render, to keep argv size reasonable for a `setup --workspace` run's
  combined output across many repos — a long run's full output is therefore
  not fully visible in the dashboard's "Last command" card.
- The secondary action set (Open Repo, Scan & Register Sub-repos, Analyze
  Repo, Build Index, Build Symbol Graph) is rendered flat, in the same
  action row as the primary four, rather than behind a "More actions…"
  popup the way VS Code's quick pick hides it. This was a deliberate
  simplification, not an oversight: the CLI already lays out every action
  in one place (`buildDashboardActionsHtml`), and a second, IntelliJ-only
  grouping mechanism on top of that would only duplicate a decision already
  made rather than add anything.

**Cost:** the Gradle-build gap from 4.17 is now closed (4.19). What remains:
two orchestration implementations that can silently diverge, and an MCP
server whose logs this plugin cannot yet show.

---

### 4.19 IntelliJ edition: Gradle build verified green in CI, six real fixes deep

**PR #3** (`intellij-main` → `main`, opened for review and CI verification,
not yet merged). Every fix below was root-caused from an actual CI failure
on this PR's own commits — none guessed ahead of time, none accepted
without CI confirming the _next_ failure was a different one. This sandbox
still cannot build the plugin itself (JetBrains' distribution hosts remain
403 here, reconfirmed at each step); every fix that follows was verified
only as far as "the Gradle Kotlin DSL resolves with no unresolved
reference" locally, then proven for real by the next CI run.

In order, each one blocking the next:

1. **`bundledPlugin("com.intellij.modules.platform")`** — a core platform
   _module_, already provided by `create("IC", ...)` and correctly declared
   via `plugin.xml`'s own `<depends>`, requested again as if it were a
   separately-packaged plugin with its own JAR. CI: `Could not find bundled
plugin with ID: 'com.intellij.modules.platform'`. Removed the line.
2. **`ProjectUtil.openOrImport`'s second parameter** — the code called it
   with a `Project`; the real signature takes an `OpenProjectTask`. CI:
   `compileKotlin` — `Argument type mismatch`. This is the one defect that
   was actually wrong Kotlin, not Gradle configuration; every other fix in
   this chain was a build-script gap.
3. **JVM target mismatch** — `sourceCompatibility`/`jvmToolchain` were 17;
   IntelliJ Platform 2024.2 (the `sinceBuild "242"` already declared) runs
   on JBR 21. CI's own `verifyPluginProjectConfiguration` named the
   mismatch directly. Bumped `build.gradle.kts` and the CI workflow's
   `actions/setup-java` to 21 together — fixing one without the other would
   have just traded a 17-vs-required mismatch for a 21-vs-installed one.
4. **Missing `instrumentationTools()`/`intellijDependencies()`** —
   `:instrumentCode` (NotNull assertions etc.) needs a Java Compiler
   dependency neither the repository nor dependency block supplied. CI:
   `No Java Compiler dependency found`, naming the exact two-line fix.
5. **Missing `pluginVerifier()`** — `:verifyPlugin` (pulled into plain
   `build` via its `check` dependency, not only the workflow's separate
   `verifyPlugin` step) had no verifier CLI to run. CI named this fix too.
6. **Missing `pluginVerification { ides { recommended() } }`** — the
   verifier now existed but had no IDE version to check the plugin against.
   `recommended()` derives the list from `sinceBuild`/`untilBuild` rather
   than a hand-picked version to keep in sync separately.
7. **Plugin ID contained "intellij"** — the first failure that was a real,
   substantive Marketplace policy finding rather than a build-script gap:
   the Plugin Verifier had, by this point, successfully downloaded and run
   against a real IDE build (2024.2.6) and reported `The plugin ID
'com.copilotarchitect.intellij' should not include the word 'intellij'`.
   Renamed the `<id>` (only the id — not the Kotlin package, which is
   unrestricted) to `com.copilotarchitect.architect`, matching the
   `@architect` name used everywhere else in this product.

After fix 7, all four PR checks passed: `build` (both the `push`- and
`pull_request`-triggered runs of `intellij-ci.yml`), `test`, and
`release-check`. `:compileKotlin`, `:compileJava`, `:classes`,
`:instrumentCode`, `:buildPlugin`, and `:verifyPlugin` all completed
without error on a GitHub-hosted runner with real network access.

**What this does and does not prove:**

- **Proven:** the Kotlin compiles; the plugin assembles into an installable
  `.zip`; the assembled plugin passes the IntelliJ Plugin Verifier's static
  checks against a real 2024.2.x IDE build. This is a materially stronger
  claim than 4.17/4.18 could make before this PR — "the build script is
  intact" versus "the plugin actually builds."
- **Not proven:** nobody has installed this plugin into a running IDE and
  clicked anything. `runIde` was never attempted (a full IDE sandbox launch
  is a different, heavier CI job than a headless `build`/`verifyPlugin`).
  Every claim in 4.18 about _runtime behavior_ — the action-link
  interception actually firing, `McpProcessManager` actually holding a
  live process, the folder pickers actually opening — is still unverified
  the way it always was. A static verifier catches a wrong method
  signature; it does not catch a wrong assumption about which thread a
  JCEF callback runs on, or `OpenProjectTask`'s parameter names being
  subtly different from what fix 2 assumed under time pressure (`compileKotlin`
  succeeding confirms the _types_ line up, not that `projectToClose`/
  `forceOpenInNewFrame` are the parameter names that actually produce the
  intended "reuse this window" behavior at runtime).

**Cost:** the gap that mattered most in 4.17/4.18 — "nobody knows if this
compiles" — is closed. What is left is exactly the gap a green CI build
can never close on its own: a human running the actual plugin.

---

### 4.20 The `intellij` MCP toolset is a fixed, hand-picked list

**Item 29, AGENTS.md.** `MCP_TOOLSETS.intellij` (`packages/mcp-server/src/
tools.ts`) is 12 tool names written down once, not derived from any
property on the tool definitions themselves (no `tier: "core"` field, no
per-tool token-cost estimate). A new MCP tool added to the server in the
future defaults to appearing only in `full` — nothing forces a decision
about whether it belongs in `intellij` too, the same way a new field can be
added to a type without anyone updating every switch statement that
matches on it.

**Cost:** the list can go stale exactly the way the six-months-later
docs/behavior mismatches elsewhere in this file usually happen — not from
a bad decision, but from a decision nobody revisited. The test in
`tests/mcp-server.test.ts` that pins `intellij`'s exact tool set will catch
a tool being silently renamed or removed out from under it, but it cannot
catch a new tool that should have been added and wasn't; that's a review
question, not a test one.

**Also worth stating plainly:** only one curated toolset exists.
Earlier scoping work sketched a three-tier design (core / conditional for
multi-repo workspaces / optional for review-and-validation Q&A); what
shipped is the single 12-tool core tier only. `search_across_repos`,
`analyze_cross_repo_impact`, `get_latest_validation`, `get_latest_review`,
and `resolve_review_finding` are reachable only via `full` today — a team
that wants them live in IntelliJ's Copilot Chat without the rest of `full`
has no named toolset for that yet.

**Enforcement is opt-in, not structural.** Nothing stops a developer from
running plain `mcp` (defaulting to `full`) in IntelliJ instead of `mcp
--toolset intellij`, or from manually re-checking an excluded tool in
JetBrains' own "Add MCP Tools" picker. The flag makes the curated set easy
to select; it does not make the full set unreachable.

---

### 4.21 `find_impacted_files` and `analyze_impact` were removed, folded into `generate_plan_context`

**Item 30, AGENTS.md.** All three tools answered overlapping versions of
"what would this feature touch" from a request string, each independently
re-running search/analysis that `FeaturePlanningService.createPlanPreview()`
already computes in one pass internally:

- `find_impacted_files` called `IndexingService.findSimilarFeatures()`
  directly and returned `{filePath, score, matchedFields}` per result.
- `analyze_impact` called `createPlanPreview()` and returned only
  `impactAnalysis`/`impactedLanguages`/`impactedFrameworks`/
  `impactedModules`/`likelyFilesToModify`/`likelyNewFiles` from it,
  discarding the search results the same call had already computed.
- `generate_plan_context` called `findSimilarFeatures()` a second time
  (redundant with `analyze_impact`'s own internal call) and returned only
  `{repoMap, search}`.

A conversation that wanted both impact analysis and search context — the
common case going into a plan — had to call at least two of the three,
correlate the results itself, and pay for three tool schemas in every
turn's context regardless of which one that turn used. This is the same
"answers the same question differently because retrieval was
reimplemented rather than shared" failure the Core Rule's own preamble in
AGENTS.md describes for `@architect` vs. the MCP tools, at smaller scale
and inside the MCP surface itself rather than across shells.

**What changed:** `generate_plan_context` now calls `createPlanPreview()`
once and returns the union: `search` (shaped, ranked results),
`impactAnalysis`, `impactedLanguages`, `impactedFrameworks`,
`impactedModules`, `likelyFilesToModify`, `likelyNewFiles`.
`find_impacted_files` and `analyze_impact` no longer exist as separate
tools — not deprecated, not aliased, actually removed from both `full` and
the tool registry (28 tools, down from 30). `find_impacted_files`'s
`{filePath, score, matchedFields}` shape is not reproduced in any form:
every file it could name was already present in `likelyFilesToModify`
(which additionally distinguishes modify-vs-new) or in `search.results`
(which additionally carries the matched symbols and preview
`find_impacted_files` never did) — it added a third, narrower view of
data the other two already fully covered, not new information.

**This is a breaking change for any MCP client that called either
removed tool by name** — there is no compatibility shim. Given at the time
of writing the only real consumers were this repo's own tests (updated)
and the VS Code extension's own service-layer calls (which use
`FeaturePlanningService` directly, not through MCP, so unaffected), this
was judged safe. A client outside this repo calling `find_impacted_files`
or `analyze_impact` over MCP would need to switch to
`generate_plan_context` and read the fields it now needs from the
combined response.

**Cost:** none identified — every field either tool returned is still
returned, from `generate_plan_context` now, in fewer round trips. The
risk is the same as any consolidation: a future need genuinely specific to
one of the removed tools' narrower shapes would have to be reintroduced
as a new, deliberately-scoped tool rather than resurrecting either old one
verbatim.

---

### 4.22 Plan diff/approve in the IntelliJ Tool Window: no revision-diff for the full JSON, approve/diff only, unverified in a real IDE

**Item 31, AGENTS.md.** Closes the gap 4.20 named as a consequence of
`approve_plan`'s deliberate exclusion from the `intellij` MCP toolset:
until now, approving an MCP-generated `FeaturePlanArtifact` revision from
IntelliJ required a terminal. `showPlanDiff:<n>`/`approvePlan:<n>` give the
Tool Window its own click surface for both, mirroring the review-then-click
shape VS Code's chat button already has (the plan's markdown rendered,
then the button), adapted to a shell with no chat-button API to render
into.

**What the diff covers, and does not.** `diffPlanSections()`
(`packages/planner/src/feature-planning-service.ts`) is scoped to exactly
the `PlanSectionOverrides` keys `revise_feature_plan` can change — the only
fields two revisions of the same plan can actually differ on. It is a
**field-level** diff, not a text/line diff: a list field reports whole
items added/removed (by exact-match comparison, so an item reworded rather
than added/removed shows as one removal plus one addition, not an edit);
a scalar field (`summary`, `impactAnalysis`, `stackSpecificPlan`, etc.)
reports whole before/after values, truncated at 500 characters each
(`DIFF_VALUE_MAX_LENGTH`) — a long `impactAnalysis` object's exact
before/after JSON can be cut off in the CLI's text output (`--json` gets
the same truncated strings; there is no untruncated escape hatch today).
There is no line-level "this sentence changed" view the way a source-file
diff has.

**Approval still has exactly one path per surface.** The Tool Window's
`approvePlan:<n>` always resolves the revision from the id baked into the
dashboard render that showed it — never inferred as "whatever is newest"
(matching `approvePlan()`'s own rule) — but there is still no reject/
request-changes action next to it: declining a revision has no button of
its own, the same as before this phase. Feedback still has to go back
through a chat turn calling `revise_feature_plan`; the Tool Window can only
say yes or say nothing.

**`approvedBy` is the OS account name, not chosen.** `System.getProperty
("user.name")` is used directly, with no prompt and no way to approve
under a different recorded name from the Tool Window (the CLI's `--by
<name>` still allows any string). This was a deliberate simplification —
prompting for a name on every approval click would turn one button into
two — but it means the audit trail's `approvedBy` field reflects the local
OS account of whoever clicked, not necessarily a name meaningful outside
that machine (an email, a team handle).

**The Kotlin side is unverified the same way every other Kotlin change in
this plugin started out** (see 4.19's own account of what a green CI build
does and does not prove): this sandbox cannot reach JetBrains' distribution
hosts, so `PlanDiffDialog.kt` and `ActionDispatcher.kt`'s two new dispatch
functions were written against the platform SDK and checked by eye, not
compiled here. Unlike the Phase 1/2 Kotlin work, this has not yet been run
through a CI-verifying PR either (PR #3 was closed rather than merged, by
explicit instruction — see the PR's own closing comment) — so this is a
strictly weaker verification state than 4.19 reached: "written against the
right APIs" rather than "compiles and passes the Plugin Verifier." A future
CI-verification pass would need its own PR the way PR #3 was.

**Cost:** the terminal-only approval gap 4.20 named is closed for the
common case (approving is a two-click Tool Window flow: review the diff,
then approve). What remains open: no reject action, no untruncated diff
view for very large plans, an audit name tied to the OS account, and Kotlin
correctness that is asserted, not proven, until a real build verifies it.

**A sharper gap, found while explaining this workflow rather than while
building it: `get_approved_plan_contract` (in the `intellij` toolset)
cannot see what this phase approves at all.** It reads `plans/approved/
latest.json` / `plans/approved/v<n>.json` via `readApprovedPlan()`
(`packages/planner/src/plan-contract.ts`) — files written only by
`writeApprovedPlan()`, which is called only from the VS Code chat's
session-based `/create-plan` → approve flow (`PlanContract`, a distinct
type from `FeaturePlanArtifact`). `FeaturePlanningService.approvePlan()` —
the function behind `approve_plan`, `plan approve`, and this phase's
`approvePlan:<n>` Tool Window button — writes a differently-named,
differently-shaped artifact instead (`plans/approved/<planId>-rev<n>-plan
.json`, plus `plans/latest-plan.json`). IntelliJ has no session/chat-
participant flow at all, so nothing in a pure-IntelliJ workflow ever calls
`writeApprovedPlan()` — a Copilot Chat turn that calls
`get_approved_plan_contract` right after a real Tool Window approval still
gets back `{plan: null, reason: "no plan has been approved in this
workspace"}`. `get_latest_plan` is the tool that actually reflects an
IntelliJ-side approval (its `status` field flips to `"approved"`); anyone
working this way in Copilot Chat should be told to check that one, not
`get_approved_plan_contract`. Not fixed here — folding the two plan
lifecycles together, or dropping `get_approved_plan_contract` from the
`intellij` toolset in favor of `get_latest_plan`, is real design work of
its own kind rather than a one-line change, and out of scope for a phase
about the approve _button_, not the plan _model_.

---

### 4.23 The plugin was actually incompatible with every IDE newer than 2024.2.x, until a real install caught it

**Not item 31 or any earlier item — this is a correction to a claim made
about all of them.** 4.17/4.19/this file's own earlier text repeatedly
described `sinceBuild = "242"` with no `untilBuild` set in `build.gradle
.kts` as declaring compatibility with 2024.2 **and every version after
it**, on the reasoning that an absent `untilBuild` reads as "no upper
bound." That reasoning was wrong, and reading the build script again
harder would not have caught it — the actual bug lives in the Gradle
IntelliJ Platform plugin's own defaulting behavior, not in anything visibly
present in this repo's build script: when `untilBuild` is left unset, it
silently derives `"<sinceBuild's branch>.*"` (here, `"242.*"`) rather than
leaving the field genuinely open. The built `plugin.xml` therefore actually
shipped `until-build="242.*"` the whole time — every CI build, every green
`verifyPlugin` run, PR #3's entire six-fix account — all correct about what
they tested, all silently narrower in what they proved than the surrounding
prose claimed.

**How this surfaced:** a real developer installed the CI-built `.zip` into
a real IntelliJ 2026.2 (build `IU-262.8665.258`) and got rejected outright:
`"Plugin 'Copilot Architect' (version 0.1.0) is not compatible with
current version of IDE, because it requires build 242.* or older but
current build is IU262.8665.258."` This is exactly the class of gap 4.19
named as still open after a green CI build — "compiles and passes static
checks" is not "installs and runs" — except this particular gap wasn't
even a runtime-behavior question; it was a version string, and no amount
of `verifyPlugin` running green was ever going to catch it, because
`verifyPlugin` checks the plugin against IDEs _within_ its own declared
range, and the declared range was exactly the bug.

**The fix:** `ideaVersion { untilBuild = provider { null } }`, added
explicitly in `build.gradle.kts` — the documented way to actually clear the
Gradle IntelliJ Platform plugin's auto-derived default rather than merely
omitting the field and hoping.

**That fix broke CI on its very first run, for an unrelated, equally
real reason — not a hypothetical, an actual `verifyPlugin` failure.**
`pluginVerification { ides { recommended() } }` derives which IDE
version(s) to check the plugin against from `sinceBuild`/`untilBuild`; with
`untilBuild` now open-ended, `recommended()`'s heuristic picked `IC
2025.3` to verify against — a version that turned out not to be a
resolvable artifact anywhere: Maven Central and every JetBrains mirror
(`cache-redirector.jetbrains.com`'s several backing repos, `download
.jetbrains.com`) all genuinely 404 on it, confirmed directly in the CI log,
not assumed. `recommended()` was replaced with an explicit
`ide("IC", "2024.2.3")` — the same version already pinned for compiling
against, so it is guaranteed resolvable rather than trusted a second time
to guess correctly. This means CI's `verifyPlugin` step now checks the
plugin against exactly one concrete IDE version again, same as before this
whole fix — the `untilBuild` fix widens what the plugin _declares_ itself
compatible with; it does not and cannot make CI verify against every
version that declaration now covers, since there is no way to statically
enumerate "every future IDE version" for a verifier to check against.

**Neither fix has yet been confirmed by re-installing into a real
IntelliJ 2026.2** as of this writing — CI going green after the second fix
proves the plugin now builds and the _2024.2.3_ verification target still
passes; it does not by itself prove the rejection on 2026.2 is actually
gone, the same distinction 4.19 already drew between a green build and a
real install. That confirmation is the next real test.

**Cost, stated plainly:** every "no upper bound" claim made about this
plugin's compatibility before this fix — in AGENTS.md, in this file's
earlier 4.17/4.19 entries, in this session's own chat answers to the
developer setting it up — was wrong, for the entire time this plugin
existed, and wrong in a way a close reading of the build script alone
would not have surfaced (the defaulting behavior lives in the Gradle
plugin's own source, not this repo's). The broader lesson this repo keeps
relearning the hard way: a claim about IDE-facing behavior is not
confirmed by the build script agreeing with itself — only by the IDE.

---

### 4.24 The tool window crashed on IntelliJ 2026.2: JCEF became a separate bundled plugin in build 262

**The first genuine runtime crash this plugin has ever had, found by
actually clicking on it.** After 4.23's `untilBuild` fix, a real install
into IntelliJ 2026.2 (build `IU-262.8665.258`) got past the compatibility
rejection — but the "Copilot Architect" tool window never appeared. `Help
→ Show Log` surfaced the real cause: `java.lang.ClassNotFoundException:
com.intellij.ui.jcef.JBCefApp PluginClassLoader`, thrown wherever
`DashboardToolWindowFactory`/`DashboardPanel` constructs a `JBCefBrowser`.

**Root cause, confirmed against real JetBrains sources (blog post,
Plugin SDK docs, and multiple independent third-party plugins hitting the
identical crash on 2026.2), not assumed from a stack trace alone:**
through build 261 (IDE 2026.1), `com.intellij.ui.jcef.*` shipped in the
platform core and was visible to any plugin depending on
`com.intellij.modules.platform` — no extra declaration needed, which is
exactly why this plugin never needed one and nothing before 2026.2 could
have caught the gap. Starting with build 262 (IDE 2026.2), JetBrains
extracted JCEF into its own bundled "Web Browser (JCEF)" plugin
(`com.intellij.modules.jcef`); a plugin's classloader only gets access to
another plugin's classes if it explicitly depends on it, so
`DashboardToolWindowFactory`'s classes silently stopped resolving on
2026.2+ the moment JCEF moved out from under the umbrella dependency this
plugin already had.

**Fix:** `plugin.xml` gained
`<depends optional="true" config-file="withJcef.xml">com.intellij.modules
.jcef</depends>`, with a new, intentionally empty
`META-INF/withJcef.xml`. `optional="true"` is required, not a plain
`<depends>`: this plugin's own `sinceBuild` is 242, and an IDE from before
the JCEF split (242–261) may not recognize `com.intellij.modules.jcef` as
a resolvable module id at all — a _required_ dependency on an
unresolvable module would fail this plugin's load outright on every IDE
version it previously worked on. Optional means 262+ gets the classloader
edge it now needs, while 242–261 simply skips the dependency and keeps
getting JCEF from the platform core exactly as before — verified as the
real, documented pattern (not invented) by cross-checking three
independent sources: JetBrains' own JCEF blog post/Plugin SDK docs, and a
real third-party plugin's actual merged fix for this identical crash on
2026.2, fetched and read directly rather than paraphrased from a search
snippet.

**What is still not confirmed:** whether this specific fix actually makes
the tool window render on the reporting developer's real 2026.2 install —
CI going green after this (build + `verifyPlugin` against `2024.2.3`,
per 4.23) proves the plugin still compiles and still passes verification
against an IDE that never had this bug to begin with; it does not and
cannot prove the JCEF classloader edge actually resolves on 262+, since
nothing in this CI pipeline launches a real 2026.2 IDE. That confirmation
is, once again, only a real install away.

**Cost, stated plainly, continuing the pattern 4.23 named:** three real,
independent bugs now found in the time between "CI went green" and "a
developer actually used it" — an incompatible upper-version cap, a broken
verification target, and a missing classloader dependency for a platform
API the plugin depends on entirely for its one visible feature. None of
the three were reachable by any check this repository's own CI runs
today; all three were reachable only by a human clicking Install on a
real, current IDE. `./gradlew runIde` — never yet attempted, per 4.19 —
would very likely have caught at least this one locally, long before a
real developer had to.

---

### 4.25 Dashboard action links rendered but did nothing when clicked, on IntelliJ 2026.2

**Found by a real install (0.1.2, IntelliJ 2026.2), fixed and then
confirmed in that same install:** after 4.24's fix, the dashboard rendered,
but clicking Setup Repo (or any action link) did nothing — no dashboard
refresh, no "Last command" card, and `ActionDispatcher` always produces an
outcome for `setupRepo`, so the click never reached Kotlin at all.

**Two approaches failed before one worked:**

1. **`CefRequestHandler.onBeforeBrowse` (0.1.0–0.1.2).** Chromium treats
   the unregistered `architect-action:` scheme as an external protocol and
   drops the navigation before any browse callback runs.
2. **`JBCefJSQuery` (0.1.3).** An injected click listener cancelled the
   navigation and called a JS query. Still nothing arrived: a query is only
   reachable from the page when it is created before the native browser
   is, or when `JS_QUERY_POOL_SIZE` is set on the client, and the plain
   `JBCefBrowser()` `DashboardPanel` constructs satisfies neither. This
   explanation matches the JCEF documentation and the observed behavior; it
   was not isolated further.
3. **Browser console (0.1.4, works).** The injected click listener logs a
   `copilot-architect-click:<id>` marker with `console.log`, and a
   `CefDisplayHandler.onConsoleMessage` on the browser's client dispatches
   it. That transport has no creation-order precondition. Confirmed in the
   real 2026.2 install: clicking Setup Repo showed the in-page
   "Running Setup Repo…" banner, the dashboard re-rendered with a "Last
   command" card, and `setup` exited 0.

**What remains:**

- Only Setup Repo has been clicked in a real IDE. The other actions share
  the same transport, so they should be reached too, but their own
  dispatch paths (`McpProcessManager`, the folder pickers, `Open Repo`'s
  `OpenProjectTask` parameters, the plan diff/approve dialogs) are still
  unexercised at runtime.
- The console marker is a string convention: any script on the page that
  logs the same prefix would dispatch an action. The page is HTML this
  plugin renders itself from the CLI's own output, so no third-party
  script runs there today; this would need revisiting if the dashboard
  ever loaded remote content.
- `ActionDispatcher` still runs each action against `CliBridge`'s fixed
  60s timeout, so `setup` on a large workspace can time out.

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

**Widened, item 30 (AGENTS.md).** Three more join this list, discovered
auditing every reference to `find_impacted_files`/`analyze_impact` before
removing them (4.21), not from a scheduled review: `README.md`'s MCP tool
table and `docs/MCP_TOOLS.md` were already missing `get_session`/
`get_approved_plan_contract`/`verify_claims` (added under item 15, never
backfilled into either table) before today, and now also name two tools
that no longer exist at all. `PROJECT_HANDOVER.md` is further gone — its
MCP section still says "21 repo-intelligence tools" and its agent section
still describes "The 7 generated Copilot agents (`.github/agents/
*.agent.md`, model `gpt-4o`)", the exact pre-redesign system 6.4 already
records as dropped. None of the three were corrected here, for the same
reason the original five weren't: a full pass belongs to a phase of its
own, and a partial one — fixing just the two names this change happens to
touch — would leave the surrounding staleness looking more current than
it is.

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
