# Workflows

How a feature moves from a request to a reviewed change, and what each step is
allowed to do.

Earlier versions of this document described eleven Copilot agents installed as
`.github/agents/*.agent.md`. Those are gone. Two things were wrong with them.
A menu of eleven mentions put a choice in front of a developer who wanted one
thing — which is how a bug report about "the Code Analysis Agent" turned out to
describe `@architect`, a different system entirely. And coordination between
them was advisory: every fix became another "Step N — call X" line in a
markdown file that a model was free to skip. The four phases below are code,
and code cannot skip its steps.

---

## The four phases

One feature at a time, in one session, in this order.

| Type this                 | Phase      | May it write code?    |
| ------------------------- | ---------- | --------------------- |
| `@architect /analyze`     | Understand | No                    |
| `@architect /create-plan` | Propose    | No                    |
| `@architect /implement`   | Apply      | Only an approved plan |
| `@architect /review`      | Check      | No                    |

A prompt with no slash command is treated as `/analyze` — a stated rule, not an
inference about how the sentence was worded.

### `/analyze`

Answers questions about the repository from the index and symbol graph. It
never concludes "the repo is empty" or "nothing was found" without saying how
many files it was shown: zero matches mean the query missed, not that there is
no code.

Analysis is optional. A developer who knows what they want can go straight to
`/create-plan`; what `/analyze` established in this session carries forward
either way.

### `/create-plan`

Produces a plan with the current contents of every file it proposes to change,
the decisions made so far in this session, the validation commands to run, and
what it could not see. Your corrections outrank its first proposal — say what
is wrong and it redrafts, versioned, so you can point at which version was
approved.

It also names the choices the plan is quietly making — where the work lands,
what was chosen over what, which boundaries hold — each with a **Confirm**
button. Confirming records it against the session so later phases stop
re-asking; not clicking rejects it; saying what is wrong lands in the next
draft. Only what you confirm is recorded, because a decision nobody agreed to
would bind implementation to a choice you never made.

When a new proposal contradicts something you already decided, it says which
decision it replaces and quotes it back:

```text
- **design** — Approvals are recorded per batch after all _(over per-invoice approval)_
  ↳ replaces: _Approvals are recorded per invoice_
  [ Replace with: Approvals are recorded per batch after all ]
```

Confirming supersedes the old one rather than adding a second, contradictory
decision beside it. Both are kept — a change of mind keeps its history — but
only the current one reaches a plan or the dashboard. The decision being
replaced is quoted rather than named by id, because "replaces d2" is not
something you can check, and replacing the wrong decision silently would be
worse than the contradiction it fixes.

If no language model is reachable, it says so rather than showing an empty
list as though the plan made no choices worth confirming.

The plan is deliberately comprehensive. If implementation has to go back and
re-read the repository to act on it, the plan was not a plan — it was a
suggestion, and you are back to paying for context on every turn.

### Approving

**Approve Plan** is a button, not a phrase. The step that authorizes writing
code must not depend on a model reading approval out of "looks good to me", and
silence, a question, or qualified agreement are not approval.

Amending an approved plan requires approving it again. The latest approved
version is the one `/implement` applies.

### `/implement`

Applies the approved plan and nothing beyond it. The plan carries each file's
content hash from plan time, so implementation can tell cheaply whether a file
moved underneath it and stop rather than overwrite work it never saw.

Afterwards the index and symbol graph rebuild, so a later question in the same
session is not answered from a snapshot taken before the edit.

### `/review`

Compares what was built against what was approved. A change the plan did not
mention is a finding, not a detail. It separates what blocks a merge from what
is worth a follow-up, and says what it could not inspect rather than implying
the whole change was reviewed.

---

## Sessions

A session belongs to a workspace and holds one feature: its phase, the
decisions recorded along the way, every plan version, and which version was
implemented. All of it is visible in the **Current work** card at the top of
the Copilot Architect sidebar, so the session's state is never something you
have to reconstruct by scrolling.

It ends when you say so — **End Session**, not a timeout and not a guess from
wording. A session that is still open when you switch branches is parked rather
than deleted, so nothing you approved is lost.

The developer is the final decider on every recorded decision. The model
proposes; you confirm, amend or reject.

---

## Grounding

Answers are checked against the index before you see them. Backticked paths,
`file:line` citations and qualified symbols are verified to exist; anything
that does not resolve is flagged as unconfirmed rather than quietly presented
as fact.

The check is deliberately conservative. A claim made in prose — "the service
retries three times" — is not verified, and the report says so. A false
"unverified" on something real teaches a developer to ignore the warnings, and
a warning nobody reads is worse than no warning.

---

## Using this without the extension

Where policy forbids installing extensions, the MCP server exposes the same
repo intelligence as 27 tools to plain Copilot agent mode, Codex, Claude Code
or any other MCP client:

```bash
npm run cli -- mcp config --path /path/to/repo   # writes .vscode/mcp.json
npm run cli -- instructions generate             # .github/copilot-instructions.md
npm run cli -- mcp --path /path/to/repo          # or run the server directly
```

`instructions generate` also writes `.github/prompts/*.prompt.md` — reusable
prompts that drive the same four phases.

See [MCP_TOOLS.md](MCP_TOOLS.md) for the full tool list.

---

## UI boundary

Business logic lives in `packages/` — core, adapters, indexer, planner,
validator, reviewer, session, grounding, instructions, mcp-server, cli. The VS
Code extension and the web UI are shells: they call those services and render
the result. A rule worth restating because it was violated once, when the
extension re-implemented retrieval instead of calling the indexer, and every
surface started answering the same question differently.
