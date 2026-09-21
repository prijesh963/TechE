# Copilot Architect — IntelliJ edition (Phase 2, build verified in CI)

The IntelliJ shell for Copilot Architect. Kotlin/Gradle, not TypeScript —
the only package in this monorepo that is, and deliberately kept out of the
npm workspace's own build (`tsc -b`, `vitest`). It shares the VS Code
extension's engine, never reimplements it: every dashboard render and every
command runs through the same bundled CLI the VS Code extension spawns
(`CliBridge.kt`), the same Core Rule described in the repo root `AGENTS.md`
— with one explicit, documented exception for the Setup/Scan orchestration
logic (see "What Phase 2 adds" below).

## What Phase 1 is

A single Tool Window that renders the shared dashboard (`packages/dashboard`,
via the CLI's `dashboard` command) inside a JBCef (embedded Chromium) view,
themed to the current IntelliJ Look and Feel. No chat panel, no plan
approval, no diff view — those are still later phases.

## What Phase 2 adds

Every dashboard action link VS Code exposes, not just the dashboard view:

- **Action row.** The CLI's `dashboard` command now renders Setup Repo,
  Start & Setup MCP, Stop MCP, Generate Instructions, Open Repo, Scan &
  Register Sub-repos, Analyze Repo, Build Index, and Build Symbol Graph as
  `architect-action:<id>` links — a host-neutral scheme this plugin defines
  and intercepts itself (`ActionLinkInterceptor.kt`), since JCEF has no
  built-in equivalent to VS Code's webview `command:` URIs. All of them are
  shown together, flat, rather than the primary-four/"More actions…" split
  VS Code's quick pick does — the CLI already lays every action out in one
  place, so a second, IntelliJ-only grouping mechanism would only duplicate
  that decision.
- **`ActionDispatcher.kt`** routes each clicked id to `CliBridge` (Setup,
  Analyze, Build Index, Build Symbol Graph, Generate Instructions, Scan),
  to a new **`McpProcessManager.kt`** (a project-level service holding this
  window's own long-lived MCP server `Process` — the same shell-local
  handle VS Code's `activeMcpProcess` is; a running process can't be
  reported by a one-shot CLI call, so this manager is the source of truth
  `DashboardPanel` reads before every render), or to native IntelliJ APIs
  (`FileChooser` for the folder pickers Scan and Open Repo need,
  `ProjectUtil.openOrImport` for Open Repo itself) for the two actions that
  are IDE-native rather than repo intelligence.
- **`DashboardPanel`** now supplies the MCP status and the last action's
  outcome back into every render via the CLI's new `--mcp-status`/
  `--last-command`/`--last-exit-code`/`--last-stdout`/`--last-stderr` flags
  — a one-shot CLI call has nothing of its own to report honestly here, so
  this plugin, the long-lived caller, reports it instead.

Two new CLI commands back this, and are general-purpose (any shell could
use them, not just this one): `workspace scan <dir>` (registers every
real-repo subdirectory of a folder) and `setup [--workspace]` (the full
init→analyze→graph→diagnostics→index→mcp-config sequence, single-repo or
across a whole workspace). They deliberately **reimplement** VS Code's own
`registerSubRepos`/`setupRepo`/`shouldBuildWorkspaceGraph` rather than share
them — `vscode-extension/src/index.ts` was left untouched by explicit
instruction. The two copies can drift; see the repo root `AGENTS.md`'s Core
Rule section and `docs/KNOWN_LIMITATIONS.md` 4.18 for the full account.

Still open: no chat panel, no plan approval, no diff view. The Gradle build
itself is no longer unverified — see "Building" below.

## Building

```bash
./gradlew build      # or: gradle build, if you don't have the wrapper jar
./gradlew runIde      # launches a sandbox IDE with the plugin installed
```

Requires network access to Maven Central (for the Kotlin/Gradle plugin
toolchain) **and** to JetBrains' own distribution hosts (`cache-redirector
.jetbrains.com`, `www.jetbrains.com`/`data.services.jetbrains.com`, `plugins
.jetbrains.com`) — the `intellijPlatform { create("IC", "2024.2.3") }`
dependency resolves the actual IDE distribution from there.

**This has never been built in the sandbox this plugin was scaffolded and
developed in** — that environment's egress policy returns 403 for every
JetBrains-owned host, confirmed directly with `curl`, both when this plugin
was first scaffolded and again after every fix below. `./gradlew build`
there gets only as far as evaluating the build script, then fails at
dependency resolution (`No IntelliJ Platform dependency found` — it never
reaches compiling a single Kotlin file).

**It has been built successfully, though — on GitHub Actions, via
[PR #3](https://github.com/prijesh963/TechE/pull/3)'s own CI
(`.github/workflows/intellij-ci.yml`), which runs on a GitHub-hosted runner
without this sandbox's network restriction.** Getting there took six
rounds of real, CI-diagnosed fixes — a wrong Gradle dependency, one actual
Kotlin type error (`ProjectUtil.openOrImport`'s second argument), a JVM
version mismatch, two missing IntelliJ Plugin Verifier dependencies, and a
plugin ID that violated JetBrains Marketplace naming policy. The full,
one-by-one account — what CI reported, what was changed, and how each fix
was (and was not) verifiable in this sandbox — is
`docs/KNOWN_LIMITATIONS.md` §4.19. As of PR #3's current head, `build`,
`test`, and `release-check` are all green: the plugin compiles, assembles
into an installable `.zip`, and passes the IntelliJ Plugin Verifier's
static checks against a real 2024.2.x IDE build.

**What is still not verified: nobody has run `./gradlew runIde` and
actually clicked anything.** A green `build`/`verifyPlugin` is a static
guarantee — the code compiles and the plugin descriptor is well-formed. It
says nothing about whether `ActionLinkInterceptor` actually intercepts a
click at runtime, whether `McpProcessManager` actually holds a working
process handle, or whether `OpenProjectTask(projectToClose = ...,
forceOpenInNewFrame = ...)`'s parameter names — chosen without being able
to check the real API — happen to produce the intended behavior rather
than merely type-checking. The Kotlin sources still lean on plain
`javax.swing.UIManager` over less certain IntelliJ Platform SDK convenience
methods for the same reason as before (see `ThemeColors.kt`): a compile-time
guarantee is worth more than a runtime one this sandbox cannot check either
way. Treat "it builds" and "it works" as two separate claims — only the
first one is now backed by evidence.

## Pointing it at a built CLI

Set `COPILOT_ARCHITECT_CLI` to an absolute path to a built
`packages/cli/dist/index.js` (run `npm run build` at the repo root first).
Without it, `CliBridge` falls back to a relative dev-checkout path that only
works when the IDE's working directory happens to be the repo root — a
known limitation, still open in Phase 2. Packaging a bundled copy of the
CLI inside this plugin's own distribution, the way the VS Code `.vsix`
bundles `cli.mjs` (see `scripts/bundle-extension.mjs` and
`scripts/package-vsix.mjs`), remains later-phase work.

## Known limitations

Tracked in the repo root `docs/KNOWN_LIMITATIONS.md` (4.17, 4.18, 4.19)
rather than only here, so they are not rediscovered:

- Still not buildable in this development sandbox (network policy — see
  above); this no longer means "unverified" — CI has built it — only that
  this particular environment cannot reproduce that result locally.
- Never run inside a real IDE (`runIde`) — a green `build`/`verifyPlugin`
  proves the code compiles and the plugin descriptor is valid, not that any
  of it behaves correctly at runtime. See §4.19's "What this does and does
  not prove."
- The CLI entry point is an environment variable + dev-checkout fallback,
  not a bundled copy.
- `--vscode-*` CSS custom property names are reused verbatim from the
  shared dashboard HTML for IntelliJ's own theme values — functionally
  harmless (a CSS variable name is just a string) but a naming leak worth a
  rename once a second host actually needs it renamed for its own reasons.
- The `--vscode-charts-*` accent colors are fixed, not derived from the
  current IntelliJ theme — IntelliJ has no directly equivalent standardized
  "chart palette" theme key the way VS Code does. They will not adapt to a
  Light theme the way the rest of the dashboard's colors do.
- Dashboard only — no chat/plan/diff surface yet.
- The Setup/Scan orchestration (`workspace scan`/`setup` in `packages/cli`)
  is an independent reimplementation of VS Code's own
  `registerSubRepos`/`setupRepo`/`shouldBuildWorkspaceGraph`, not a shared
  one — see `docs/KNOWN_LIMITATIONS.md` 4.18. The two can drift.
- `McpProcessManager` discards the MCP server's stdout/stderr rather than
  streaming them anywhere — VS Code's `outputChannel` shows the same
  server's logs live; this plugin currently cannot.
- `--last-stdout`/`--last-stderr` are truncated to 4000 characters before
  being passed back into the next dashboard render, so a long `setup
--workspace` run's full output is not fully visible in the "Last command"
  card.
