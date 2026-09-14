# Agent Workflows

## First-Class Agents

Custom Copilot agents are first-class product artifacts. Copilot Architect generates, validates, installs, updates, and diagnoses agent definitions that are grounded in the current repo or workspace. All agents use the `gpt-4o` model.

---

## Installing Agents

```bash
npm run cli -- agents install
```

This installs the following files under `.github/agents/` by default:

| File                           | Agent Name             | Purpose                                                                   |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| `FeatureArchitect.agent.md`    | `@FeatureArchitect`    | Analyze repo, find patterns, produce implementation plans — no code edits |
| `FeatureImplementer.agent.md`  | `@FeatureImplementer`  | Implement an approved plan with minimal scoped changes and tests          |
| `CodeReviewer.agent.md`        | `@CodeReviewer`        | Review diff against approved plan and validation evidence                 |
| `TestPlanner.agent.md`         | `@TestPlanner`         | Map features to test coverage strategies                                  |
| `Debugger.agent.md`            | `@Debugger`            | Classify validation failures and propose minimal safe fixes               |
| `SecurityReviewer.agent.md`    | `@SecurityReviewer`    | Review changes for security risks                                         |
| `PerformanceReviewer.agent.md` | `@PerformanceReviewer` | Identify performance concerns                                             |

Each agent file includes:

- YAML frontmatter with `name`, `description`, `model: gpt-4o`, and `tools`
- `## Purpose` — what the agent is allowed and not allowed to do
- `## Instructions` — ordered steps the agent follows
- `## Handoff Guidance` — how to pass context to the next agent
- `## Safety Rules` — explicit constraints (no unauthorized edits, no secrets, etc.)
- `## Copilot Architect Artifacts` — paths to `.copilot-architect/` artifacts the agent should read

---

## Agent Commands

```bash
npm run cli -- agents list
npm run cli -- agents install
npm run cli -- agents install --dry-run          # preview without writing
npm run cli -- agents install --force            # overwrite existing files (backs up first)
npm run cli -- agents install --output <dir>     # install to a custom directory
npm run cli -- agents update                     # update installed agents (backs up first)
npm run cli -- agents validate                   # validate installed agent files
npm run cli -- agents doctor                     # explain how to use @FeatureArchitect etc.
```

Use `--output json` or `--json` for structured output.

Existing files are **skipped by default**. `--force` and `agents update` overwrite generated files only after creating `.bak` backups.

---

## Primary Workflow

### Step-by-step

1. **Analyze** the repo or workspace:

   ```bash
   npm run cli -- analyze
   npm run cli -- index
   ```

2. **Generate a feature plan** using `@FeatureArchitect` or directly from CLI:

   ```bash
   npm run cli -- plan "Add invoice approval workflow"
   # writes .copilot-architect/plans/latest-plan.md
   ```

   In Copilot Chat:

   ```text
   @FeatureArchitect Analyze this repo and produce a plan for adding invoice approval.
   Do not edit any code yet.
   ```

3. **Review and approve** the plan (human checkpoint).

4. **Generate a handoff**:

   ```bash
   npm run cli -- handoff --plan latest --approve
   # writes .copilot-architect/handoffs/latest-handoff.md, copies to clipboard
   ```

5. **Implement** using `@FeatureImplementer`:

   ```text
   @FeatureImplementer Implement .copilot-architect/handoffs/latest-handoff.md.
   Run validation commands and summarize changed files.
   ```

6. **Validate**:

   ```bash
   npm run cli -- validate --test
   npm run cli -- validate --lint
   ```

7. **Review** the implementation:

   ```bash
   npm run cli -- review --plan latest --validation latest
   # writes .copilot-architect/reviews/latest-review.md
   ```

   In Copilot Chat:

   ```text
   @CodeReviewer Review the git diff against .copilot-architect/reviews/latest-review.md
   and the approved plan.
   ```

8. **Debug failures** if validation failed:
   ```text
   @Debugger Validation failed. Use .copilot-architect/runs/latest-validation.json
   to classify the failure and propose the smallest safe fix.
   ```

---

## Agent Handoff Chain

Agents include built-in Copilot Chat handoff buttons:

```
@FeatureArchitect (Feature Planner) → @FeatureImplementer   [only after the plan is approved and saved]
@FeatureImplementer                 → @CodeReviewer          [after the edits are applied]
@CodeReviewer                       → @FeatureArchitect      [when findings are accepted — loops for a new plan]
@CodeReviewer                       → @TestPlanner           [when the review is clean]
```

The Feature Planner drafts and refines the plan **in chat only** — nothing is
written to `.copilot-architect/plans/` until the human explicitly approves it.
Start Implementation is offered only once the approved plan exists on disk.

`@CodeAnalysisAgent` is standalone: it reports and suggests, and never hands
off. `@Debugger` is not routed to from the review flow; invoke it directly when
you want a validation failure triaged.

---

## Copilot Chat MCP Integration

Copilot Architect writes `.vscode/mcp.json` for VS Code and GitHub Copilot Chat:

```bash
npm run cli -- mcp config --path /path/to/repo
```

The generated server is named `copilotArchitect` and runs the local stdio MCP server. To connect:

1. Open VS Code Command Palette → `MCP: List Servers`
2. Start `copilotArchitect`
3. Open Copilot Chat in Agent mode
4. Enable Copilot Architect tools when prompted

Copilot Architect does not modify Copilot internals. It provides supported repository customization files and a local MCP server configuration.

---

## Instructions and Skills

Copilot Architect generates `.github/copilot-instructions.md` and skill templates from the same repo intelligence used by the planner:

```bash
npm run cli -- instructions preview    # preview without writing
npm run cli -- instructions generate   # write files (backs up existing)
npm run cli -- instructions validate   # validate generated files
```

Generated instructions include: repo architecture summary, detected languages, frameworks, package managers, build/test/lint/format commands, coding conventions, safety rules, planning workflow, approval workflow, validation workflow, and review workflow.

**Generated skills:**

- `.github/skills/feature-planning/SKILL.md`
- `.github/skills/repo-analysis/SKILL.md`
- `.github/skills/validation/SKILL.md`
- `.github/skills/code-review/SKILL.md`
- `.github/skills/debugging/SKILL.md`

**Generated Copilot Chat prompt files:**

- `.github/prompts/copilot-architect-plan.prompt.md`
- `.github/prompts/copilot-architect-implement.prompt.md`
- `.github/prompts/copilot-architect-review.prompt.md`
- `.github/prompts/copilot-architect-debug.prompt.md`

---

## Example Copilot Chat Prompts

**Planning a feature:**

```text
@FeatureArchitect Add [feature] based on this repo.
Use Copilot Architect repo map, index, MCP tools, and latest generated plan.
Do not modify code yet. First create a detailed implementation plan.
```

**After approval:**

```text
@FeatureImplementer Implement the approved plan from .copilot-architect/plans/latest-plan.md.
Run validation commands and summarize changed files.
```

**After implementation:**

```text
@CodeReviewer Review the git diff against the approved plan and latest validation report.
```

**If validation failed:**

```text
@Debugger Validation failed. Use .copilot-architect/runs/latest-validation.json
and related logs to classify the failure and propose the smallest safe fix.
```

**Security review:**

```text
@SecurityReviewer Review the changes in the git diff for security risks.
Reference .copilot-architect/plans/latest-plan.md for expected scope.
```

---

## UI Boundary

Any agent workflow exposed in VS Code or the local web UI must call the agents and instructions packages. UI shells must not implement agent generation logic directly.
