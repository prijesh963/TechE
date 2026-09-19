# VS Code Extension

The `@copilot-architect/vscode-extension` package is a thin VS Code shell. It contributes a sidebar dashboard, Command Palette commands, and a GitHub Copilot Chat participant (`@architect`).

Repo retrieval calls `IndexingService` directly — the same engine the MCP tools and CLI use — so every surface answers the same question the same way. Command workflows still delegate to `npm run cli -- ...`. No business logic lives in the extension itself.

---

## Requirements

- VS Code 1.90 or newer
- Node.js 20.11+ and `npm` (same as the CLI)
- The Copilot Architect monorepo built locally (`npm run build` from the repo root)
- GitHub Copilot extension installed and signed in (for Chat integration only)

---

## Loading the Extension

The extension is not published to the VS Code Marketplace. Load it from source using the VS Code Extension Development Host.

**The repo includes `.vscode/launch.json` and `.vscode/tasks.json` which wire up F5 automatically.**

### Steps

1. Open the Copilot Architect monorepo folder in VS Code (`code /path/to/Copilot_Assistant`).
2. Press `F5` (or **Run > Start Debugging**).
   - VS Code runs `npm run build` automatically (the pre-launch task).
   - A new **Extension Development Host** window opens with the extension active.
3. In the new window, the Copilot Architect icon appears in the activity bar. You are ready to use it.

### What happens under the hood

- `launch.json` tells VS Code to start an `extensionHost` process with `--extensionDevelopmentPath` pointing at `packages/vscode-extension`.
- `tasks.json` defines the `build` task that runs `npm run build` before launch so `dist/index.js` is always up to date.
- The Extension Development Host is a separate VS Code window that behaves like a normal VS Code but loads your local extension.

### If `F5` still shows the Command Palette or a debugger picker

This means VS Code opened a different folder (not the Copilot Architect repo root). Confirm the folder shown in the Explorer sidebar is the repo root (`Copilot_Assistant/`). The `.vscode/` folder must be at the root for launch config to be picked up.

Alternatively, package the extension with `vsce` and install the `.vsix` once it is available as an internal artifact.

---

## Sidebar Dashboard

After loading, the Copilot Architect icon appears in the VS Code activity bar. Click it to open the **Copilot Architect** sidebar panel. The panel shows:

| Section              | Content                                                  |
| -------------------- | -------------------------------------------------------- |
| Repo summary         | Active workspace root path                               |
| Languages/frameworks | Populated after `Analyze Repo` runs                      |
| Plans                | Path to `.copilot-architect/plans/latest-plan.json`      |
| Validation runs      | Path to `.copilot-architect/runs/latest-validation.json` |
| Review reports       | Path to `.copilot-architect/reviews/latest-review.json`  |
| Agent status         | Path to `.github/agents/`                                |
| MCP status           | `stopped` / `starting` / `running`                       |
| Last command         | The most recently run CLI command and its exit code      |

The **Refresh** button (↺) in the panel title bar refreshes the dashboard without running a command.

---

## Command Palette Commands

Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and type `Copilot Architect` to filter all available commands.

### Repo Analysis

| Command                           | CLI equivalent | What it does                                                                                        |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `Copilot Architect: Analyze Repo` | `analyze`      | Detects languages, frameworks, entry points, and routes. Writes `.copilot-architect/repo-map.json`. |
| `Copilot Architect: Build Index`  | `index`        | Builds a searchable local file index. Writes `.copilot-architect/index/index.json`.                 |

### Planning

| Command                            | CLI equivalent     | What it does                                                                                         |
| ---------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `Copilot Architect: Generate Plan` | `plan "<request>"` | Prompts for a feature description, then generates a plan artifact under `.copilot-architect/plans/`. |

### Validation and Review

| Command                       | CLI equivalent                             | What it does                                                                                              |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `Copilot Architect: Validate` | `validate`                                 | Runs build, test, lint, and format commands. Writes a validation report under `.copilot-architect/runs/`. |
| `Copilot Architect: Review`   | `review --plan latest --validation latest` | Generates a review report from the latest git diff. Writes under `.copilot-architect/reviews/`.           |

### Agents and Instructions

| Command                                    | CLI equivalent          | What it does                                                 |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------ |
| `Copilot Architect: Install Agents`        | `agents install`        | Generates `.github/agents/*.agent.md` Copilot agent files.   |
| `Copilot Architect: Generate Instructions` | `instructions generate` | Writes `.github/copilot-instructions.md` from repo analysis. |

### MCP Server

| Command                        | CLI equivalent | What it does                                                                                                  |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `Copilot Architect: Start MCP` | `mcp`          | Starts the local MCP stdio server in a VS Code terminal. Copilot Chat can then query repo context through it. |

### Dashboard

| Command                                | What it does                                |
| -------------------------------------- | ------------------------------------------- |
| `Copilot Architect: Open Dashboard`    | Opens the dashboard as a full editor panel. |
| `Copilot Architect: Refresh Dashboard` | Refreshes the sidebar dashboard.            |

---

## Open Repo in New Window

```
Copilot Architect: Open Repo in New Window
```

Use this command to analyze any repository on your machine — not just the one currently open in VS Code.

**How it works:**

1. Run `Copilot Architect: Open Repo in New Window` from the Command Palette.
2. A folder picker dialog opens. Select any directory (it does not need to contain a Copilot Architect setup).
3. VS Code opens that folder in a **new window** with the extension already active.
4. In the new window, run `Analyze Repo`, `Build Index`, or any other command — they all operate on the newly opened repo.

**Artifacts are written inside the target repo**, not inside the Copilot Architect source directory:

```
/path/to/other-repo/
  .copilot-architect/
    repo-map.json
    index/
    plans/
    runs/
    reviews/
```

This command is also available as a link at the top of the sidebar dashboard action bar.

---

## GitHub Copilot Chat — `@architect`

When GitHub Copilot is installed and signed in, the extension registers a chat participant named `@architect`. Use it directly inside the **Copilot Chat** panel without leaving the editor.

### Slash Commands

Type `@architect` followed by a slash command:

| Command                          | What it does                                                            |
| -------------------------------- | ----------------------------------------------------------------------- |
| `@architect /analyze`            | Detect languages, frameworks, and entry points in the current workspace |
| `@architect /index`              | Build a searchable local file index                                     |
| `@architect /plan <description>` | Generate a feature implementation plan                                  |
| `@architect /validate`           | Run build, test, lint, and format commands                              |
| `@architect /review`             | Generate a review report from the latest git diff                       |
| `@architect /search <query>`     | Search the repo index for a keyword or symbol                           |
| `@architect /diagnostics`        | Report repo readiness and analysis signals                              |
| `@architect /agents`             | Install custom Copilot agent templates into `.github/agents/`           |
| `@architect /instructions`       | Generate `.github/copilot-instructions.md`                              |
| `@architect /help`               | Show all available commands                                             |

### Plain-text shortcut

Any message sent to `@architect` without a slash command is treated as a feature plan request:

```
@architect add a payment webhook handler with retry logic
```

This is equivalent to running `plan "add a payment webhook handler with retry logic"`.

### Examples

```
@architect /analyze
@architect /plan add invoice approval workflow with email notifications
@architect /search authentication middleware
@architect /validate
@architect /review
```

### How output is returned

Each command runs the CLI in the background and streams the result back into the chat as a code block. If the command fails, the error output is shown separately. Long outputs are trimmed to the last 3000 characters.

---

## Using the Extension with Multiple Repositories

There are three approaches depending on your workflow:

### Approach 1 — Open Repo in New Window (interactive)

Use `Copilot Architect: Open Repo in New Window` from the Command Palette. Picks a folder and opens it in a new VS Code window. All extension commands in that window target the new repo.

### Approach 2 — `code` CLI (from terminal)

```bash
code /path/to/other-repo
```

VS Code opens the folder and the extension activates against it automatically.

### Approach 3 — Multi-repo workspace (cross-repo analysis)

For analysis that spans several repos, set up a workspace config in the primary window:

```bash
npm run cli -- workspace init
npm run cli -- workspace add --path /path/to/service-a --name service-a
npm run cli -- workspace add --path /path/to/service-b --name service-b
```

Then use `Build Index` and `@architect /search` to query across all registered repos simultaneously.

---

## Output Channel

All CLI commands write their output to the **Copilot Architect** output channel (`View > Output`, then select "Copilot Architect" from the dropdown). This is useful for debugging command failures or reviewing full CLI output that was trimmed in the chat panel.

---

## Troubleshooting

**Commands do nothing / fail silently**

- Check the **Copilot Architect** output channel for error details.
- Run `npm run cli -- doctor` in the integrated terminal to verify the environment.
- Confirm `npm run build` has been run after any source changes.

**`@architect` does not appear in Copilot Chat**

- Ensure the GitHub Copilot extension is installed and you are signed in.
- Reload VS Code after loading the extension for the first time (`Cmd+Shift+P` → `Developer: Reload Window`).
- Confirm VS Code version is 1.90 or newer.

**"Open Repo in New Window" opens but commands fail**

- The new window needs the same Node.js environment. Check `npm run cli -- doctor` in a terminal inside the new window.
- If the target repo has never been initialized, run `Analyze Repo` first before other commands.

**MCP server does not start**

- Check that port conflicts are not blocking stdio. The MCP server uses stdio, not a TCP port.
- Use `Copilot Architect: Start MCP` which opens a dedicated VS Code terminal for the process.
- See [MCP_TOOLS.md](MCP_TOOLS.md) for full MCP setup details.
