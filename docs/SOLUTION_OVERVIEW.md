# Copilot Architect — Solution Overview

What this is, why it exists, how it is built, and what to say about it to
people who are deciding whether to fund or permit it.

**Status:** Phases 0–8 built and merged. 297 tests. Installable as a `.vsix`.
Open items are recorded in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) rather
than left to be rediscovered.

---

## 1. The problem

A developer with Copilot already has a capable model. What the model does not
have is the repository.

Every task starts from zero. The model rediscovers the same architecture, the
same conventions, the same service boundaries — in every conversation, every
day, for every developer. That rediscovery is paid for twice: in tokens, and
in the developer's time re-explaining what the tool should already know.

Worse, when rediscovery fails it fails silently. A search for the wrong term
returns nothing, and the model reports that nothing is there. A security review
that found no issues because it looked in the wrong place reads exactly like a
security review that found no issues. This is the expensive failure mode — not
bad code, which reviewers catch, but **confident wrong answers**, which they do
not.

And nothing survives. The reasoning that produced a change lives in a chat log
that is gone next week. There is no artifact saying what was intended, what was
considered and rejected, or who agreed to it.

---

## 2. Objective

Ground the model in what is actually in the repository, and leave behind a
record of what was decided.

Concretely:

- Index the repo **once**, locally, and reuse it.
- Retrieve **once per feature**, not once per turn.
- Produce a **plan a named engineer approved**, versioned.
- **Verify** the model's claims against the index before showing them.
- Say plainly when the tool could not do the job, rather than guessing.

---

## 3. Solution approach

### 3.1 One door

`@architect`, with four phases: `/analyze`, `/create-plan`, `/implement`,
`/review`. A prompt with no slash command means `/analyze`.

Earlier versions installed eleven separate agents. That put a menu in front of
a developer who wanted one thing, and it made coordination advisory — every
fix became another "Step N: call X" line in a markdown file a model could skip.
The phases are now code. Code cannot skip its steps.

### 3.2 The plan is the context

A plan carries the current contents of every file it proposes to change, the
decisions made so far, the validation commands, and what the planner could not
see.

This is the load-bearing design choice. If `/implement` has to go back and
re-read the repository to act on the plan, then the plan was not a plan — it
was a suggestion, and you are paying for context on every turn again. Retrieval
happens once, at plan time.

### 3.3 Stateful sessions, developer as final decider

A session belongs to a workspace and holds one feature: phase, recorded
decisions, every plan version, and which version was implemented.

It ends when the developer says so. It is parked, never deleted, when the
branch moves underneath it.

**Approve Plan is a button, not a phrase.** The step that authorizes writing
code must not depend on a model reading approval out of "looks good to me".
Silence, a question and qualified agreement are not approval. Amending an
approved plan requires approving it again.

The model proposes decisions; the developer confirms, amends or rejects them.

### 3.4 Grounding

Before an answer reaches the developer, its checkable claims are checked:
backticked paths, `file:line` citations and qualified symbols must resolve
against the index. Anything that does not is flagged as unconfirmed.

The check is deliberately conservative — precision over recall. A claim in
prose ("the service retries three times") is not verified, and the report says
so. A false "unverified" on something real teaches developers to ignore the
warnings, and a warning nobody reads is worse than no warning.

### 3.5 Honest degradation

When the tool can do less, it says so instead of presenting partial work as
complete.

No index yet: it says "nothing was verified", not "all clear". Zero search
results: it reports how many files it was shown, because zero matches mean the
query missed, not that the repo is empty. Symbol graph switched off: relation
claims are listed as not checked rather than assumed true.

This principle came from a real failure — a report that the repository was
empty when the context handed to the model was, in fact, empty.

---

## 4. Architecture

```
┌─ SHELLS — thin, no business logic ─────────────────────────┐
│                                                             │
│   VS Code extension        CLI            MCP server        │
│   (primary, .vsix)      (terminal, CI)  (external agents)   │
│                                                             │
└───────────────────────────┬─────────────────────────────────┘
                            │  all three call the same code
┌───────────────────────────▼─────────────────────────────────┐
│  session      phase · decisions · plan versions ·            │
│               checkpoint · constraints                       │
│  grounding    verify claims against index + symbol graph     │
│  roles        internal prompts (not user-facing agents)      │
├──────────────────────────────────────────────────────────────┤
│  planner   indexer   graph   adapters   intent               │
│  validator reviewer  instructions   core   shared            │
└──────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  .copilot-architect/   index · graph · plans · sessions ·    │
│                        reviews · audit                       │
│  Local to the machine. No code leaves the network.           │
└──────────────────────────────────────────────────────────────┘
```

**The governing rule:** shells call core; they never reimplement it. One
retrieval engine, one tokenizer, one ranking path — so every surface gives the
same answer to the same question.

That rule was violated once and it mattered. The extension re-implemented
retrieval instead of calling the indexer, so `@architect` and the MCP tools
disagreed, and a fix applied to one never reached the other.

### Feature lifecycle

```
  /create-plan ──► session opens, index refreshes (local, 0 tokens)
        │
        ▼
  retrieval runs ONCE ──► plan drafted in session, not on disk
        │                 decisions visible as they accrue
        ▼
  [ Approve ] ──► plan v1 written · checkpoint captured
        │
        ▼
  /implement ──► reads the plan only ──► writes files ──► graph rebuilt
        │
        ▼
  /review ──► plan vs checkpointed diff ──► findings
        │
        ├── findings accepted ──► plan v2 ──► [ Approve ] ──► implement v2
        │
        ▼
  [ End session ] ──► parked, never deleted
```

---

## 5. How this differs from Copilot agent mode

|                      | Copilot agent mode                         | Copilot Architect                          |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| Repo knowledge       | rediscovered per task, per turn            | indexed once locally, reused               |
| Retrieval cost       | scales with conversation length            | paid once, at plan time                    |
| Reviewable artifact  | none — reasoning evaporates                | versioned plan a human approved            |
| Approval             | a sentence the model may honor             | a button the code enforces                 |
| Constraints          | advisory                                   | machine-checked at implement time          |
| Verification         | none — no source of truth to check against | index + symbol graph as an oracle          |
| When retrieval fails | answers anyway, confidently                | says what it could not find                |
| Multi-repo           | one repo at a time                         | workspace-wide, with cross-repo call edges |

---

## 6. Measured cost

Measured on this repository with the project's own `measure` command and its
~4-characters-per-token estimator. **Directional, not billing-accurate** — a
real tokenizer will differ, and these are this repo's numbers, not yours.

### Solid — measured directly

| Measurement                                     | Result                     |
| ----------------------------------------------- | -------------------------- |
| Whole repo, handed over naively                 | 273 files ≈ 441,600 tokens |
| Files a plan actually selects for one feature   | 8 files ≈ 20,500 tokens    |
| **Reduction in what reaches the model**         | **95.4%**                  |
| `search_repo` response, before payload shaping  | ≈ 36,950 tokens            |
| `search_repo` response, after shaping (Phase 0) | ≈ 6,440 tokens             |
| **Reduction from shaping alone**                | **82.6%**                  |
| 27 MCP tool definitions, resent every turn      | ≈ 2,940 tokens/turn        |

The shaping figure is the clearest single win: symbol lists and text previews
were 96% of a search response, and capping them cost nothing a model could use.

### Modelled — assumptions stated

A feature worked through agent mode over a 20-turn conversation pays the tool
definitions every turn (≈ 59,000 tokens) plus repeated retrieval. The same
feature in Copilot Architect pays retrieval once at plan time (≈ 20,500 tokens)
and carries it forward in the plan.

The honest form of this claim: **retrieval cost stops scaling with conversation
length.** How much that saves depends entirely on how long your conversations
are, which we have not measured across a team.

### Unknown — not claimed

- Real token counts under the provider's tokenizer.
- Savings across a team, over a quarter, on repos other than this one.
- Whether developers actually work one feature per session in practice.

Nobody has used this but its author. Every number above should be re-measured
on a real repository with real developers before it is quoted to anyone.

---

## 7. Talking points for senior management

**Lead with governance, not cost.** Today an AI-assisted change has no
reviewable record of intent. Copilot Architect produces a plan a named engineer
approved, versioned, with the decisions and rejections that shaped it. When
something goes wrong in production there is an artifact to examine rather than
a chat log that no longer exists. In regulated environments that is the
difference between AI assistance being permitted and being prohibited.

**It reduces a specific, expensive failure.** The risk with AI coding tools is
not bad code — reviewers catch bad code. It is confident wrong answers: a
security review that found nothing because it searched for the wrong words and
reported "no issues". This design makes that class of failure visible by
construction, and says so when it cannot check.

**The cost argument is real but secondary.** A ~95% reduction in what reaches
the model per feature matters at team scale and compounds with adoption. But
model prices fall every year, and the measurements above are from one
repository. Do not lead with cost.

**Nothing leaves the network.** Indexing, graph building and verification are
local. No code is transmitted to build repo intelligence; only the context
needed for a specific request reaches the model — and less of it than agent
mode sends.

**Adoption cost is one install.** A `.vsix` installed once per developer. No
servers, no infrastructure, no licence beyond the Copilot licences already
held. Where policy forbids extensions, the MCP server delivers the same
intelligence to any MCP client.

**It makes senior engineers faster without removing them.** The developer
decides what the plan says, what is out of scope, and when it is approved. The
tool does the reading and the drafting. That distinction is what makes this
adoptable by teams that would reject an autonomous agent.

---

## 8. Why this is needed now

Teams already have Copilot. The question is not whether to use AI assistance
but whether to use it **with or without institutional memory of the codebase**.

Without it, every developer re-explains the same architecture to the same model
every day, and no record survives. With it, the repository's structure is
indexed once and every request is grounded in it.

The gap widens with codebase size and team size — which is exactly where the
cost of getting it wrong is highest.

---

## 9. What is deliberately not built

- Visual Studio (the IDE) extensions, WPF/Blazor UI, a .NET engine.
- A vector database or any cloud backend. Local BM25 and a symbol graph carry
  the retrieval, and they can be inspected.
- Autonomous multi-feature operation. One feature per session, ended
  explicitly, is a v1 constraint chosen for reviewability.
- Commercial packaging. This is internal tooling.

---

## 10. Honest assessment

This is a prototype that works, used by one person. The design decisions above
are deliberate and tested, but they have not met a team.

Before wider rollout, the things most likely to be wrong: whether one feature
per session matches how developers actually work; whether the plan format
survives contact with a large legacy repo; and whether the measured savings
hold on a codebase that is not this one.

The open items are in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — 38 of
them, recorded as they were traded rather than discovered later.
