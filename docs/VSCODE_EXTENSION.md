# VS Code Extension

The `@copilot-architect/vscode-extension` package is a thin VS Code shell. It contributes a sidebar dashboard, Command Palette commands, and a GitHub Copilot Chat participant (`@architect`).

`@architect` offers four phases — `/analyze`, `/create-plan`, `/implement`,
`/review` — and nothing else. A prompt with no slash command means `/analyze`:
a stated rule rather than an inference about wording. Approving a plan and
ending a session are **commands rendered as buttons**, because the step that
authorizes writing code must not depend on a model reading sentiment out of
"looks good to me". Every response ends with what it was based on.

Setup, MCP and agent commands moved to the Command Palette and dashboard. They
are still available; they are no longer competing front doors.

Repo retrieval calls `IndexingService` directly — the same engine the MCP
tools and CLI use — so every surface answers the same question the same way.
Command workflows delegate to the CLI, which is bundled alongside the
extension and spawned by absolute path. No business logic lives in the
extension itself.

---

## Requirements

**To use it** (the normal case — an installed `.vsix`):

- VS Code 1.90 or newer
- GitHub Copilot installed and signed in, for the `@architect` chat participant

Nothing else. Node.js, npm and a clone of this repository are _not_ required:
the packaged extension carries its own CLI and runs it with the Node runtime
already inside VS Code.

**To develop it:**

- The above, plus Node.js 20.11+ and npm
- The monorepo built locally (`npm run build` from the repo root)

---

## Installing the packaged extension

The extension is not published to the VS Code Marketplace. Build a `.vsix` and
share the file.

```bash
npm run package:vsix      # → dist-vsix/copilot-architect-<version>.vsix
```

Teammates install it from the Extensions view (`...` → **Install from
VSIX…**) or with `code --install-extension <path>`. `docs/INSTALL.md` is the
page they see on the extension's detail view, and is written for someone who
has never seen this repository.

### What is inside the package

| File            | Why it is there                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `extension.cjs` | The extension, bundled. The host requires CommonJS; the sources are ESM, so esbuild converts them. |
| `cli.mjs`       | The whole CLI, bundled. Command workflows spawn it by absolute path.                               |

The CLI is packaged rather than resolved because `npm run cli --` only works
inside this monorepo. On a teammate's machine there is no `package.json` with
a `cli` script, so a packaged extension that shelled out to npm could not run
a single command. It is spawned as `process.execPath` with
`ELECTRON_RUN_AS_NODE=1` — VS Code's own binary, run as Node — so the user
does not need Node on their `PATH` either.

`npm run bundle:extension` produces the bundle alone, without packaging.

---

## Running from source (development)

**The repo includes `.vscode/launch.json` and `.vscode/tasks.json` which wire up F5 automatically.**

1. Open the Copilot Architect monorepo folder in VS Code.
2. Press `F5` (or **Run > Start Debugging**).
   - VS Code runs `npm run build` automatically (the pre-launch task).
   - A new **Extension Development Host** window opens with the extension active.
3. In the new window, the Copilot Architect icon appears in the activity bar.

In this mode there is no bundle beside the extension, so it falls back to the
monorepo's built CLI at `packages/cli/dist/index.js`. That fallback is the only
difference between a development run and an installed one.

### If `F5` shows the Command Palette or a debugger picker

VS Code opened a different folder. Confirm the folder in the Explorer sidebar
is the repo root — `.vscode/` must be at the root for the launch config to be
picked up.

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

For analysis that spans several repos, register them once from the primary
window. From an installed extension use **More Actions → Scan & Register
Sub-repos**, and point it at the folder holding the repos; it registers every
sub-directory that looks like one.

From a monorepo clone the same thing is available as CLI commands, which take
the repos one at a time:

```bash
npm run cli -- workspace init
npm run cli -- workspace add --path /path/to/service-a --name service-a
npm run cli -- workspace add --path /path/to/service-b --name service-b
```

Either way, `Build Index` and `@architect` then query across all registered
repos at once.

---

## Output Channel

All CLI commands write their output to the **Copilot Architect** output channel (`View > Output`, then select "Copilot Architect" from the dropdown). This is useful for debugging command failures or reviewing full CLI output that was trimmed in the chat panel.

---

## Troubleshooting

**Commands do nothing / fail silently**

- Check the **Copilot Architect** output channel for error details. It prints
  the exact command line that ran, which you can paste into a terminal.
- Running from source: confirm `npm run build` has been run after any source
  changes, and run `npm run cli -- doctor` to verify the environment.

**`@architect` does not appear in Copilot Chat**

- Ensure the GitHub Copilot extension is installed and you are signed in.
- Reload VS Code after loading the extension for the first time (`Cmd+Shift+P` → `Developer: Reload Window`).
- Confirm VS Code version is 1.90 or newer.

**"Open Repo in New Window" opens but commands fail**

- If the target repo has never been initialized, run `Analyze Repo` first before other commands.
- Running from source: the new window needs the same Node.js environment.
  Check `npm run cli -- doctor` in a terminal inside it. An installed
  extension carries its own runtime and is unaffected.

**MCP server does not start**

- Check that port conflicts are not blocking stdio. The MCP server uses stdio, not a TCP port.
- Use `Copilot Architect: Start MCP` which opens a dedicated VS Code terminal for the process.
- See [MCP_TOOLS.md](MCP_TOOLS.md) for full MCP setup details.
