# Internal Team Setup

This guide is the short path for a new team member joining Copilot Architect development or starting to use it on their repos.

---

## New Team Member Setup

```bash
git clone <internal-repo-url>
cd copilot-architect
scripts/setup.sh              # install, build, test, verify
npm run cli -- demo           # end-to-end verification
```

Windows PowerShell:

```powershell
git clone <internal-repo-url>
cd copilot-architect
.\scripts\setup.ps1
npm run cli -- demo
```

After setup, confirm:

```bash
npm run cli -- version        # prints version and schema info
npm run cli -- doctor         # checks Node.js version (≥20.11), packages, setup
npm run cli -- demo           # runs analyze → index → search → diagnostics
```

---

## Requirements

- **Node.js 20.11 or newer** — `doctor` will report `node-version: error` if too old
- **npm** — included with Node.js
- **Git** — recommended for review, handoff checkpoints, and git-aware features

---

## Daily Development Loop

```bash
npm run format          # Prettier check
npm run lint            # ESLint
npm run build           # compile TypeScript
npm test                # run all 147 tests
```

Run the CLI from the root npm script during development:

```bash
npm run cli -- analyze --path samples/react-app
npm run cli -- index --path samples/react-app
npm run cli -- search "invoice" --path samples/react-app
npm run cli -- plan "Add invoice approval workflow" --path samples/react-app
npm run cli -- validate --path samples/react-app
```

---

## Using Copilot Architect on a Target Repo

### Quick path

```bash
cd /path/to/target-repo

# from copilot-architect checkout
npm run cli -- demo --path /path/to/target-repo
npm run cli -- analyze --path /path/to/target-repo
npm run cli -- index --path /path/to/target-repo
npm run cli -- plan "Add X feature" --path /path/to/target-repo
npm run cli -- agents install --path /path/to/target-repo
npm run cli -- instructions generate --path /path/to/target-repo
npm run cli -- mcp config --path /path/to/target-repo
```

### With npm link (recommended for regular use)

```bash
cd copilot-architect
npm run build
npm link --workspace @copilot-architect/cli

cd /path/to/target-repo
copilot-architect init
copilot-architect analyze
copilot-architect index
copilot-architect plan "Add invoice approval workflow"
copilot-architect agents install
copilot-architect instructions generate
copilot-architect mcp config
```

---

## Sharing With a Teammate

**Option 1 — Share the Git repo** (recommended for contributors):

```bash
git clone <internal-repo-url>
cd copilot-architect && scripts/setup.sh
```

**Option 2 — Share a local tarball**:

```bash
cd copilot-architect
npm run package:local
# share dist/release/copilot-architect-<version>.tgz
```

Teammate installs:

```bash
npm install -g copilot-architect-0.1.1.tgz
copilot-architect doctor
copilot-architect demo
```

---

## Release Checklist

Before cutting an internal release:

- [ ] `npm install`
- [ ] `npm run format`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test` — all tests pass
- [ ] `npm run cli -- version` — version matches
- [ ] `npm run cli -- doctor` — status is `ok`, Node.js check passes
- [ ] `npm run cli -- demo` — all 4 steps pass
- [ ] Update `CHANGELOG.md` with what changed
- [ ] `npm run package:local` — creates `dist/release/` artifacts
- [ ] Share `dist/release/release-manifest.json` and `copilot-architect-<version>.tgz`

---

## Key Directories

| Path                                                 | Purpose                                 |
| ---------------------------------------------------- | --------------------------------------- |
| `packages/cli/src/index.ts`                          | CLI entry point and command routing     |
| `packages/shared/src/models.ts`                      | All shared TypeScript domain models     |
| `packages/shared/src/constants.ts`                   | Version, command names, artifact paths  |
| `packages/core/src/repo-discovery.ts`                | Repo analysis and adapter orchestration |
| `packages/adapters/src/`                             | Language/framework adapters             |
| `packages/indexer/src/indexing-service.ts`           | File indexing and search                |
| `packages/planner/src/feature-planning-service.ts`   | Feature plan generation                 |
| `packages/validator/src/validation-service.ts`       | Safe command execution                  |
| `packages/validator/src/safety-policy-service.ts`    | Blocked patterns, secret redaction      |
| `packages/validator/src/secret-redaction-service.ts` | Runtime secret scrubbing                |
| `packages/reviewer/src/index.ts`                     | Review report generation                |
| `packages/agents/src/index.ts`                       | Agent template generation               |
| `packages/mcp-server/src/tools.ts`                   | MCP tool definitions                    |
| `tests/`                                             | Integration and e2e tests               |
| `samples/`                                           | Representative repos for testing        |
| `docs/`                                              | Product documentation                   |
