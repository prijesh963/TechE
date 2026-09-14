# Plan Lifecycle Design

Design for plan revision, explicit approval, and review-finding disposition.

Source: feedback from Prijesh Gopalapillai (2026-07-23) on the agent workflow:

1. Feature Architect — multiple conversation turns must revise the plan, not regenerate it.
2. Approve Plan — approval must save the latest plan as an approved artifact.
3. Code Reviewer output — must be able to revise the plan, and to decline review comments.
4. `/Create unit test cases` — a prompt/slash command for producing unit tests.

## Problem Statement

All three workflow issues share one root cause: **a plan is a single overwritten file with no revision history, no persisted approval state, and no link back from review findings.**

| Concern         | Current location                                       | Gap                                                                                                                |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Plan generation | `packages/planner/src/feature-planning-service.ts:53`  | `createPlan` rebuilds the plan from a single `request` string and overwrites `latest-plan.json` / `latest-plan.md` |
| Plan status     | `packages/planner/src/feature-planning-service.ts:208` | Every plan is written with `status: "draft"`. Nothing ever transitions it to `"approved"`                          |
| Approval        | `packages/mcp-server/src/tools.ts:243`                 | `approved` is a call argument, validated then discarded — never written into the artifact                          |
| Handoff gate    | `packages/planner/src/handoff-service.ts:53`           | Trusts the `--approve` flag; never asks the plan whether _it_ was approved                                         |
| Review findings | `packages/shared/src/models.ts:354`                    | `ReviewFinding` has no `id` and no state, and is regenerated from scratch on every `review` run                    |
| Test prompt     | `packages/instructions/src/index.ts:220`               | `promptDefinitions` covers plan / implement / review / debug — no test prompt exists                               |

`PlanStatus` (`packages/shared/src/models.ts:15`) already declares `"draft" | "approved" | "in-progress" | "completed"`. The vocabulary exists; the state machine that drives it does not.

## Target Lifecycle

```text
generate_feature_plan            revise_feature_plan (xN)       approve_plan
        │                                 │                          │
        ▼                                 ▼                          ▼
   rev 1 (draft) ──── feedback ──── rev N (draft) ──── approval ──── rev N (approved)
                          ▲                                            │
                          │                                            ▼
                          │                                       handoff gate
                   accepted findings                                   │
                          │                                            ▼
                          └────── resolve_review_finding ◄──────── code review
                                    (accept / decline)
```

Declining a finding records a reason and closes it. Accepting a blocking finding opens a new plan revision, which re-enters the approval gate.

---

## Solutions

This section summarises, per problem statement, what must **change** in existing code and what must be **added**. Sections 1–4 below carry the full design for each.

### P1 — Feature Architect: multiple conversation turns must revise the plan

**Root cause.** The only save path regenerates the whole plan from a single `request` string, so each save discards everything the human said in earlier turns.

**Fix in one line.** Make revision a first-class concept and give the agent an edit-in-place tool, so saving no longer means rebuilding.

| Needs to change             | File                                                   | Change                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeaturePlanArtifact`       | `packages/planner/src/models.ts:39`                    | Add `revision`, `supersedes`, `revisions[]`                                                                                                                       |
| `generate_feature_plan`     | `packages/mcp-server/src/tools.ts:243`                 | Becomes revision-1-only; errors with a pointer to `revise_feature_plan` when a draft exists, unless `restart=true`                                                |
| `createPlan` artifact paths | `packages/planner/src/feature-planning-service.ts:838` | Write to `drafts/<planId>/rev-<n>.*` instead of overwriting `latest-plan.*`                                                                                       |
| FeatureArchitect `tools`    | `packages/agents/src/index.ts:117`                     | Add `revise_feature_plan`, `approve_plan`                                                                                                                         |
| FeatureArchitect steps 7–8  | `packages/agents/src/index.ts:153`                     | Step 7 calls `revise_feature_plan` per feedback round; step 8 calls `approve_plan`. State explicitly that re-calling `generate_feature_plan` discards prior turns |

| Needs to be added                                  | Where                                              |
| -------------------------------------------------- | -------------------------------------------------- |
| `PlanRevisionEntry` interface                      | `packages/planner/src/models.ts`                   |
| `FeaturePlanningService.revisePlan()`              | `packages/planner/src/feature-planning-service.ts` |
| `revise_feature_plan` MCP tool (`readOnly: false`) | `packages/mcp-server/src/tools.ts`                 |
| `drafts/<planId>/` artifact directory              | `.copilot-architect/plans/`                        |

**Why the `generate_feature_plan` guard matters.** Without it the model keeps reaching for the tool it already knows, and feedback keeps getting lost. The guard — not the new tool — is what actually fixes P1.

### P2 — Approve Plan must save the latest plan

**Root cause.** Approval is a transient call argument, not state. `PlanStatus` already has an `"approved"` member but nothing writes it, and the handoff gate never consults the plan.

**Fix in one line.** Split _save_ from _approve_, record approval against a specific revision, and make the plan's own state the authority for the handoff gate.

| Needs to change           | File                                                   | Change                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeaturePlanArtifact`     | `packages/planner/src/models.ts:39`                    | Add `approval?: PlanApproval`                                                                                                                               |
| Plan status write         | `packages/planner/src/feature-planning-service.ts:208` | Stays `"draft"` on generate/revise; only `approve_plan` sets `"approved"`                                                                                   |
| Handoff gate              | `packages/planner/src/handoff-service.ts:53`           | Add a real check: reject unless `plan.status === "approved"` and `plan.approval` exists. `--approve` stays as operator intent; plan state becomes authority |
| `get_latest_plan`         | `packages/mcp-server/src/tools.ts:277`                 | Return `status`, `revision`, `approval` so downstream agents can refuse a draft                                                                             |
| FeatureImplementer step 1 | `packages/agents/src/index.ts:202`                     | Stop on _unapproved_, not just on _missing_                                                                                                                 |

| Needs to be added                                               | Where                              |
| --------------------------------------------------------------- | ---------------------------------- |
| `PlanApproval` interface                                        | `packages/planner/src/models.ts`   |
| `approve_plan` MCP tool (`readOnly: false`)                     | `packages/mcp-server/src/tools.ts` |
| `plan approve` / `plan revisions` / `plan show` CLI subcommands | `packages/cli/src/index.ts:588`    |
| `approved/<planId>-rev<n>-plan.json` frozen copies              | `.copilot-architect/plans/`        |

**Key constraint.** `approve_plan` takes `revision` as a **required** argument. Approving "whatever is newest" reintroduces the exact ambiguity this section removes.

### P3 — Code Reviewer output: revise plan, decline review comments

**Root cause.** Findings have no identity and no state, so they are rebuilt from scratch on every run — a declined comment reappears on the next review. CodeReviewer also has no route back to the plan.

**Fix in one line.** Give findings stable IDs and a durable disposition record, and add a review → plan-revision path that re-enters the approval gate.

| Needs to change           | File                                 | Change                                                                                              |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `ReviewFinding`           | `packages/shared/src/models.ts:354`  | Add `id`, `status`, `disposition?`                                                                  |
| `buildFindings`           | `packages/reviewer/src/index.ts:560` | Compute the stable `id` for each finding                                                            |
| `ReviewService.review`    | `packages/reviewer/src/index.ts:66`  | Load `dispositions.json` and merge by id after `buildFindings`                                      |
| `reviewerPrompt` builder  | `packages/reviewer/src/index.ts:87`  | Exclude declined findings so the agent stops re-raising them                                        |
| Review markdown renderer  | `packages/reviewer/src/index.ts:506` | Render a separate **Declined (with reason)** section; declined findings no longer count as blocking |
| CodeReviewer `tools`      | `packages/agents/src/index.ts:230`   | Add `resolve_review_finding`, `revise_feature_plan`                                                 |
| CodeReviewer `handoffs`   | `packages/agents/src/index.ts:240`   | Add a third handoff, `"Revise Plan" → FeatureArchitect`                                             |
| CodeReviewer instructions | `packages/agents/src/index.ts:258`   | Add a triage step: per finding, accept (fold into plan) or decline (with reason)                    |
| `validateAgentText`       | `packages/agents/src/index.ts:958`   | Assert `CodeReviewer.agent.md` contains `agent: FeatureArchitect`                                   |

| Needs to be added                                     | Where                              |
| ----------------------------------------------------- | ---------------------------------- |
| `FindingDisposition` interface                        | `packages/shared/src/models.ts`    |
| `resolve_review_finding` MCP tool (`readOnly: false`) | `packages/mcp-server/src/tools.ts` |
| `reviews/dispositions.json` durable record            | `.copilot-architect/`              |

**Design note.** `dispositions.json` is the durable record; individual review reports stay disposable snapshots. Decline requires a non-empty `reason` — that field is the audit trail, and an unreasoned decline should be rejected at the tool boundary rather than defaulted.

### P4 — `/Create unit test cases`

**Root cause.** No test prompt exists, and the agent that would serve it cannot write files.

**Fix in one line.** Add the missing prompt definition and close TestPlanner's tooling gap so the command produces tests rather than a plan for tests.

| Needs to change           | File                                     | Change                                                                              |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `promptDefinitions`       | `packages/instructions/src/index.ts:220` | Add a fifth entry, `copilot-architect-test`                                         |
| TestPlanner `tools`       | `packages/agents/src/index.ts:283`       | Add `edit` (option A), or end the prompt in a FeatureImplementer handoff (option B) |
| TestPlanner `safetyRules` | `packages/agents/src/index.ts:306`       | Under option A, restrict writes to test files only                                  |

| Needs to be added                              | Where              |
| ---------------------------------------------- | ------------------ |
| `copilot-architect-test.prompt.md` (generated) | `.github/prompts/` |

**Recommendation.** Option A. `/Create unit test cases` reads as a single-step command that yields test files; option B turns it into a two-agent flow.

---

## 1. Plan Revisions (Feature Architect, multi-turn)

### Problem

The FeatureArchitect agent is instructed to run a feedback loop (`packages/agents/src/index.ts:153`) and then perform a "MANDATORY SAVE" (`packages/agents/src/index.ts:154`). But the only save path regenerates the plan from the request string. Refinements from conversation turns 2–5 exist only in the model's context; the moment `generate_feature_plan` runs, the on-disk plan is rebuilt from the original request and every refinement is silently dropped.

### Schema changes

Extend `FeaturePlanArtifact` in `packages/planner/src/models.ts:39`:

```ts
export interface FeaturePlanArtifact extends FeaturePlan {
  // ...existing fields
  revision: number;
  supersedes?: string; // artifact id of the previous revision
  revisions: PlanRevisionEntry[];
}

export interface PlanRevisionEntry {
  revision: number;
  at: string; // ISO timestamp
  source: "initial" | "human-feedback" | "code-review";
  feedback: string; // verbatim, never summarised
  changedSections: string[]; // e.g. ["implementationSteps", "testStrategy"]
  reviewFindingIds?: string[]; // set when source === "code-review"
}
```

`status` reuses the existing `PlanStatus` union — no new type needed.

### New tool: `revise_feature_plan`

Registered in `packages/mcp-server/src/tools.ts` alongside `generate_feature_plan`:

| Field      | Type                                | Notes                             |
| ---------- | ----------------------------------- | --------------------------------- |
| `path`     | `string?`                           | standard                          |
| `planId`   | `string?`                           | defaults to latest draft          |
| `feedback` | `string`                            | required, stored verbatim         |
| `sections` | `object?`                           | partial override of plan sections |
| `source`   | `"human-feedback" \| "code-review"` | defaults to `human-feedback`      |

Behaviour — it **edits, it does not regenerate**:

1. Load the current draft revision.
2. Apply `sections` as a shallow merge over the existing plan.
3. Increment `revision`, append a `PlanRevisionEntry`, set `supersedes`.
4. Re-render markdown and write the new revision.

Backed by `FeaturePlanningService.revisePlan(options)` in `packages/planner/src/feature-planning-service.ts`.

### Artifact layout

```text
.copilot-architect/plans/
  drafts/<planId>/rev-1.json
  drafts/<planId>/rev-2.json          # nothing is ever destroyed
  drafts/<planId>/rev-2.md
  approved/<planId>-rev2-plan.json    # frozen at approval time
  latest-plan.json                    # promoted approved revision
  latest-plan.md
```

### Guard against accidental regeneration

`generate_feature_plan` becomes revision-1-only. If a draft already exists for the active plan session, it returns:

```json
{
  "ok": false,
  "error": "A draft plan already exists at revision 3. Use revise_feature_plan to incorporate feedback, or pass restart=true to discard the draft."
}
```

This is the change that actually stops feedback loss — without it, the model will keep reaching for the tool it already knows.

### Agent changes

In `packages/agents/src/index.ts`, FeatureArchitect:

- Add `revise_feature_plan` and `approve_plan` to `tools` (`packages/agents/src/index.ts:117`).
- Rewrite step 7 (`:153`) to call `revise_feature_plan` once per feedback round, and to state that re-calling `generate_feature_plan` discards prior turns.
- Rewrite step 8 (`:154`) to call `approve_plan` rather than treating `generate_feature_plan(approved=true)` as approval.

---

## 2. Approve Plan (save the latest plan)

### Problem

Save and approve are currently the same call, so:

- a saved-but-unapproved draft cannot exist;
- nothing records _which revision_ a human approved;
- `HandoffService.generate` (`packages/planner/src/handoff-service.ts:53`) only checks its own `--approve` flag, so an unapproved plan can still be handed to FeatureImplementer.

### Schema changes

```ts
export interface PlanApproval {
  approvedAt: string;
  approvedBy: string;
  revision: number;
  note?: string;
}
```

Added to `FeaturePlanArtifact` as `approval?: PlanApproval`.

### New tool: `approve_plan`

| Field        | Type      | Notes                                                           |
| ------------ | --------- | --------------------------------------------------------------- |
| `path`       | `string?` | standard                                                        |
| `planId`     | `string?` | defaults to latest draft                                        |
| `revision`   | `number`  | required — approval is per-revision, never "whatever is newest" |
| `approvedBy` | `string`  | required                                                        |
| `note`       | `string?` | optional rationale                                              |

Behaviour:

1. Load `drafts/<planId>/rev-<revision>.json`; error if that revision does not exist.
2. Stamp `approval`, set `status: "approved"`.
3. Freeze an immutable copy at `approved/<planId>-rev<n>-plan.json`.
4. Promote **that exact revision** to `latest-plan.json` / `latest-plan.md`.

Marked `readOnly: false` in the tool definition.

### Handoff gate

Add a real check in `packages/planner/src/handoff-service.ts:53` — after reading the plan, reject unless `plan.status === "approved"` and `plan.approval` is present:

```ts
if (plan.status !== "approved" || !plan.approval) {
  throw new Error(
    `Plan ${plan.id} is at status "${plan.status}". Run approve_plan (or "cli plan approve") before generating a handoff.`
  );
}
```

The `--approve` flag stays as the operator's intent signal; the plan's own state becomes the authority.

### Tool and CLI surface

- `get_latest_plan` (`packages/mcp-server/src/tools.ts:277`) returns `status`, `revision`, and `approval` so FeatureImplementer can refuse to build a draft.
- New CLI subcommands in `packages/cli/src/index.ts` next to the existing `plan` handler (`:588`):
  - `plan approve --revision <n> --by <name> [--note <text>]`
  - `plan revisions` — list revisions with status and approval state
  - `plan show --revision <n>`

### Agent changes

FeatureImplementer step 1 (`packages/agents/src/index.ts:202`) currently stops only when the plan is _missing_. Extend it to stop when the plan is present but unapproved, and add `approve_plan` awareness to its safety rules.

---

## 3. Review Finding Disposition (revise plan / decline comments)

### Problem

Findings are stateless (`packages/shared/src/models.ts:354`) and rebuilt on every run by `buildFindings` (`packages/reviewer/src/index.ts:87`). "Decline this comment" is therefore not expressible — the next `review` run resurrects the identical finding. And CodeReviewer's routing (step 6, `packages/agents/src/index.ts:264`) offers only Debugger or TestPlanner; there is no path back to the plan.

### Schema changes

Extend `ReviewFinding` in `packages/shared/src/models.ts:354`:

```ts
export interface ReviewFinding {
  id: string; // stable across runs
  severity: Severity;
  title: string;
  filePath?: string;
  line?: number;
  details: string;
  status: "open" | "accepted" | "declined" | "resolved";
  disposition?: FindingDisposition;
}

export interface FindingDisposition {
  decidedAt: string;
  decidedBy: string;
  reason: string; // required — this is the audit trail
  planRevision?: number; // set when accepted and folded into a plan revision
}
```

**Finding identity.** `id` is a stable hash of `severity + title + filePath + rule`, deliberately excluding `line` and `details` so a finding survives unrelated edits that shift line numbers. Computed in `buildFindings` (`packages/reviewer/src/index.ts:560`).

### New tool: `resolve_review_finding`

| Field       | Type                    | Notes                                   |
| ----------- | ----------------------- | --------------------------------------- |
| `path`      | `string?`               | standard                                |
| `findingId` | `string`                | required                                |
| `decision`  | `"accept" \| "decline"` | required                                |
| `reason`    | `string`                | **required for decline** — reject empty |
| `decidedBy` | `string`                | required                                |

Writes to `.copilot-architect/reviews/dispositions.json`, keyed by finding id. This file is the durable record; individual review reports remain disposable snapshots.

### Re-hydration

`ReviewService.review` (`packages/reviewer/src/index.ts:66`) loads `dispositions.json` after `buildFindings` and merges by id, so that:

- declined findings render in a separate **Declined (with reason)** section and no longer count as blocking;
- accepted findings carry their `planRevision` link;
- genuinely new findings appear as `open`.

The `reviewerPrompt` builder (`packages/reviewer/src/index.ts:87`) must exclude declined findings so the agent stops re-raising them.

### Feeding accepted findings back into the plan

Accepted blocking findings call `revise_feature_plan({ source: "code-review", reviewFindingIds: [...] })`, producing a new draft revision that must go through `approve_plan` again. This closes the loop: review comments cannot silently change an approved plan.

Add to the CodeReviewer definition (`packages/agents/src/index.ts:224`):

- `resolve_review_finding` and `revise_feature_plan` in `tools` (`:230`);
- a third handoff, `"Revise Plan" → FeatureArchitect`, alongside the existing Debugger and TestPlanner handoffs (`:240`);
- a step 7 in `instructions` covering triage: for each finding, accept (fold into the plan) or decline (record a reason);
- a safety rule: declining a finding requires a stated reason and never silently drops a blocking finding.

`validateAgentText` (`packages/agents/src/index.ts:958`) enforces required handoffs per agent file. Add the matching assertion for `agent: FeatureArchitect` in `CodeReviewer.agent.md`.

---

## 4. `/Create unit test cases` Prompt

### Problem

`promptDefinitions` (`packages/instructions/src/index.ts:220`) defines four prompts — plan, implement, review, debug. There is no test prompt, despite `TestPlanner` existing as an agent (`packages/agents/src/index.ts:278`).

Separately, **TestPlanner has no `edit` tool** (`packages/agents/src/index.ts:283`), so it can only _plan_ tests — it cannot write them. A `/Create unit test cases` command that produces no files would not meet the request.

### Changes

Add a fifth prompt definition:

```ts
{
  id: "copilot-architect-test",
  fileName: "copilot-architect-test.prompt.md",
  name: "copilot-architect-test",
  description: "Create unit test cases for a feature or changed files.",
  agent: "TestPlanner",
  argumentHint: "feature, file, or symbol to cover",
  body: [
    "@TestPlanner Create unit test cases for ${input:target:feature, file, or symbol to cover}.",
    "Call detect_test_commands and find_impacted_files first, and match the existing test file naming and assertion style.",
    "For each test state: file path, test name, what it validates, and the command to run it.",
    "Write the tests with the edit tool, then run the detected test command and report the result."
  ]
}
```

Then resolve the tooling gap — one of:

- **(A, recommended)** add `edit` to TestPlanner's `tools` and a safety rule limiting writes to test files only; or
- **(B)** keep TestPlanner read-only and end the prompt with a handoff to FeatureImplementer to write the tests.

Option A keeps `/Create unit test cases` a single-step command, which is what the request implies.

---

## Implementation Order

Sections 1 and 2 share the same schema change and should land together; section 3 builds on the revision machinery from section 1; section 4 is independent.

| Step | Scope                                                                    | Tests                                                                 |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1    | `FeaturePlanArtifact` revision fields, `revisePlan`, draft layout        | `tests/planner.test.ts`                                               |
| 2    | `approve_plan`, handoff gate, `plan approve` CLI                         | `tests/planner.test.ts`, `tests/handoff.test.ts`, `tests/cli.test.ts` |
| 3    | Finding ids, `dispositions.json`, `resolve_review_finding`, re-hydration | `tests/reviewer.test.ts`                                              |
| 4    | Agent definition and instruction updates for all of the above            | `tests/agents.test.ts`                                                |
| 5    | Test prompt + TestPlanner `edit` tool                                    | `tests/instructions.test.ts`                                          |

New MCP tools must also be added to the expected-tool-name assertions in `tests/mcp-server.test.ts`.

## Compatibility

- `CURRENT_SCHEMA_VERSION` must be bumped; the new plan fields are additive.
- Plans written before this change have no `revision` / `revisions` — readers treat a missing `revision` as `1` and a missing `revisions` as `[]`.
- Findings written before this change have no `id`; they are re-keyed on the next `review` run, and pre-existing dispositions do not apply retroactively.
- Existing `status: "draft"` plans stay draft and must be explicitly approved before a handoff can be generated. This is a deliberate breaking change to the handoff path — document it in `CHANGELOG.md` and `docs/UPGRADE_GUIDE.md`.

## Open Questions

- Should `approve_plan` require the approver to be a different identity than the plan author, or is single-operator approval acceptable for the internal rollout?
- Should declined findings expire — e.g. re-open automatically if the underlying file changes again after the decline?
- Should a plan revision triggered by code review auto-inherit the previous approval when the change is confined to `testStrategy`, or always require re-approval?
