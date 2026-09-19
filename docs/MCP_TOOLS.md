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

---

## Design Rules

1. MCP tools call existing `packages/` service APIs — no separate business logic in `packages/mcp-server`.
2. Tools do not bypass the safety policy.
3. All tool responses are structured JSON.
4. Secrets are never returned in tool responses.
5. Missing artifacts return a graceful structured response, not a thrown error.
6. The `generate_feature_plan` tool is the only tool that writes artifacts, and it is gated behind an explicit `approved` flag.
7. Multi-repo workspace tools are aware of `.copilot-architect/workspace.json` and operate across all configured repos.

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
@FeatureArchitect Use repo_map and search_repo to find patterns for invoice approval.
Then use generate_plan_context to build a detailed plan.
```

```text
@CodeReviewer Use get_latest_plan and get_latest_validation to review the implementation.
```
