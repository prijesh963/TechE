# Copilot Architect — IntelliJ edition (Phase 1)

The IntelliJ shell for Copilot Architect. Kotlin/Gradle, not TypeScript —
the only package in this monorepo that is, and deliberately kept out of the
npm workspace's own build (`tsc -b`, `vitest`). It shares the VS Code
extension's engine, never reimplements it: every dashboard render and every
future command runs through the same bundled CLI the VS Code extension
spawns (`CliBridge.kt`), the same Core Rule described in the repo root
`AGENTS.md`.

## What Phase 1 is

A single Tool Window that renders the shared dashboard (`packages/dashboard`,
via the CLI's `dashboard` command) inside a JBCef (embedded Chromium) view,
themed to the current IntelliJ Look and Feel. Nothing else yet — no chat
panel, no plan approval, no diff view. Those are later phases; see the
project's `docs/KNOWN_LIMITATIONS.md` for the plan and for what Phase 1
deliberately does not cover yet.

## Building

```bash
./gradlew build      # or: gradle build, if you don't have the wrapper jar
./gradlew runIde      # launches a sandbox IDE with the plugin installed
```

Requires network access to Maven Central (for the Kotlin/Gradle plugin
toolchain) **and** to JetBrains' own distribution hosts (`cache-redirector
.jetbrains.com`, `www.jetbrains.com`/`data.services.jetbrains.com`, `plugins
.jetbrains.com`) — the `intellijPlatform { create("IC", "2024.2.3") }`
dependency resolves the actual IDE distribution from there. **This could not be built or verified in the sandbox this plugin was
scaffolded in.** That environment's egress policy allows Maven Central and
the Gradle Plugin Portal (so the Kotlin and IntelliJ Platform _Gradle_
plugins themselves resolve fine) but returns 403 for every JetBrains-owned
host (`cache-redirector.jetbrains.com`, `www.jetbrains.com`,
`plugins.jetbrains.com`) — confirmed directly with `curl` before writing
this plugin, not assumed. `./gradlew build` there gets as far as evaluating
the build script, then fails at dependency resolution:

```
Could not determine the dependencies of task ':compileJava'.
> Could not resolve all dependencies for configuration ':compileClasspath'.
   > No IntelliJ Platform dependency found.
```

— i.e. it never reaches compiling a single Kotlin file, because the IDE
distribution itself (`create("IC", "2024.2.3")`) has nowhere reachable to
resolve from. The Kotlin sources are written against APIs believed correct
(plain `javax.swing.UIManager` was deliberately preferred over less certain
IntelliJ Platform SDK convenience methods for exactly this reason — see
`ThemeColors.kt`), but treat all of it as an unverified first pass — not
proven to compile — until it has actually built somewhere with real network
access: CI, or a developer machine.

## Pointing it at a built CLI

Set `COPILOT_ARCHITECT_CLI` to an absolute path to a built
`packages/cli/dist/index.js` (run `npm run build` at the repo root first).
Without it, `CliBridge` falls back to a relative dev-checkout path that only
works when the IDE's working directory happens to be the repo root — a
known Phase 1 limitation. Packaging a bundled copy of the CLI inside this
plugin's own distribution, the way the VS Code `.vsix` bundles `cli.mjs`
(see `scripts/bundle-extension.mjs` and `scripts/package-vsix.mjs`), is
Phase 2 work.

## Known Phase 1 limitations

Tracked in the repo root `docs/KNOWN_LIMITATIONS.md` rather than only here,
so they are not rediscovered:

- Not built/verified in this environment (network policy — see above).
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
- No action row (Setup Repo, Build Index, etc.) — the CLI's `dashboard`
  command renders an empty one, since it does not know this plugin's
  eventual command/URI scheme. Wiring that is Phase 2.
- Dashboard only — no chat/plan/diff surface yet.
