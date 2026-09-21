export const PROJECT_NAME = "Copilot Architect";

export const COPILOT_ARCHITECT_VERSION = "0.1.0";

export const CURRENT_SCHEMA_VERSION = COPILOT_ARCHITECT_VERSION;

/**
 * The one front door, and its phases.
 *
 * Generated prompts, handoffs and review reports all name the thing a
 * developer should type next. When Phase 5 deleted the eleven `.agent.md`
 * files, those generated texts went on naming `@FeatureImplementer` and
 * `@CodeReviewer` — mentions that now resolve to nothing. A developer who
 * follows them types into the void and reports that "the agent" is broken,
 * which is exactly how a bug report about `@architect` once arrived
 * describing a different system entirely.
 *
 * Defined once here so a rename cannot leave a generated artifact behind.
 */
export const CHAT_PARTICIPANT = "@architect";

export const CHAT_COMMANDS = {
  analyze: `${CHAT_PARTICIPANT} /analyze`,
  plan: `${CHAT_PARTICIPANT} /create-plan`,
  implement: `${CHAT_PARTICIPANT} /implement`,
  review: `${CHAT_PARTICIPANT} /review`
} as const;

export const ARTIFACT_DIRECTORY = ".copilot-architect";

export const ARTIFACT_FILE_NAMES = {
  repoMap: "repo-map.json",
  workspace: "workspace.json",
  commands: "commands.json",
  policy: "policy.json",
  graph: "graph.json",
  graphWorkspace: "graph-workspace.json"
} as const;

export const ARTIFACT_DIRECTORY_NAMES = {
  index: "index",
  sessions: "sessions",
  plans: "plans",
  handoffs: "handoffs",
  runs: "runs",
  reviews: "reviews",
  audit: "audit",
  diagnostics: "diagnostics"
} as const;

export const CLI_COMMANDS = [
  "init",
  "analyze",
  "graph",
  "index",
  "search",
  "intent",
  "plan",
  "measure",
  "commands",
  "validate",
  "policy",
  "audit",
  "cleanup",
  "review",
  "handoff",
  "instructions",
  "workspace",
  "mcp",
  "serve",
  "dashboard",
  "diagnostics",
  "status",
  "doctor",
  "demo",
  "version"
] as const;

export type CliCommandName = (typeof CLI_COMMANDS)[number];

export const REQUIRED_PACKAGE_DIRECTORIES = [
  "packages/shared",
  "packages/core",
  "packages/adapters",
  "packages/indexer",
  "packages/graph",
  "packages/intent",
  "packages/planner",
  "packages/measurement",
  "packages/validator",
  "packages/reviewer",
  "packages/agents",
  "packages/instructions",
  "packages/mcp-server",
  "packages/cli",
  "packages/dashboard",
  "packages/vscode-extension",
  "packages/intellij-plugin",
  "packages/web"
] as const;

// `templates/agents` was removed in Phase 8. Phase 5 deleted the agent
// templates themselves; the empty directory outlived them because nothing
// was checking whether it still had a purpose.
export const REQUIRED_TEMPLATE_DIRECTORIES = [
  "templates/instructions",
  "templates/skills"
] as const;
