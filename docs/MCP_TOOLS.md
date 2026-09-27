# MCP Tools

## Role

MCP is a first-class integration path. The local MCP server exposes Copilot Architect repo intelligence to agent hosts — including GitHub Copilot Chat in Agent mode — without forcing those hosts to parse CLI text output.

---

## Starting the MCP Server

```bash
# Start against the current repo
npm run cli -- mcp

# Start against a specific repo
npm run cli -- mcp --path /path/to/target-repo
```

### Copilot Chat Integration

Generate a VS Code / GitHub Copilot Chat workspace configuration:

```bash
npm run cli -- mcp config --path /path/to/target-repo
```

This writes `.vscode/mcp.json` with a `copilotArchitect` stdio server entry. It does **not** modify Copilot internals.

**To connect in VS Code:**

1. Open the target repository in VS Code.
2. Run `npm run cli -- mcp config`.
3. Open Command Palette → `MCP: List Servers`.
4. Start `copilotArchitect`.
5. Open GitHub Copilot Chat, switch to **Agent mode**, and enable the Copilot Architect tools when prompted.

---

## Tool Reference

All tools return structured JSON. Missing artifacts return a structured `{ ok: false, reason: "missing" }` response instead of throwing opaque errors.

### Read-Only Tools (Default)

| Tool                        | Arguments                       | Description                                                                                               |
| --------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `repo_map`                  | `startPath?`                    | Return the full `UniversalRepoMap` for the target repo, running analysis if no cached map exists          |
| `workspace_map`             | `startPath?`                    | Return the workspace-level map; generates per-repo maps and merges them                                   |
| `detect_languages`          | `startPath?`                    | Detected languages with confidence scores                                                                 |
| `detect_frameworks`         | `startPath?`                    | Detected frameworks                                                                                       |
| `detect_package_managers`   | `startPath?`                    | Detected package managers                                                                                 |
| `detect_build_commands`     | `startPath?`                    | Build commands from adapters and custom config                                                            |
| `detect_test_commands`      | `startPath?`                    | Test commands from adapters and custom config                                                             |
| `search_repo`               | `query`, `startPath?`, `limit?` | Hybrid search the local index; auto-indexes if none exists. Per-result payload is capped for context cost |
| `search_across_repos`       | `query`, `startPath?`, `limit?` | Search across all workspace repos; results annotated with `repoName` and `repoRole`                       |
| `find_similar_feature`      | `query`, `startPath?`, `limit?` | Search filtered to non-config source files most relevant to a feature description                         |
| `find_impacted_files`       | `featureRequest`, `startPath?`  | Return files likely affected by the described change                                                      |
| `analyze_impact`            | `featureRequest`, `startPath?`  | Return full impact analysis including affected languages, modules, and files                              |
| `analyze_cross_repo_impact` | `featureRequest`, `startPath?`  | Cross-repo impact for multi-repo workspace configs; returns impacted repos and per-repo validation plans  |
| `generate_plan_context`     | `featureRequest`, `startPath?`  | Return planning context (repo map + search results) without writing any artifacts                         |
| `get_validation_commands`   | `startPath?`                    | List safe validation commands from detected and custom config                                             |
| `get_safety_policy`         | `startPath?`                    | Return the active safety policy; falls back to defaults if no `policy.json` exists                        |
| `get_latest_plan`           | `startPath?`                    | Return the contents of `latest-plan.json`; `{ ok: false }` if none exists                                 |
| `get_latest_validation`     | `startPath?`                    | Return the contents of the latest validation report                                                       |
| `get_latest_review`         | `startPath?`                    | Return the contents of the latest review report                                                           |
| `agent_status`              | `startPath?`                    | Return installed agent status from `.github/agents/`                                                      |

### Approval-Gated Tools

| Tool                    | Arguments                                            | Description                                                                                                                    |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `generate_feature_plan` | `featureRequest`, `startPath?`, **`approved: true`** | Write plan artifacts (`latest-plan.json`, `latest-plan.md`) — requires `approved=true`; missing this argument returns an error |

### Report-Generating Tools

Writes an internal report artifact, never a source file — distinct from
both the read-only tools above and the Write Tools below.

| Tool              | Arguments    | Description                                                                                                                                                                                                                             |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate_review` | `startPath?` | Runs a review — git diff against the approved plan contract's expected files (if any), missing-test detection, risk flags, validation evidence — and writes `reviews/latest-review.json`, the same file `get_latest_review` reads back. |

### Plan Contract Tools

A separate plan pipeline from `generate_feature_plan`/`revise_feature_plan`/
`approve_plan` above, and the only one `apply_plan_edit` reads. Where those
three build a `FeaturePlanArtifact` from search-relevance heuristics
(`likelyFilesToModify`, `likelyNewFiles`), these build a real `PlanContract`
— the same one `/create-plan` builds in the VS Code extension — from a file
selection the client has already made itself, by calling `search_repo` /
`get_symbol_graph` and deciding which files actually need to change. The two
pipelines do not interoperate: approving through `approve_plan` does **not**
authorize `apply_plan_edit`, only `approve_plan_contract` does.

| Tool                    | Arguments                                     | Description                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `draft_plan_contract`   | `request`, `files`, `approach?`, `startPath?` | Records a `PlanContract` draft into the session from `files: {path, kind, reason, symbol?, steps?}[]`. An `update`/`delete` naming a path outside the index is dropped and reported in `dropped`, not silently lost; a cited `symbol` that does not check out is flagged in `evidence`, never dropped. Writes only to session state, not source files. |
| `approve_plan_contract` | `version`, `startPath?`                       | Approves a version drafted above, freezing it to `plans/approved/latest.json` — what `apply_plan_edit` will authorize writes against. Per-revision, like `approve_plan`, but a different artifact.                                                                                                                                                     |

### Write Tools

The only tool that writes to a developer's own source files, rather than to
`.copilot-architect/`'s internal artifacts.

| Tool              | Arguments                             | Description                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply_plan_edit` | `relativePath`, `edits`, `startPath?` | Applies search/replace edits to a file the _approved_ plan lists as an `update`. Refuses (writes nothing) if: no plan is approved, the path isn't in it, the plan lists it as `add`/`delete`, the file drifted since the plan was read, or any edit's `search` text doesn't match exactly once. The MCP client's own tool-call approval is the human gate — there is no separate `approved` flag. |

---

## Prompt Reference

Tools are called only when a client's own reasoning decides one is
relevant. A prompt is what makes invoking a phase deterministic, the way
`/create-plan` is a real command in the VS Code extension rather than
something Copilot might get around to. Each of the four registers as
`/mcp.copilot-architect.<name>` in a client that supports MCP prompts, and
resolves to one user-role message: the same role guidance
(`renderRolePrompt` from `@copilot-architect/agents`) the extension's own
model calls use, plus which tools to call, in what order, and the exact
contract those tools expect.

| Prompt        | Arguments  | What its message tells the model to do                                                                                                                             |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `analyze`     | `question` | Call `list_repo_files`/`search_repo`/`get_symbol_graph`, cite `file:line`, then call `verify_claims` on its own answer before presenting it.                       |
| `create-plan` | `request`  | Call `search_repo` to select files, then `draft_plan_contract`; show the draft and stop — do not call `approve_plan_contract` until the developer clearly says to. |
| `implement`   | none       | Call `get_approved_plan_contract`, then `apply_plan_edit` per `update`-kind file; `add`/`delete` have no write tool yet, so it says to tell the developer instead. |
| `review`      | none       | Call `generate_review`, present findings with file/severity/remediation, and offer `resolve_review_finding` for any the developer wants to accept or decline.      |

Every prompt also tells the model to pass `path`, set to the current
project's directory, on every tool call it makes. This matters most for a
client like JetBrains Copilot Chat, which reads one global `mcp.json`
shared across every project rather than a per-project config — see
`docs/KNOWN_LIMITATIONS.md` 4.22 for what this fixes and what is still
unverified about it.

---

## Design Rules

1. MCP tools call existing `packages/` service APIs — no separate business logic in `packages/mcp-server`.
2. Tools do not bypass the safety policy.
3. All tool responses are structured JSON.
4. Secrets are never returned in tool responses.
5. Missing artifacts return a graceful structured response, not a thrown error.
6. `generate_feature_plan` and `generate_review` are the tools that write internal artifacts (plan/review reports); `generate_feature_plan` is gated behind an explicit `approved` flag, `generate_review` is not since it writes only a report, never a decision. `apply_plan_edit` is the only tool that writes to a developer's own source files, gated by plan authorization, plan freshness, and unique-match verification instead — see Write Tools above.
7. Multi-repo workspace tools are aware of `.copilot-architect/workspace.json` and operate across all configured repos.
8. A prompt never calls a tool itself — it only returns text a model reads and acts on in its own next turn. Any tool-calling instruction inside a prompt's message is a request to the model, not a guarantee.

---

## Artifacts

MCP tools read and write the same `.copilot-architect/` artifacts as the CLI. This keeps local evidence portable between tools and agents:

- `repo-map.json` — read and written by `repo_map`
- `index/index.json` — read and written by `search_repo` (auto-indexes if missing)

## Response shaping

`search_repo`, `find_similar_feature`, `generate_plan_context` and
`list_repo_files` return results shaped for a model's context window rather than
the full internal records. Ranking, ordering and which files matched are
unchanged — only per-result payload is capped.

Measured on this repository: one `search_repo` at `limit: 20` fell from ~24,000
to ~4,800 estimated tokens, and `list_repo_files` from ~14,500 to ~4,900. The
savings came from three places — symbols no longer repeat the parent's file
path, previews are capped at 400 characters instead of 4,000, and the inventory
is emitted as one line per file instead of an object whose keys repeat 300
times.

A caller that needs full records calls `IndexingService` directly; the CLI and
planner are unaffected.

- `plans/latest-plan.json` — written by `generate_feature_plan`, read by `get_latest_plan`
- `runs/latest-validation.json` — read by `get_latest_validation`
- `reviews/latest-review.json` — read by `get_latest_review`
- `policy.json` — read by `get_safety_policy`

---

## Example Usage in Copilot Chat

After starting the MCP server and connecting Copilot Chat, use the tools in Agent mode:

```text
Use repo_map and search_repo to find patterns for invoice approval.
Then use generate_plan_context to build a detailed plan.
```

```text
Use get_latest_plan and get_latest_validation to review the implementation.
```

With a client that supports MCP prompts (JetBrains' GitHub Copilot Chat, for
one), the four phases above are real slash commands instead — no need to
spell out which tools to call:

```text
/mcp.copilot-architect.analyze What does OrderService do?
/mcp.copilot-architect.create-plan Add invoice approval workflow
/mcp.copilot-architect.implement
/mcp.copilot-architect.review
```
