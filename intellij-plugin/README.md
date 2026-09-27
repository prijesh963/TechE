# Copilot Architect — IntelliJ

Points GitHub Copilot Chat's Model Context Protocol connection at Copilot
Architect's own local MCP server (`packages/mcp-server` in the main
repository), so `/mcp.copilot-architect.analyze`, `create-plan`,
`implement`, and `review` work in IntelliJ the way `/analyze`,
`/create-plan`, `/implement`, and `/review` already do in the VS Code
extension — same repo intelligence, same plan-authorization discipline,
same write guardrails.

## Two modules, on purpose

- **`:core`** — Node discovery, the global `mcp.json` merge, CLI resource
  extraction, and the orchestration over all three. Plain Kotlin/JVM, no
  IntelliJ Platform dependency. Fully built and tested in any environment,
  including one with no access to JetBrains' own package hosts.
- **`:plugin`** — the IntelliJ Platform shell: a startup notification and a
  Tools-menu action, both calling straight into `:core`. Nothing else —
  every real decision this plugin makes lives in `:core`.

This plugin has **no repo-analysis logic of its own**. Everything —
indexing, planning, grounding, applying an approved edit — already exists,
already tested, in the main repository's `packages/`. This plugin's only
job is making sure GitHub Copilot Chat can find it.

## Requires Node.js 20.11+

Unlike the VS Code extension, which spawns its bundled CLI with the host's
own Node runtime (`process.execPath` — VS Code itself is Node-based),
IntelliJ is a JVM application with no Node runtime of its own. This plugin
does not bundle one either. If Node isn't found on this machine, setup
fails with a clear message and a link to nodejs.org rather than doing
anything partial.

## What it actually does

1. Looks for a real, executable `node` on this machine (PATH, plus a few
   common install locations PATH sometimes misses on macOS) and checks its
   version.
2. Extracts the bundled CLI (built from `packages/cli` in the main
   repository) to this IDE installation's own cache directory.
3. Merges a `copilotArchitect` entry into GitHub Copilot Chat's **global**
   MCP config — `~/.config/github-copilot/intellij/mcp.json` on
   Linux/macOS, `%APPDATA%\github-copilot\intellij\mcp.json` on Windows —
   preserving every other server entry and key already there. An existing
   file that fails to parse is backed up, never silently discarded.

Offered once per developer via a startup notification ("Set Up" /
"Don't ask again"), and always available afterward from
**Tools → Set Up Copilot Architect MCP Server**.

### Why a notification, not a silent write

That config file is **global** — shared across every IntelliJ project a
developer ever opens, not scoped to the one that happens to trigger plugin
startup. Writing it without any action from the developer would be a
surprising thing for opening one particular project to do; an explicit
"Set Up" click makes it a decision they made.

### The one thing this doesn't solve

Because that config is global with (as far as could be confirmed) no
per-project variable, every MCP tool call still needs to say which repo
it's about — this plugin cannot bake a fixed path into the config and have
it stay correct once a second IntelliJ project is opened in another
window. The fix lives on the server side, not here: every one of the four
MCP prompts (`packages/mcp-server/src/prompts.ts` in the main repository)
tells the model to pass an explicit `path` argument on every tool call,
using its own knowledge of which project is currently open. See
`docs/KNOWN_LIMITATIONS.md` 4.22 in the main repository for what is, and is
not, verified about that.

## Building

```bash
# From the repository root
npm install
npm run build
npm run bundle:cli          # produces dist-cli/cli.mjs + grammars/

# From this directory
./gradlew :core:test        # runs anywhere
./gradlew :plugin:buildPlugin   # requires reaching JetBrains' package hosts
```

`:plugin:buildPlugin` (and anything else touching the `intellijPlatform {}`
block) resolves the actual IDE distribution from JetBrains' own hosts. A
sandboxed development environment with restricted egress may not be able
to reach them — confirmed, not assumed, in the environment this was
originally built in (a direct 403 from both
`download.jetbrains.com` and `cache-redirector.jetbrains.com`). Real
verification for that module is `.github/workflows/intellij-plugin-ci.yml`,
on a runner with no such restriction.

## Not yet built

- No per-project override for the global `mcp.json` — see "The one thing
  this doesn't solve" above.
- No automated re-offer when a plugin update ships a materially different
  CLI; the Tools-menu action covers this manually.
- The startup notification's "Set Up" path has not been exercised against
  a real IntelliJ + Copilot Chat session end to end — `:core`'s own logic
  is fully tested directly, but the platform glue in `:plugin` could not be
  run in this sandbox at all (see above).
