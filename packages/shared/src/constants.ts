export const PROJECT_NAME = "Copilot Architect";

export const COPILOT_ARCHITECT_VERSION = "0.1.0";

export const CURRENT_SCHEMA_VERSION = COPILOT_ARCHITECT_VERSION;

export const ARTIFACT_DIRECTORY = ".copilot-architect";

export const ARTIFACT_FILE_NAMES = {
  repoMap: "repo-map.json",
  workspace: "workspace.json",
  commands: "commands.json",
  policy: "policy.json",
  graph: "graph.json"
} as const;

export const ARTIFACT_DIRECTORY_NAMES = {
  index: "index",
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
  "plan",
  "commands",
  "validate",
  "policy",
  "audit",
  "cleanup",
  "review",
  "handoff",
  "agents",
  "instructions",
  "workspace",
  "mcp",
  "serve",
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
  "packages/planner",
  "packages/validator",
  "packages/reviewer",
  "packages/agents",
  "packages/instructions",
  "packages/mcp-server",
  "packages/cli",
  "packages/vscode-extension",
  "packages/web"
] as const;

export const REQUIRED_TEMPLATE_DIRECTORIES = [
  "templates/agents",
  "templates/instructions",
  "templates/skills"
] as const;
