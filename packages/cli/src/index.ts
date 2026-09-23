#!/usr/bin/env node

import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCopilotPanelHtml,
  parseCopilotArgs,
  runCopilotCommand
} from "./copilot-command.js";

import {
  AdvancedAnalysisService,
  RepoDiscoveryService,
  WorkspaceService,
  type RepoReadinessReport,
  type WorkspaceServiceResult
} from "@copilot-architect/core";
import { SymbolGraphService, type SymbolGraphResult } from "@copilot-architect/graph";
import {
  IndexingService,
  type IndexResult,
  type SearchResponse,
  type WorkspaceIndexResult,
  type WorkspaceSearchResponse
} from "@copilot-architect/indexer";
import {
  QueryIntentService,
  type QueryIntentResult,
  type RelevantFileSummary
} from "@copilot-architect/intent";
import {
  InstructionService,
  type InstructionGenerationSummary,
  type InstructionPreviewResult,
  type InstructionValidationResult
} from "@copilot-architect/instructions";
import {
  ContextMeasurementService,
  type ContextMeasurement
} from "@copilot-architect/measurement";
import {
  CopilotHandoffService,
  FeaturePlanningService,
  HandoffService,
  WorkspacePlanningService,
  type FeaturePlanArtifact,
  type FeaturePlanningResult,
  type HandoffGenerationResult,
  type PlanRevisionDiffResult,
  type PlanRevisionSummary,
  type WorkspaceImpactResult,
  type WorkspacePlanningResult
} from "@copilot-architect/planner";
import {
  CopilotChatMcpConfigService,
  startMcpServer,
  type CopilotChatMcpConfigResult
} from "@copilot-architect/mcp-server";
import {
  ReviewService,
  type ResolveReviewFindingResult,
  type ReviewServiceResult
} from "@copilot-architect/reviewer";
import {
  ArtifactCleanupService,
  AuditLogService,
  CommandConfigService,
  SafetyPolicyService,
  ValidationService,
  type ArtifactCleanupResult,
  type AuditListResult,
  type CommandConfigCategory,
  type ParsedCommandConfig,
  type CommandConfigInitResult,
  type SafetyPolicyInitResult,
  type SafetyPolicyValidationResult,
  type CommandConfigValidationResult,
  type ValidationRunResult
} from "@copilot-architect/validator";
import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  startWebServer,
  type WebServerStartResult
} from "@copilot-architect/web";
import {
  createDashboardHtml,
  escapeHtml,
  loadDashboardArtifacts,
  loadDashboardSession,
  type DashboardArtifacts,
  type DashboardSession
} from "@copilot-architect/dashboard";
import {
  ARTIFACT_DIRECTORY,
  CLI_COMMANDS,
  COPILOT_ARCHITECT_VERSION,
  CURRENT_SCHEMA_VERSION,
  type CrossRepoInterlink,
  type DiagnosticReport,
  type CliCommandName,
  PROJECT_NAME,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  looksLikeRepo,
  readJsonFile,
  type FeaturePlan,
  type HandoffPrompt
} from "@copilot-architect/shared";

export interface CliIo {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

export interface CliResult {
  exitCode: number;
}

const commandDescriptions = {
  init: "Initialize local .copilot-architect artifacts.",
  analyze: "Analyze the current repo or workspace.",
  graph: "Build the symbol/dependency graph.",
  index: "Build the local searchable index.",
  search: "Search the local repo index.",
  intent: "Classify a query's intent and resolve likely relevant files.",
  plan: "Generate a feature implementation plan.",
  measure:
    "Measure how much a plan's file selection narrows context vs the whole repo.",
  commands: "Manage custom validation command configuration.",
  validate: "Run safe validation commands.",
  policy: "Inspect and validate the local safety policy.",
  audit: "List local audit log entries.",
  cleanup: "Apply local artifact retention cleanup.",
  review: "Generate a review report from diff and validation evidence.",
  handoff: "Generate an implementation handoff prompt.",
  instructions: "Generate Copilot instructions and AGENTS.md suggestions.",
  workspace: "Inspect or manage multi-repo workspace context.",
  mcp: "Start the local MCP server or write Copilot Chat MCP config.",
  serve: "Start the optional local web UI shell.",
  dashboard:
    "Render the same dashboard every shell shows, as HTML on stdout — for a host that cannot import it directly.",
  copilot:
    "Prepare grounded Copilot Chat prompts and import Copilot's plan replies — the workflow for hosts without MCP.",
  setup:
    "One-shot repo onboarding: initialize, analyze, build graph and index, assess readiness, configure MCP.",
  diagnostics: "Report repo readiness and advanced local intelligence.",
  status: "Show local Copilot Architect status.",
  doctor: "Run environment and project checks.",
  demo: "Run a quick end-to-end demo on the current repo.",
  version: "Print the Copilot Architect version."
} satisfies Record<CliCommandName, string>;

const commandUsage = {
  init: "npm run cli -- init [--path <repo>] [--overwrite] [--json]",
  analyze:
    "npm run cli -- analyze [path] [--path <repo>|--root <repo>] [--json] [--output <file>]",
  graph: "npm run cli -- graph [path] [--path <repo>|--root <repo>] [--json]",
  index:
    "npm run cli -- index [path] [--path <repo>|--root <repo>] [--rebuild] [--json]",
  search:
    'npm run cli -- search "query" [--path <repo>|--root <repo>] [--limit <n>] [--json]',
  intent:
    'npm run cli -- intent "query" [--path <repo>|--root <repo>] [--limit <n>] [--json]',
  plan:
    'npm run cli -- plan "feature request" [--path <repo>|--root <repo>] [--json]\n' +
    "  npm run cli -- plan approve --revision <n> --by <name> [--path <repo>] [--json]\n" +
    "  npm run cli -- plan revisions [--path <repo>] [--json]\n" +
    "  npm run cli -- plan show [--revision <n>] [--path <repo>] [--json]\n" +
    "  npm run cli -- plan diff [--from <n>] [--to <n>] [--path <repo>] [--json]",
  measure:
    'npm run cli -- measure "feature request" [--path <repo>|--root <repo>] [--json]',
  commands: "npm run cli -- commands <list|validate> [--path <repo>] [--json]",
  validate:
    "npm run cli -- validate [--build|--test|--lint|--format|--validation] [--path <repo>|--root <repo>] [--json]",
  policy: "npm run cli -- policy <show|validate> [--path <repo>] [--json]",
  audit: "npm run cli -- audit list [--path <repo>] [--limit <n>] [--json]",
  cleanup:
    "npm run cli -- cleanup [--path <repo>] [--dry-run|--apply] [--max-age-days <n>] [--max-runs <n>] [--json]",
  review:
    "npm run cli -- review [--path <repo>] [--plan latest|<file>] [--validation latest|<file>] [--json]",
  handoff:
    "npm run cli -- handoff --approve [--plan latest|<file>] [--target <agent>] [--path <repo>] [--no-clipboard] [--json]",
  instructions:
    "npm run cli -- instructions <generate|preview|validate> [--path <repo>] [--output <file>] [--json]",
  workspace:
    "npm run cli -- workspace <init|show|list|add|remove|scan|index|search|impact|plan|validate-plan> [args] [--json]",
  mcp: "npm run cli -- mcp [--path <repo>] [--toolset <full|intellij>] | npm run cli -- mcp config [--path <repo>] [--force] [--toolset <full|intellij>] [--json]",
  serve:
    "npm run cli -- serve [--path <repo>] [--host 127.0.0.1] [--port <n>] [--json]",
  dashboard:
    "npm run cli -- dashboard [--path <repo>] [--mcp-status <stopped|starting|running>] [--last-command <text>] [--last-exit-code <n>] [--last-stdout <text>] [--last-stderr <text>] [--task <text>] [--notice <text>] [--notice-error] [--json]",
  copilot:
    'npm run cli -- copilot <ask|plan> --text "<question or change>" [--prompt-out <file>] [--path <repo>] [--json]\n' +
    "  npm run cli -- copilot import --response-file <file> [--path <repo>] [--json]\n" +
    "  npm run cli -- copilot approve --version <n> [--path <repo>] [--json]\n" +
    "  npm run cli -- copilot implement [--prompt-out <file>] [--path <repo>] [--json]\n" +
    "  npm run cli -- copilot state [--path <repo>] [--json]",
  setup: "npm run cli -- setup [--path <repo>] [--workspace] [--json]",
  diagnostics: "npm run cli -- diagnostics [--path <repo>] [--json]",
  status: "npm run cli -- status [--path <repo>] [--json]",
  doctor: "npm run cli -- doctor [--json]",
  demo: "npm run cli -- demo [--path <repo>] [--json]",
  version: "npm run cli -- version [--json]"
} satisfies Record<CliCommandName, string>;

export function getHelpText(): string {
  const commandLines = CLI_COMMANDS.map(
    (command) => `  ${command.padEnd(14)} ${commandDescriptions[command]}`
  );

  return [
    `${PROJECT_NAME}`,
    "",
    "Usage:",
    "  npm run cli -- <command> [args]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Quick start:",
    "  npm run cli -- demo",
    "",
    "Examples:",
    "  npm run cli -- analyze",
    "  npm run cli -- index",
    '  npm run cli -- search "invoice"',
    '  npm run cli -- plan "Add invoice approval workflow"',
    "  npm run cli -- validate --test",
    "  npm run cli -- mcp",
    "",
    "Internal sharing:",
    "  npm run cli -- version",
    "  npm run package:local"
  ].join("\n");
}

/** How this CLI was actually started, for the help text to name. */
const SOURCE_INVOCATION = "npm run cli --";

/** What `scripts/bundle-extension.mjs` emits, and the VSIX ships. */
const BUNDLED_CLI_FILENAME = "cli.mjs";

/** The `bin` name, which `npm link` puts on PATH. */
const CLI_BIN_NAME = "copilot-architect";

/**
 * The command a reader can actually type.
 *
 * `npm run cli --` only resolves inside this monorepo. The CLI also ships
 * bundled inside the VSIX, spawned by absolute path on a machine with no
 * package.json and no clone — and it printed the monorepo invocation there,
 * sending a developer to type something that cannot work. This is the same
 * mistake Phase 7 fixed for the extension's spawn path, left behind in the
 * CLI's own help.
 */
export function cliInvocation(scriptPath = process.argv[1] ?? ""): string {
  if (!scriptPath) {
    return SOURCE_INVOCATION;
  }

  // Running from the workspace sources is the one case where the npm script
  // exists, and it is the friendlier thing to print there.
  if (scriptPath.includes(`${path.sep}packages${path.sep}cli${path.sep}`)) {
    return SOURCE_INVOCATION;
  }

  const base = path.basename(scriptPath);

  // Only our own artifacts are named, never whatever script happens to be
  // running. The CLI is also imported as a library — by the test runner, and
  // by anything embedding it — and a first version printed the host's path,
  // telling a reader to run `node .../vitest/forks.js init`. An unfamiliar
  // host falls through to the invocation that at least exists in a clone.
  if (base === BUNDLED_CLI_FILENAME) {
    return `node ${scriptPath}`;
  }

  if (base === CLI_BIN_NAME) {
    return CLI_BIN_NAME;
  }

  return SOURCE_INVOCATION;
}

export function getCommandHelpText(command: CliCommandName): string {
  return [
    `${PROJECT_NAME}: ${command}`,
    "",
    commandDescriptions[command],
    "",
    "Usage:",
    `  ${commandUsage[command].replaceAll(SOURCE_INVOCATION, cliInvocation())}`,
    "",
    "Common flags:",
    "  --json       Print structured JSON where supported.",
    "  --path PATH  Run against a specific repo or workspace path.",
    "  --root PATH  Treat PATH as the repo root instead of climbing to a parent Git root where supported.",
    "  --help       Show command help."
  ].join("\n");
}

export interface VersionReport {
  name: string;
  version: string;
  schemaVersion: string;
  runtime: string;
  packageManager: "npm";
  distribution: "internal";
}

export function getVersionReport(nodeVersion = process.version): VersionReport {
  return {
    name: "copilot-architect",
    version: COPILOT_ARCHITECT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    runtime: nodeVersion,
    packageManager: "npm",
    distribution: "internal"
  };
}

export function getVersionText(nodeVersion = process.version): string {
  const report = getVersionReport(nodeVersion);

  return [
    `${PROJECT_NAME} ${report.version}`,
    `Schema: ${report.schemaVersion}`,
    `Runtime: ${report.runtime}`,
    "Distribution: internal"
  ].join("\n");
}

export function getDoctorText(nodeVersion = process.version): string {
  const report = getDoctorReport(nodeVersion);
  const checkLines = report.checks.map(
    (check) => `- ${check.name}: ${check.status} - ${check.message}`
  );

  return [
    `${PROJECT_NAME} doctor`,
    "",
    `Version: ${COPILOT_ARCHITECT_VERSION}`,
    `Schema: ${report.schemaVersion}`,
    `Node.js: ${report.environment.nodeVersion}`,
    "Runtime: TypeScript/Node.js-first",
    `Package manager: ${report.environment.packageManager}`,
    `Artifact root: ${report.artifactRoot}`,
    `Status: ${report.summary}`,
    "",
    "Checks:",
    ...checkLines
  ].join("\n");
}

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 11;

function parseNodeVersion(versionString: string): { major: number; minor: number } {
  const match = /^v?(\d+)\.(\d+)/.exec(versionString);
  if (!match) return { major: 0, minor: 0 };
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function checkNodeVersion(versionString: string): {
  status: "ok" | "warning" | "error";
  message: string;
} {
  const { major, minor } = parseNodeVersion(versionString);
  const meetsRequirement =
    major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);

  if (!meetsRequirement) {
    return {
      status: "error",
      message: `Node.js ${versionString} is below the required minimum v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}. Upgrade at https://nodejs.org/`
    };
  }

  return {
    status: "ok",
    message: `Node.js ${versionString} meets the v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ requirement.`
  };
}

export function getDoctorReport(nodeVersion = process.version): DiagnosticReport {
  const nodeCheck = checkNodeVersion(nodeVersion);
  const hasErrors = nodeCheck.status === "error";

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    id: "phase-23-doctor",
    status: hasErrors ? "error" : "ok",
    summary: hasErrors
      ? "Environment issues detected — see checks below."
      : "Environment looks good. Run `npm run cli -- demo` to verify end-to-end.",
    environment: {
      nodeVersion,
      packageManager: "npm",
      platform: process.platform
    },
    checks: [
      {
        name: "node-version",
        status: nodeCheck.status,
        message: nodeCheck.message
      },
      {
        name: "version-command",
        status: "ok",
        message: `Copilot Architect ${COPILOT_ARCHITECT_VERSION} — run \`npm run cli -- version\` to confirm.`
      },
      {
        name: "local-package",
        status: "ok",
        message:
          "Run `npm run package:local` to build an internal tarball under dist/release/."
      },
      {
        name: "installation-docs",
        status: "ok",
        message:
          "Internal setup, npm link, tarball, troubleshooting, and upgrade guidance live under docs/."
      },
      {
        name: "runtime",
        status: "ok",
        message: "TypeScript/Node.js-first with Node.js 20.11 or newer required."
      },
      {
        name: "setup",
        status: "ok",
        message:
          "Run `scripts/setup.sh` or `scripts/setup.ps1` after clone to install, build, and test."
      },
      {
        name: "policy",
        status: "ok",
        message:
          "Run `npm run cli -- init` and `npm run cli -- policy validate`; command allow/block lists and approval gates live in .copilot-architect/policy.json."
      },
      {
        name: "local-first",
        status: "ok",
        message: "Telemetry is disabled by default and runtime artifacts stay local."
      },
      {
        name: "cleanup",
        status: "ok",
        message:
          "Run `npm run cli -- cleanup --dry-run` to preview retention and `--apply` to delete eligible artifacts."
      },
      {
        name: "dotnet-engine",
        status: "ok",
        message: "C#/.NET MVP engine is not present — TypeScript/Node.js only."
      },
      {
        name: "visual-studio-vsix",
        status: "ok",
        message: "Visual Studio VSIX is not in scope for MVP."
      }
    ],
    artifactRoot: ARTIFACT_DIRECTORY
  };
}

export async function runCli(
  args = process.argv.slice(2),
  io: CliIo = {}
): Promise<CliResult> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  const [rawCommand, ...commandArgs] = args;

  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    stdout(getHelpText());
    return { exitCode: 0 };
  }

  if (!isCliCommand(rawCommand)) {
    stderr(`Unknown command: ${rawCommand}`);
    stdout(getHelpText());
    return { exitCode: 1 };
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    stdout(getCommandHelpText(rawCommand));
    return { exitCode: 0 };
  }

  if (rawCommand === "version") {
    const options = parseJsonOnlyArgs(commandArgs, "version");
    const report = getVersionReport();
    stdout(options.json ? JSON.stringify(report, null, 2) : getVersionText());
    return { exitCode: 0 };
  }

  if (rawCommand === "doctor") {
    const options = parseJsonOnlyArgs(commandArgs, "doctor");
    const report = getDoctorReport();
    stdout(options.json ? JSON.stringify(report, null, 2) : getDoctorText());
    return { exitCode: 0 };
  }

  if (rawCommand === "mcp") {
    try {
      const options = parseMcpArgs(commandArgs);
      if (options.subcommand === "config") {
        const result = await new CopilotChatMcpConfigService().write({
          startPath: options.startPath,
          force: options.force,
          toolset: options.toolset
        });
        stdout(
          options.json ? JSON.stringify(result, null, 2) : getMcpConfigText(result)
        );
        return { exitCode: 0 };
      }

      await startMcpServer({ startPath: options.startPath, toolset: options.toolset });
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "init") {
    try {
      const options = parseInitArgs(commandArgs);
      const commandResult = await new CommandConfigService().init(options);
      const policyResult = await new SafetyPolicyService().init(
        options.startPath,
        options.overwrite ?? false
      );
      const payload = { commands: commandResult, policy: policyResult };
      stdout(
        options.json
          ? JSON.stringify(payload, null, 2)
          : getInitSummaryText(commandResult, policyResult)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "commands") {
    try {
      const options = parseCommandsArgs(commandArgs);
      const service = new CommandConfigService();

      if (options.subcommand === "validate") {
        const result = await service.validate({ startPath: options.startPath });
        stdout(
          options.json
            ? JSON.stringify(result, null, 2)
            : getCommandsValidateText(result)
        );
        return { exitCode: result.ok ? 0 : 1 };
      }

      const parsed = await service.load({
        startPath: options.startPath,
        allowMissing: true
      });
      stdout(
        options.json
          ? JSON.stringify(parsed.normalized, null, 2)
          : getCommandsListText(parsed)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "policy") {
    try {
      const options = parsePolicyArgs(commandArgs);
      const service = new SafetyPolicyService();

      if (options.subcommand === "show") {
        const policy = await service.load(options.startPath);
        stdout(JSON.stringify(policy, null, 2));
        return { exitCode: 0 };
      }

      const result = await service.validate(options.startPath);
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getPolicyValidateText(result)
      );
      return { exitCode: result.ok ? 0 : 1 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "audit") {
    try {
      const options = parseAuditArgs(commandArgs);

      if (options.subcommand !== "list") {
        throw new Error("Expected audit subcommand: list");
      }

      const result = await new AuditLogService().list(
        options.startPath ?? process.cwd(),
        options.limit
      );
      stdout(options.json ? JSON.stringify(result, null, 2) : getAuditListText(result));
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "cleanup") {
    try {
      const options = parseCleanupArgs(commandArgs);
      const result = await new ArtifactCleanupService().cleanup({
        startPath: options.startPath,
        dryRun: options.dryRun,
        maxAgeDays: options.maxAgeDays,
        maxRuns: options.maxRuns
      });
      stdout(options.json ? JSON.stringify(result, null, 2) : getCleanupText(result));
      return { exitCode: result.errors.length === 0 ? 0 : 1 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "analyze") {
    try {
      const options = parseAnalyzeArgs(commandArgs);
      const result = await new RepoDiscoveryService().analyze({
        startPath: options.startPath,
        outputPath: options.outputPath,
        strictRoot: options.strictRoot
      });

      stdout(
        options.json
          ? JSON.stringify(result.repoMap, null, 2)
          : getAnalyzeSummaryText(result.repoMapPath, result.repoMap.summary)
      );

      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "graph") {
    try {
      const options = parseGraphArgs(commandArgs);
      const result = await new SymbolGraphService().build({
        startPath: options.startPath,
        strictRoot: options.strictRoot
      });

      stdout(
        options.json
          ? JSON.stringify(result.graph, null, 2)
          : getGraphSummaryText(result)
      );

      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "index") {
    try {
      const options = parseIndexArgs(commandArgs);
      const result = await new IndexingService().index(options);
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getIndexSummaryText(result)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "search") {
    try {
      const options = parseSearchArgs(commandArgs);
      const result = await new IndexingService().search(options);
      stdout(options.json ? JSON.stringify(result, null, 2) : getSearchText(result));
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "intent") {
    try {
      const options = parseIntentArgs(commandArgs);
      const result = await new QueryIntentService().analyze(options);
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getIntentSummaryText(result)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "plan") {
    try {
      const options = parsePlanArgs(commandArgs);
      const service = new FeaturePlanningService();

      if (options.subcommand === "approve") {
        const result = await service.approvePlan({
          startPath: options.startPath,
          strictRoot: options.strictRoot,
          planId: options.planId,
          revision: options.revision as number,
          approvedBy: options.approvedBy as string,
          note: options.note
        });
        stdout(
          options.json
            ? JSON.stringify(result.plan, null, 2)
            : getPlanApproveText(result.plan)
        );
        return { exitCode: 0 };
      }

      if (options.subcommand === "revisions") {
        const revisions = await service.listRevisions({
          startPath: options.startPath,
          strictRoot: options.strictRoot,
          planId: options.planId
        });
        stdout(
          options.json
            ? JSON.stringify(revisions, null, 2)
            : getPlanRevisionsText(revisions)
        );
        return { exitCode: 0 };
      }

      if (options.subcommand === "show") {
        const plan = await service.showRevision({
          startPath: options.startPath,
          strictRoot: options.strictRoot,
          planId: options.planId,
          revision: options.revision
        });
        stdout(options.json ? JSON.stringify(plan, null, 2) : getPlanShowText(plan));
        return { exitCode: 0 };
      }

      if (options.subcommand === "diff") {
        const diff = await service.diffRevisions({
          startPath: options.startPath,
          strictRoot: options.strictRoot,
          planId: options.planId,
          from: options.from,
          to: options.to
        });
        stdout(options.json ? JSON.stringify(diff, null, 2) : getPlanDiffText(diff));
        return { exitCode: 0 };
      }

      const result = await service.createPlan(options);
      stdout(
        options.json ? JSON.stringify(result.plan, null, 2) : getPlanSummaryText(result)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "measure") {
    try {
      const options = parseMeasureArgs(commandArgs);
      const result = await new ContextMeasurementService().measure(options);
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getMeasureSummaryText(result)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "validate") {
    try {
      const options = parseValidateArgs(commandArgs);
      const result = await new ValidationService().validate({
        startPath: options.startPath,
        strictRoot: options.strictRoot,
        categories: options.categories,
        timeoutMs: options.timeoutMs,
        onOutput: options.stream
          ? (event) => {
              if (event.text.trim()) {
                stdout(`[${event.commandName}] ${event.text.trimEnd()}`);
              }
            }
          : undefined
      });
      stdout(
        options.json
          ? JSON.stringify(result.report, null, 2)
          : getValidateSummaryText(result)
      );
      return { exitCode: result.report.status === "passed" ? 0 : 1 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "review") {
    try {
      const options = parseReviewArgs(commandArgs);

      if (options.subcommand === "resolve") {
        const result = await new ReviewService().resolveFinding({
          startPath: options.startPath,
          findingId: options.findingId as string,
          decision: options.decision as "accept" | "decline",
          reason: options.reason as string,
          decidedBy: options.decidedBy as string,
          planRevision: options.planRevision
        });
        stdout(
          options.json ? JSON.stringify(result, null, 2) : getReviewResolveText(result)
        );
        return { exitCode: 0 };
      }

      const result = await new ReviewService().review(options);
      stdout(
        options.json ? JSON.stringify(result.report, null, 2) : getReviewText(result)
      );
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "handoff") {
    try {
      const options = parseHandoffArgs(commandArgs);
      const result = await new HandoffService().generate(options);
      stdout(options.json ? JSON.stringify(result, null, 2) : getHandoffText(result));
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "instructions") {
    try {
      const options = parseInstructionsArgs(commandArgs);
      const result = await runInstructionsCommand(options);
      stdout(options.json ? JSON.stringify(result.payload, null, 2) : result.text);
      return { exitCode: result.exitCode };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "workspace") {
    try {
      const options = parseWorkspaceArgs(commandArgs);
      const result = await runWorkspaceCommand(options);
      stdout(options.json ? JSON.stringify(result.payload, null, 2) : result.text);
      return { exitCode: result.exitCode };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "serve") {
    try {
      const options = parseServeArgs(commandArgs);
      const server = await startWebServer({
        startPath: options.startPath,
        host: options.host,
        port: options.port
      });
      stdout(
        options.json
          ? JSON.stringify(getServePayload(server), null, 2)
          : getServeText(server)
      );
      await waitForServeShutdown(server);
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "status") {
    try {
      const options = parseStatusArgs(commandArgs);
      const result = await getStatus(options);
      stdout(options.json ? JSON.stringify(result, null, 2) : getStatusText(result));
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "setup") {
    try {
      const options = parseSetupArgs(commandArgs);
      const result = await runSetupCommand(options);
      stdout(options.json ? JSON.stringify(result, null, 2) : getSetupText(result));
      return { exitCode: result.ok ? 0 : 1 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "copilot") {
    try {
      const options = parseCopilotArgs(commandArgs);
      const outcome = await runCopilotCommand(options);
      stdout(options.json ? JSON.stringify(outcome, null, 2) : outcome.message);
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "dashboard") {
    try {
      const options = parseDashboardArgs(commandArgs);
      const result = await buildDashboardPayload(options);
      stdout(options.json ? JSON.stringify(result, null, 2) : result.html);
      return { exitCode: 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "diagnostics") {
    try {
      const options = parseStatusArgs(commandArgs);
      const result = await new AdvancedAnalysisService().diagnose({
        startPath: options.startPath
      });
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getDiagnosticsText(result)
      );
      return { exitCode: result.status === "error" ? 1 : 0 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  if (rawCommand === "demo") {
    try {
      const options = parseDemoArgs(commandArgs);
      const result = await runDemo({ startPath: options.startPath, stdout });
      stdout(
        options.json ? JSON.stringify(result, null, 2) : getDemoSummaryText(result)
      );
      return { exitCode: result.success ? 0 : 1 };
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }

  stdout(getCommandHelpText(rawCommand));
  return { exitCode: 0 };
}

interface AnalyzeCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  outputPath?: string;
  json: boolean;
}

interface GraphCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  json: boolean;
}

interface IntentCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  query: string;
  json: boolean;
  limit?: number;
}

interface MeasureCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  request: string;
  json: boolean;
}

interface InitCliOptions {
  startPath?: string;
  overwrite?: boolean;
  json: boolean;
}

interface McpCliOptions {
  subcommand: "start" | "config";
  startPath?: string;
  force?: boolean;
  toolset?: string;
  json: boolean;
}

interface JsonOnlyCliOptions {
  json: boolean;
}

function parseJsonOnlyArgs(args: string[], command: string): JsonOnlyCliOptions {
  const options: JsonOnlyCliOptions = { json: false };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown ${command} argument: ${arg}`);
  }

  return options;
}

function parseMcpArgs(args: string[]): McpCliOptions {
  const [maybeSubcommand, ...rest] = args;
  const isConfig = maybeSubcommand === "config";
  const values = isConfig ? rest : args;
  const options: McpCliOptions = {
    subcommand: isConfig ? "config" : "start",
    json: false
  };

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];

    if (arg === "--path") {
      const startPath = values[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--toolset") {
      const toolset = values[index + 1];

      if (!toolset) {
        throw new Error("Missing value for --toolset");
      }

      options.toolset = toolset;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown mcp argument: ${arg}`);
  }

  return options;
}

function parseInitArgs(args: string[]): InitCliOptions {
  const options: InitCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }

    if (arg === "--path") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    throw new Error(`Unknown init argument: ${arg}`);
  }

  return options;
}

interface CommandsCliOptions {
  subcommand: "validate" | "list";
  startPath?: string;
  json: boolean;
}

function parseCommandsArgs(args: string[]): CommandsCliOptions {
  const [subcommand, ...rest] = args;

  if (subcommand !== "validate" && subcommand !== "list") {
    throw new Error("Expected commands subcommand: validate or list");
  }

  const options: CommandsCliOptions = {
    subcommand,
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      const startPath = rest[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    throw new Error(`Unknown commands argument: ${arg}`);
  }

  return options;
}

interface PolicyCliOptions {
  subcommand: "show" | "validate";
  startPath?: string;
  json: boolean;
}

function parsePolicyArgs(args: string[]): PolicyCliOptions {
  const [subcommand, ...rest] = args;

  if (subcommand !== "show" && subcommand !== "validate") {
    throw new Error("Expected policy subcommand: show or validate");
  }

  const options: PolicyCliOptions = {
    subcommand,
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      const startPath = rest[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    throw new Error(`Unknown policy argument: ${arg}`);
  }

  return options;
}

interface AuditCliOptions {
  subcommand: "list";
  startPath?: string;
  limit?: number;
  json: boolean;
}

function parseAuditArgs(args: string[]): AuditCliOptions {
  const [subcommand, ...rest] = args;

  if (subcommand !== "list") {
    throw new Error("Expected audit subcommand: list");
  }

  const options: AuditCliOptions = {
    subcommand,
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--limit") {
      const limit = Number(rest[index + 1]);

      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("Missing or invalid value for --limit");
      }

      options.limit = limit;
      index += 1;
      continue;
    }

    if (arg === "--path") {
      const startPath = rest[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    throw new Error(`Unknown audit argument: ${arg}`);
  }

  return options;
}

interface CleanupCliOptions {
  startPath?: string;
  dryRun?: boolean;
  maxAgeDays?: number;
  maxRuns?: number;
  json: boolean;
}

function parseCleanupArgs(args: string[]): CleanupCliOptions {
  const options: CleanupCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--apply") {
      options.dryRun = false;
      continue;
    }

    if (arg === "--max-age-days") {
      const value = Number(args[index + 1]);

      if (!Number.isFinite(value) || value < 0) {
        throw new Error("Missing or invalid value for --max-age-days");
      }

      options.maxAgeDays = value;
      index += 1;
      continue;
    }

    if (arg === "--max-runs") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value < 1) {
        throw new Error("Missing or invalid value for --max-runs");
      }

      options.maxRuns = value;
      index += 1;
      continue;
    }

    if (arg === "--path") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error("Missing value for --path");
      }

      options.startPath = startPath;
      index += 1;
      continue;
    }

    throw new Error(`Unknown cleanup argument: ${arg}`);
  }

  return options;
}

function parseAnalyzeArgs(args: string[]): AnalyzeCliOptions {
  const options: AnalyzeCliOptions = {
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--output") {
      const outputPath = args[index + 1];

      if (!outputPath) {
        throw new Error("Missing value for --output");
      }

      options.outputPath = outputPath;
      index += 1;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (!arg.startsWith("-") && !options.startPath) {
      options.startPath = arg;
      continue;
    }

    throw new Error(`Unknown analyze argument: ${arg}`);
  }

  return options;
}

function parseGraphArgs(args: string[]): GraphCliOptions {
  const options: GraphCliOptions = {
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (!arg.startsWith("-") && !options.startPath) {
      options.startPath = arg;
      continue;
    }

    throw new Error(`Unknown graph argument: ${arg}`);
  }

  return options;
}

function getGraphSummaryText(result: SymbolGraphResult): string {
  const { graph } = result;
  const kindCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
  }
  const edgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeCounts.set(edge.kind, (edgeCounts.get(edge.kind) ?? 0) + 1);
  }

  return [
    `${PROJECT_NAME}: graph`,
    "",
    `Nodes: ${graph.nodes.length} (${[...kindCounts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"})`,
    `Edges: ${graph.edges.length} (${[...edgeCounts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"})`,
    `Diagnostics: ${graph.diagnostics.length}`,
    `Graph JSON: ${result.jsonPath}`
  ].join("\n");
}

function getAnalyzeSummaryText(
  repoMapPath: string,
  summary: {
    summary: string;
    repoCount: number;
    projectCount: number;
    primaryLanguages: string[];
    primaryFrameworks: string[];
  }
): string {
  return [
    `${PROJECT_NAME}: analyze`,
    "",
    summary.summary,
    `Repos: ${summary.repoCount}`,
    `Projects: ${summary.projectCount}`,
    `Languages: ${summary.primaryLanguages.join(", ") || "unknown"}`,
    `Frameworks: ${summary.primaryFrameworks.join(", ") || "unknown"}`,
    `Repo map: ${repoMapPath}`
  ].join("\n");
}

function getInitSummaryText(
  result: CommandConfigInitResult,
  policyResult: SafetyPolicyInitResult
): string {
  return [
    `${PROJECT_NAME}: init`,
    "",
    result.message,
    `Commands config: ${result.configPath}`,
    `Commands created: ${result.created ? "yes" : "no"}`,
    policyResult.message,
    `Policy config: ${policyResult.policyPath}`,
    `Policy created: ${policyResult.created ? "yes" : "no"}`
  ].join("\n");
}

function getCommandsValidateText(result: CommandConfigValidationResult): string {
  const lines = [
    `${PROJECT_NAME}: commands validate`,
    "",
    `Config: ${result.configPath}`,
    `Status: ${result.ok ? "ok" : "error"}`
  ];

  if (result.errors.length > 0) {
    lines.push("", "Errors:", ...result.errors.map((error) => `- ${error}`));
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.parsed) {
    lines.push(`Commands: ${result.parsed.commands.length}`);
  }

  return lines.join("\n");
}

function getCommandsListText(config: ParsedCommandConfig): string {
  const lines = [
    `${PROJECT_NAME}: commands list`,
    "",
    `Config: ${config.configPath}`,
    `Commands: ${config.commands.length}`
  ];

  if (config.warnings.length > 0) {
    lines.push("", "Warnings:", ...config.warnings.map((warning) => `- ${warning}`));
  }

  for (const customCommand of config.commands) {
    const command = customCommand.command;
    const cwd = command.cwd ? ` [cwd: ${command.cwd}]` : "";
    const override = customCommand.overrideDetected ? " override" : "";

    lines.push(
      "",
      `${customCommand.category}: ${command.name}${cwd}${override}`,
      `  ${[command.command, ...command.args].join(" ")}`
    );
  }

  return lines.join("\n");
}

function getMcpConfigText(result: CopilotChatMcpConfigResult): string {
  return [
    `${PROJECT_NAME}: mcp config`,
    "",
    `Status: ${result.status}`,
    `Server: ${result.serverName}`,
    `Config: ${result.configPath}`,
    `Backup: ${result.backupPath ?? "none"}`,
    `Command: ${result.config.servers.copilotArchitect.command}`,
    `Args: ${result.config.servers.copilotArchitect.args.join(" ")}`,
    ...result.messages.map((message) => `- ${message}`)
  ].join("\n");
}

function getPolicyValidateText(result: SafetyPolicyValidationResult): string {
  const lines = [
    `${PROJECT_NAME}: policy validate`,
    "",
    `Policy: ${result.policyPath}`,
    `Status: ${result.ok ? "ok" : "error"}`,
    `Blocked patterns: ${result.policy.blockedPatterns.length}`,
    `Secret redaction patterns: ${result.policy.secretRedactionPatterns.length}`
  ];

  if (result.errors.length > 0) {
    lines.push("", "Errors:", ...result.errors.map((error) => `- ${error}`));
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function getAuditListText(result: AuditListResult): string {
  const lines = [
    `${PROJECT_NAME}: audit list`,
    "",
    `Audit log: ${result.auditPath}`,
    `Entries: ${result.entries.length}`
  ];

  for (const entry of result.entries) {
    lines.push("", `${entry.timestamp} ${entry.actor} ${entry.action}`, entry.summary);
  }

  return lines.join("\n");
}

function getCleanupText(result: ArtifactCleanupResult): string {
  const lines = [
    `${PROJECT_NAME}: cleanup`,
    "",
    `Artifact root: ${result.artifactRoot}`,
    `Policy: ${result.policyPath}`,
    `Mode: ${result.dryRun ? "dry-run" : "apply"}`,
    `Retention: ${result.retentionEnabled ? "enabled" : "disabled"}`,
    `Max age days: ${result.maxAgeDays}`,
    `Max files per directory: ${result.maxRuns}`,
    `Directories: ${result.directories.join(", ") || "none"}`,
    `Scanned files: ${result.scannedFiles}`,
    `Eligible artifacts: ${result.candidates.length}`,
    `Deleted artifacts: ${result.deleted.length}`,
    `Summary: ${result.summary}`
  ];

  if (result.candidates.length > 0) {
    lines.push(
      "",
      "Candidates:",
      ...result.candidates.slice(0, 20).map((candidate) => {
        const relative = path.relative(result.artifactRoot, candidate.path);
        return `- ${candidate.reason}: ${relative} (${candidate.ageDays} day(s))`;
      })
    );
  }

  if (result.errors.length > 0) {
    lines.push("", "Errors:", ...result.errors.map((error) => `- ${error}`));
  }

  return lines.join("\n");
}

interface IndexCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  rebuild?: boolean;
  json: boolean;
}

function parseIndexArgs(args: string[]): IndexCliOptions {
  const options: IndexCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (!arg.startsWith("-") && !options.startPath) {
      options.startPath = arg;
      continue;
    }

    throw new Error(`Unknown index argument: ${arg}`);
  }

  return options;
}

interface SearchCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  query: string;
  json: boolean;
  limit?: number;
}

function parseSearchArgs(args: string[]): SearchCliOptions {
  const queryParts: string[] = [];
  const options: SearchCliOptions = {
    query: "",
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--limit") {
      const limit = Number(args[index + 1]);

      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("Missing or invalid value for --limit");
      }

      options.limit = limit;
      index += 1;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown search argument: ${arg}`);
    }

    queryParts.push(arg);
  }

  options.query = queryParts.join(" ").trim();

  if (!options.query) {
    throw new Error("Missing search query");
  }

  return options;
}

function parseIntentArgs(args: string[]): IntentCliOptions {
  const queryParts: string[] = [];
  const options: IntentCliOptions = {
    query: "",
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--limit") {
      const limit = Number(args[index + 1]);

      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("Missing or invalid value for --limit");
      }

      options.limit = limit;
      index += 1;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown intent argument: ${arg}`);
    }

    queryParts.push(arg);
  }

  options.query = queryParts.join(" ").trim();

  if (!options.query) {
    throw new Error("Missing intent query");
  }

  return options;
}

function parseMeasureArgs(args: string[]): MeasureCliOptions {
  const requestParts: string[] = [];
  const options: MeasureCliOptions = {
    request: "",
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown measure argument: ${arg}`);
    }

    requestParts.push(arg);
  }

  options.request = requestParts.join(" ").trim();

  if (!options.request) {
    throw new Error("Missing measure request");
  }

  return options;
}

function getIndexSummaryText(result: IndexResult): string {
  return [
    `${PROJECT_NAME}: index`,
    "",
    `Mode: ${result.mode}`,
    `Documents: ${result.index.stats.documentCount}`,
    `Tests: ${result.index.stats.testFileCount}`,
    `Configs: ${result.index.stats.configFileCount}`,
    `Docs: ${result.index.stats.docFileCount}`,
    `Index: ${result.indexPath}`,
    `Status: ${result.statusPath}`
  ].join("\n");
}

function getSearchText(response: SearchResponse): string {
  const lines = [
    `${PROJECT_NAME}: search`,
    "",
    `Query: ${response.query}`,
    `Results: ${response.results.length}`
  ];

  for (const result of response.results) {
    lines.push(
      "",
      `${result.relativePath} (${result.languageGuess}, score ${result.score})`,
      `Matched: ${result.matchedFields.join(", ")}`
    );
    if (result.anchor) {
      lines.push(
        `Anchor: ${result.anchor.symbol} (${result.anchor.kind}) line ${result.anchor.line ?? "?"}`
      );
    }
    if (result.textPreview) {
      // Include a code snippet so callers (e.g. the LM) can see what's in the file.
      lines.push("---");
      lines.push(result.textPreview.slice(0, 800).trimEnd());
      lines.push("---");
    }
  }

  return lines.join("\n");
}

function getIntentSummaryText(result: QueryIntentResult): string {
  const lines = [
    `${PROJECT_NAME}: intent`,
    "",
    `Query: ${result.query}`,
    `Intent: ${result.intent}`,
    `Entities: ${result.entities.join(", ") || "none"}`,
    `Refined query: ${result.refinedQuery}`
  ];

  const section = (title: string, items: RelevantFileSummary[]) => {
    lines.push("", `${title} (${items.length})`);
    for (const item of items) {
      lines.push(`- ${item.filePath} (score ${item.score}) — ${item.reason}`);
    }
  };

  section("Likely components", result.likelyComponents);
  section("Relevant tests", result.relevantTests);
  section("Recent changes", result.recentChanges);

  return lines.join("\n");
}

function getMeasureSummaryText(result: ContextMeasurement): string {
  return [
    `${PROJECT_NAME}: measure`,
    "",
    `Request: ${result.request}`,
    `Naive whole repo: ${result.naiveWholeRepo.fileCount} files, ~${result.naiveWholeRepo.estimatedTokens} tokens`,
    `Current tool selection: ${result.currentToolSelection.relevantFileCount} relevant file(s), ` +
      `${result.currentToolSelection.filesReadableOnDisk} readable on disk, ~${result.currentToolSelection.estimatedTokens} tokens`,
    `Estimated token reduction: ${result.estimatedTokenReductionPercent}%`
  ].join("\n");
}

interface PlanCliOptions {
  subcommand: "generate" | "approve" | "revisions" | "show" | "diff";
  request: string;
  planId?: string;
  revision?: number;
  approvedBy?: string;
  note?: string;
  /** `plan diff` only. */
  from?: number;
  to?: number;
  startPath?: string;
  strictRoot?: boolean;
  json: boolean;
}

interface ValidateCliOptions {
  startPath?: string;
  strictRoot?: boolean;
  categories?: CommandConfigCategory[];
  timeoutMs?: number;
  json: boolean;
  stream: boolean;
}

function parseValidateArgs(args: string[]): ValidateCliOptions {
  const categories: CommandConfigCategory[] = [];
  const options: ValidateCliOptions = {
    json: false,
    stream: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--build") {
      categories.push("build");
      continue;
    }

    if (arg === "--test") {
      categories.push("test");
      continue;
    }

    if (arg === "--lint") {
      categories.push("lint");
      continue;
    }

    if (arg === "--format") {
      categories.push("format");
      continue;
    }

    if (arg === "--validation") {
      categories.push("validation");
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--stream") {
      options.stream = true;
      continue;
    }

    if (arg === "--timeout-ms") {
      const timeoutMs = Number(args[index + 1]);

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Missing or invalid value for --timeout-ms");
      }

      options.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = args[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    throw new Error(`Unknown validate argument: ${arg}`);
  }

  options.categories = categories.length > 0 ? categories : undefined;

  return options;
}

function parsePlanArgs(args: string[]): PlanCliOptions {
  const subcommand: PlanCliOptions["subcommand"] =
    args[0] === "approve" ||
    args[0] === "revisions" ||
    args[0] === "show" ||
    args[0] === "diff"
      ? args[0]
      : "generate";
  const rest = subcommand === "generate" ? args : args.slice(1);
  const requestParts: string[] = [];
  const options: PlanCliOptions = {
    subcommand,
    request: "",
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path" || arg === "--root") {
      const startPath = rest[index + 1];

      if (!startPath) {
        throw new Error(`Missing value for ${arg}`);
      }

      options.startPath = startPath;
      options.strictRoot = arg === "--root";
      index += 1;
      continue;
    }

    if (arg === "--plan-id") {
      const planId = rest[index + 1];

      if (!planId) {
        throw new Error("Missing value for --plan-id");
      }

      options.planId = planId;
      index += 1;
      continue;
    }

    if (arg === "--revision") {
      const revision = Number(rest[index + 1]);

      if (!Number.isFinite(revision)) {
        throw new Error("Missing or invalid value for --revision");
      }

      options.revision = revision;
      index += 1;
      continue;
    }

    if (arg === "--from") {
      const from = Number(rest[index + 1]);

      if (!Number.isFinite(from)) {
        throw new Error("Missing or invalid value for --from");
      }

      options.from = from;
      index += 1;
      continue;
    }

    if (arg === "--to") {
      const to = Number(rest[index + 1]);

      if (!Number.isFinite(to)) {
        throw new Error("Missing or invalid value for --to");
      }

      options.to = to;
      index += 1;
      continue;
    }

    if (arg === "--by") {
      const approvedBy = rest[index + 1];

      if (!approvedBy) {
        throw new Error("Missing value for --by");
      }

      options.approvedBy = approvedBy;
      index += 1;
      continue;
    }

    if (arg === "--note") {
      const note = rest[index + 1];

      if (!note) {
        throw new Error("Missing value for --note");
      }

      options.note = note;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown plan argument: ${arg}`);
    }

    requestParts.push(arg);
  }

  options.request = requestParts.join(" ").trim();

  if (subcommand === "generate" && !options.request) {
    throw new Error("Missing feature request");
  }

  if (subcommand === "approve") {
    // Both checked together. Reporting one at a time made approving a plan a
    // guessing game played against error messages: run it, learn about
    // --revision, run it again, learn about --by. The command a reader needs
    // is printed whole rather than assembled from two failures.
    const missing: string[] = [];
    if (options.revision === undefined) missing.push("--revision <n>");
    if (!options.approvedBy) missing.push("--by <name>");

    if (missing.length > 0) {
      throw new Error(
        `plan approve requires ${missing.join(" and ")}. ` +
          `Usage: ${cliInvocation()} plan approve --revision <n> --by <name>`
      );
    }
  }

  return options;
}

function getPlanSummaryText(result: FeaturePlanningResult): string {
  return [
    `${PROJECT_NAME}: plan`,
    "",
    result.plan.title,
    `Status: ${result.plan.status}`,
    `Relevant files: ${result.plan.relevantFiles.length}`,
    `Validation commands: ${result.plan.validationPlan.commands.length}`,
    `Plan quality: ${result.plan.planQuality.score}/100 (${result.plan.planQuality.level} risk)`,
    `Risk scores: ${result.plan.riskScores.length}`,
    `Requires approval: ${result.plan.requiresHumanApproval ? "yes" : "no"}`,
    `Plan JSON: ${result.jsonPath}`,
    `Plan Markdown: ${result.markdownPath}`,
    `Latest JSON: ${result.latestJsonPath}`,
    `Latest Markdown: ${result.latestMarkdownPath}`
  ].join("\n");
}

function getPlanApproveText(plan: FeaturePlanArtifact): string {
  return [
    `${PROJECT_NAME}: plan approve`,
    "",
    plan.title,
    `Plan ID: ${plan.id}`,
    `Revision: ${plan.revision}`,
    `Status: ${plan.status}`,
    `Approved by: ${plan.approval?.approvedBy ?? "unknown"}`,
    `Approved at: ${plan.approval?.approvedAt ?? "unknown"}`,
    ...(plan.approval?.note ? [`Note: ${plan.approval.note}`] : [])
  ].join("\n");
}

function getPlanRevisionsText(revisions: PlanRevisionSummary[]): string {
  if (revisions.length === 0) {
    return `${PROJECT_NAME}: plan revisions\n\nNo revisions found.`;
  }

  return [
    `${PROJECT_NAME}: plan revisions`,
    "",
    ...revisions.map(
      (revision) =>
        `rev ${revision.revision} - ${revision.status} (${revision.source}, ${revision.at})${
          revision.approval
            ? ` - approved by ${revision.approval.approvedBy} at ${revision.approval.approvedAt}`
            : ""
        }`
    )
  ].join("\n");
}

function getPlanShowText(plan: FeaturePlanArtifact): string {
  return [
    `${PROJECT_NAME}: plan show`,
    "",
    plan.title,
    `Plan ID: ${plan.id}`,
    `Revision: ${plan.revision}`,
    `Status: ${plan.status}`,
    `Task: ${plan.task}`,
    `Summary: ${plan.summary}`,
    plan.approval
      ? `Approved by ${plan.approval.approvedBy} at ${plan.approval.approvedAt}`
      : "Not approved."
  ].join("\n");
}

function getPlanDiffText(diff: PlanRevisionDiffResult): string {
  const header = [
    `${PROJECT_NAME}: plan diff`,
    "",
    `Plan ID: ${diff.planId}`,
    `Revision ${diff.from} → ${diff.to}`,
    ...(diff.feedback ? [`Feedback: ${diff.feedback}`] : [])
  ];

  if (diff.changes.length === 0) {
    return [...header, "", "No differences between these revisions."].join("\n");
  }

  const body = diff.changes.flatMap((change) => {
    if (change.kind === "list") {
      return [
        "",
        `${change.field}:`,
        ...(change.added ?? []).map((item) => `  + ${item}`),
        ...(change.removed ?? []).map((item) => `  - ${item}`)
      ];
    }

    return [
      "",
      `${change.field}:`,
      `  before: ${change.before}`,
      `  after:  ${change.after}`
    ];
  });

  return [...header, ...body].join("\n");
}

function getValidateSummaryText(result: ValidationRunResult): string {
  const report = result.report;

  return [
    `${PROJECT_NAME}: validate`,
    "",
    `Status: ${report.status}`,
    report.summary,
    `Commands: ${report.results.length}`,
    `Failures: ${report.failureSummary.length}`,
    `Validation JSON: ${report.artifactPaths.timestampJsonPath}`,
    `Validation Markdown: ${report.artifactPaths.timestampMarkdownPath}`,
    `Validation Logs: ${report.artifactPaths.timestampLogPath}`,
    `Latest JSON: ${report.artifactPaths.latestJsonPath}`,
    `Latest Markdown: ${report.artifactPaths.latestMarkdownPath}`
  ].join("\n");
}

interface ReviewCliOptions {
  subcommand: "generate" | "resolve";
  startPath?: string;
  plan?: string;
  validation?: string;
  findingId?: string;
  decision?: "accept" | "decline";
  reason?: string;
  decidedBy?: string;
  planRevision?: number;
  json: boolean;
}

interface HandoffCliOptions {
  startPath?: string;
  plan?: string;
  approved?: boolean;
  targetAgent?: HandoffPrompt["targetAgent"];
  copyToClipboard?: boolean;
  json: boolean;
}

interface InstructionsCliOptions {
  subcommand: "generate" | "preview" | "validate";
  startPath?: string;
  outputPath?: string;
  json: boolean;
}

interface WorkspaceCliOptions {
  subcommand:
    | "init"
    | "show"
    | "list"
    | "add"
    | "remove"
    | "scan"
    | "index"
    | "search"
    | "impact"
    | "plan"
    | "validate-plan";
  startPath?: string;
  workspaceName?: string;
  repoName?: string;
  repoPath?: string;
  role?: string;
  query?: string;
  request?: string;
  plan?: string;
  rebuild?: boolean;
  limit?: number;
  json: boolean;
}

interface StatusCliOptions {
  startPath?: string;
  json: boolean;
}

interface DashboardCliOptions {
  startPath?: string;
  mcpStatus?: "stopped" | "starting" | "running";
  lastCommand?: string;
  lastExitCode?: number;
  lastStdout?: string;
  lastStderr?: string;
  /** Text to keep in the Copilot panel's box across a re-render. */
  task?: string;
  /** One line shown at the top of the Copilot panel — what the last click did. */
  notice?: string;
  noticeIsError?: boolean;
  json: boolean;
}

/**
 * The dashboard's action row, rendered as a host-neutral `architect-action:`
 * URI scheme rather than VS Code's `command:` scheme — a shell that isn't
 * VS Code (IntelliJ's JBCefBrowser) intercepts clicks on this scheme itself
 * and dispatches to its own command handling; the CLI only needs to name the
 * action, never to run it. IDs mirror `COPILOT_ARCHITECT_COMMANDS`/
 * `DASHBOARD_PRIMARY_ACTIONS`/`COPILOT_ARCHITECT_SECONDARY_ACTIONS` in
 * `vscode-extension/src/index.ts` so both shells agree on what each action
 * means, without either importing the other's command table.
 */
const DASHBOARD_ACTION_LINKS: { id: string; label: string }[] = [
  { id: "setupRepo", label: "Setup Repo" },
  { id: "startAndSetupMcp", label: "Start & Setup MCP" },
  { id: "stopMcp", label: "Stop MCP" },
  { id: "generateInstructions", label: "Generate Instructions" }
];

const DASHBOARD_SECONDARY_ACTION_LINKS: { id: string; label: string }[] = [
  { id: "openRepoInNewWindow", label: "Open Repo" },
  { id: "workspaceScan", label: "Scan & Register Sub-repos" },
  { id: "analyzeRepo", label: "Analyze Repo" },
  { id: "buildIndex", label: "Build Index" },
  { id: "buildGraph", label: "Build Symbol Graph" }
];

function renderArchitectActionLink(action: { id: string; label: string }): string {
  return `<a href="architect-action:${action.id}">${escapeHtml(action.label)}</a>`;
}

/**
 * Plan actions, unlike every other action link, carry a revision number in
 * their own id (`approvePlan:<n>`, `showPlanDiff:<n>`) rather than being a
 * fixed id — `approve_plan` is deliberately excluded from the `intellij` MCP
 * toolset (see MCP_TOOLSETS in packages/mcp-server) precisely so "approve
 * it" typed in Copilot Chat can never become a real approval, so this is the
 * only click surface that can promote a draft revision at all. The revision
 * baked into the id is the one this exact render showed the developer —
 * `plan approve` never infers "whatever is newest" (see
 * FeaturePlanningService.approvePlan), so the id must not either.
 *
 * "Show Plan Diff" is offered only once a prior revision exists to diff
 * against; "Approve Plan" only while the latest revision is still a draft.
 */
function buildPlanActionLinks(
  latestPlan: DashboardArtifacts["latestPlan"]
): { id: string; label: string }[] {
  if (!latestPlan || latestPlan.revision === undefined) {
    return [];
  }

  const links: { id: string; label: string }[] = [];

  if ((latestPlan.revisionCount ?? 0) > 1) {
    links.push({
      id: `showPlanDiff:${latestPlan.revision}`,
      label: `Show Plan Diff (rev ${latestPlan.revision})`
    });
  }

  if (latestPlan.status === "draft") {
    links.push({
      id: `approvePlan:${latestPlan.revision}`,
      label: `Approve Plan (rev ${latestPlan.revision})`
    });
  }

  return links;
}

function buildDashboardActionsHtml(
  latestPlan: DashboardArtifacts["latestPlan"]
): string {
  return [
    ...DASHBOARD_ACTION_LINKS,
    ...DASHBOARD_SECONDARY_ACTION_LINKS,
    ...buildPlanActionLinks(latestPlan)
  ]
    .map(renderArchitectActionLink)
    .join("");
}

export interface DashboardCliResult {
  html: string;
  workspaceRoot: string;
  artifacts: DashboardArtifacts;
  session: DashboardSession | undefined;
}

interface SetupCliOptions {
  startPath?: string;
  /** Every currently-registered repo (minus the auto-registered workspace-root entry), not just one. */
  workspace?: boolean;
  json: boolean;
}

export interface SetupStepResult {
  label: string;
  ok: boolean;
  error?: string;
}

export interface SetupCliResult {
  mode: "single" | "workspace";
  root: string;
  steps: SetupStepResult[];
  ok: boolean;
}

interface ServeCliOptions {
  startPath?: string;
  host?: string;
  port?: number;
  json: boolean;
}

interface CliCommandExecutionResult {
  exitCode: number;
  text: string;
  payload: unknown;
}

function parseReviewArgs(args: string[]): ReviewCliOptions {
  const subcommand: ReviewCliOptions["subcommand"] =
    args[0] === "resolve" ? "resolve" : "generate";
  const rest = subcommand === "resolve" ? args.slice(1) : args;
  const options: ReviewCliOptions = { subcommand, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(rest, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--plan") {
      options.plan = requiredValue(rest, index, "--plan");
      index += 1;
      continue;
    }

    if (arg === "--validation") {
      options.validation = requiredValue(rest, index, "--validation");
      index += 1;
      continue;
    }

    if (arg === "--finding-id") {
      options.findingId = requiredValue(rest, index, "--finding-id");
      index += 1;
      continue;
    }

    if (arg === "--decision") {
      const value = requiredValue(rest, index, "--decision");

      if (value !== "accept" && value !== "decline") {
        throw new Error("--decision must be 'accept' or 'decline'");
      }

      options.decision = value;
      index += 1;
      continue;
    }

    if (arg === "--reason") {
      options.reason = requiredValue(rest, index, "--reason");
      index += 1;
      continue;
    }

    if (arg === "--by") {
      options.decidedBy = requiredValue(rest, index, "--by");
      index += 1;
      continue;
    }

    if (arg === "--plan-revision") {
      const value = Number(requiredValue(rest, index, "--plan-revision"));

      if (!Number.isFinite(value)) {
        throw new Error("Invalid value for --plan-revision");
      }

      options.planRevision = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown review argument: ${arg}`);
  }

  if (subcommand === "resolve") {
    if (!options.findingId) {
      throw new Error("review resolve requires --finding-id <id>");
    }

    if (!options.decision) {
      throw new Error("review resolve requires --decision accept|decline");
    }

    if (!options.reason) {
      throw new Error("review resolve requires --reason <text>");
    }

    if (!options.decidedBy) {
      throw new Error("review resolve requires --by <name>");
    }
  }

  return options;
}

function parseServeArgs(args: string[]): ServeCliOptions {
  const options: ServeCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(args, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--host") {
      options.host = requiredValue(args, index, "--host");
      index += 1;
      continue;
    }

    if (arg === "--port") {
      options.port = parsePositiveInteger(
        requiredValue(args, index, "--port"),
        "--port"
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown serve argument: ${arg}`);
  }

  return options;
}

function parseHandoffArgs(args: string[]): HandoffCliOptions {
  const options: HandoffCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--approve" || arg === "--approved") {
      options.approved = true;
      continue;
    }

    if (arg === "--no-clipboard") {
      options.copyToClipboard = false;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(args, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--plan") {
      options.plan = requiredValue(args, index, "--plan");
      index += 1;
      continue;
    }

    if (arg === "--target") {
      options.targetAgent = parseTargetAgent(requiredValue(args, index, "--target"));
      index += 1;
      continue;
    }

    throw new Error(`Unknown handoff argument: ${arg}`);
  }

  return options;
}

function parseInstructionsArgs(args: string[]): InstructionsCliOptions {
  const [subcommand, ...rest] = args;

  if (
    subcommand !== "generate" &&
    subcommand !== "preview" &&
    subcommand !== "validate"
  ) {
    throw new Error("Expected instructions subcommand: generate, preview, or validate");
  }

  const options: InstructionsCliOptions = { subcommand, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(rest, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--output") {
      options.outputPath = requiredValue(rest, index, "--output");
      index += 1;
      continue;
    }

    throw new Error(`Unknown instructions argument: ${arg}`);
  }

  return options;
}

function parseWorkspaceArgs(args: string[]): WorkspaceCliOptions {
  const [subcommand, ...rest] = args;

  if (!isWorkspaceSubcommand(subcommand)) {
    throw new Error(
      "Expected workspace subcommand: init, show, list, add, remove, scan, index, search, impact, plan, or validate-plan"
    );
  }

  const options: WorkspaceCliOptions = { subcommand, json: false };
  const textParts: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(rest, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--repo") {
      options.repoPath = requiredValue(rest, index, "--repo");
      index += 1;
      continue;
    }

    if (arg === "--name") {
      options.workspaceName = requiredValue(rest, index, "--name");
      index += 1;
      continue;
    }

    if (arg === "--role") {
      options.role = requiredValue(rest, index, "--role");
      index += 1;
      continue;
    }

    if (arg === "--plan") {
      options.plan = requiredValue(rest, index, "--plan");
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number(requiredValue(rest, index, "--limit"));

      if (!Number.isFinite(options.limit) || options.limit <= 0) {
        throw new Error("Missing or invalid value for --limit");
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown workspace argument: ${arg}`);
    }

    textParts.push(arg);
  }

  if (options.subcommand === "add" && !options.repoPath) {
    if (textParts.length >= 2) {
      options.repoName = textParts.shift();
      options.repoPath = textParts.shift();
    } else {
      options.repoPath = textParts.shift();
    }
  }

  if (options.subcommand === "scan" && !options.repoPath) {
    options.repoPath = textParts.shift();
  }

  if (options.subcommand === "add" && options.repoPath && !options.repoName) {
    options.repoName = textParts.shift();
  }

  if (options.subcommand === "remove") {
    options.repoName = textParts.join(" ").trim() || options.repoPath;
  }

  if (options.subcommand === "init" && !options.workspaceName) {
    options.workspaceName = textParts.join(" ").trim() || undefined;
  }

  if (options.subcommand === "search") {
    options.query = textParts.join(" ").trim();
  }

  if (options.subcommand === "impact" || options.subcommand === "plan") {
    options.request = textParts.join(" ").trim();
  }

  return options;
}

function parseStatusArgs(args: string[]): StatusCliOptions {
  const options: StatusCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(args, index, "--path");
      index += 1;
      continue;
    }

    throw new Error(`Unknown status argument: ${arg}`);
  }

  return options;
}

function parseDashboardArgs(args: string[]): DashboardCliOptions {
  const options: DashboardCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(args, index, "--path");
      index += 1;
      continue;
    }

    if (arg === "--mcp-status") {
      const value = requiredValue(args, index, "--mcp-status");
      if (value !== "stopped" && value !== "starting" && value !== "running") {
        throw new Error(
          `Invalid --mcp-status value: ${value} (expected stopped, starting, or running)`
        );
      }
      options.mcpStatus = value;
      index += 1;
      continue;
    }

    if (arg === "--last-command") {
      options.lastCommand = requiredValue(args, index, "--last-command");
      index += 1;
      continue;
    }

    if (arg === "--last-exit-code") {
      const value = requiredValue(args, index, "--last-exit-code");
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error(`Invalid --last-exit-code value: ${value}`);
      }
      options.lastExitCode = parsed;
      index += 1;
      continue;
    }

    if (arg === "--last-stdout") {
      options.lastStdout = requiredValue(args, index, "--last-stdout");
      index += 1;
      continue;
    }

    if (arg === "--last-stderr") {
      options.lastStderr = requiredValue(args, index, "--last-stderr");
      index += 1;
      continue;
    }

    if (arg === "--task") {
      options.task = requiredValue(args, index, "--task");
      index += 1;
      continue;
    }

    if (arg === "--notice") {
      options.notice = requiredValue(args, index, "--notice");
      index += 1;
      continue;
    }

    if (arg === "--notice-error") {
      options.noticeIsError = true;
      continue;
    }

    throw new Error(`Unknown dashboard argument: ${arg}`);
  }

  return options;
}

/**
 * Builds the same dashboard any shell renders, for a shell that is not
 * VS Code and cannot import `@copilot-architect/dashboard` directly — the
 * IntelliJ plugin, or any other non-Node host. It spawns this CLI command
 * and reads the HTML (or, with `--json`, the underlying data) from stdout,
 * the same "shell spawns CLI, never reimplements the logic" pattern the
 * VS Code extension already follows for everything else.
 *
 * `mcpStatus` defaults to "stopped" and `lastCommand`/`lastExitCode`/
 * `lastStdout`/`lastStderr` are absent by default: a one-shot CLI invocation
 * has no running process and no command history of its own to introspect,
 * and guessing would be worse than saying so. A long-lived caller that does
 * track its own state (the IntelliJ plugin, keeping its MCP process handle
 * and the outcome of the last action a user clicked) passes it back in
 * through `--mcp-status`/`--last-command`/`--last-exit-code`/`--last-stdout`/
 * `--last-stderr` on each render, the same way it would hold that state for
 * its own UI if it rendered the dashboard directly.
 *
 * The action row always renders every action, on the `architect-action:`
 * scheme (see `buildDashboardActionsHtml`) — this command does know its own
 * action set now, unlike the runtime state above, so unlike `mcpStatus` this
 * is not something a caller must supply.
 */
async function buildDashboardPayload(
  options: DashboardCliOptions
): Promise<DashboardCliResult> {
  const workspaceRoot = path.resolve(options.startPath ?? process.cwd());
  const [artifacts, session, copilotState] = await Promise.all([
    loadDashboardArtifacts(workspaceRoot),
    loadDashboardSession(workspaceRoot),
    new CopilotHandoffService().state({ workspaceRoot }).catch(() => ({}))
  ]);

  const html = createDashboardHtml(
    {
      workspaceRoot,
      mcpStatus: options.mcpStatus ?? "stopped",
      lastCommand: options.lastCommand,
      lastExitCode: options.lastExitCode,
      lastStdout: options.lastStdout,
      lastStderr: options.lastStderr,
      artifacts,
      session,
      buildVersion: COPILOT_ARCHITECT_VERSION
    },
    {
      actionsHtml:
        buildCopilotPanelHtml(copilotState, {
          task: options.task,
          notice: options.notice,
          noticeIsError: options.noticeIsError
        }) +
        '<span class="ca-setup-label">Repo setup:</span>' +
        buildDashboardActionsHtml(artifacts.latestPlan),
      // This command's caller is a host without `@architect` (the IntelliJ
      // plugin); its front door is the Copilot panel above.
      sessionHints: {
        idle: "Describe a question or a change in <em>Work with Copilot Chat</em> above.",
        noDecisions: "the Copilot panel does not record them yet"
      }
    }
  );

  return { html, workspaceRoot, artifacts, session };
}

function parseSetupArgs(args: string[]): SetupCliOptions {
  const options: SetupCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--workspace") {
      options.workspace = true;
      continue;
    }

    if (arg === "--path") {
      options.startPath = requiredValue(args, index, "--path");
      index += 1;
      continue;
    }

    throw new Error(`Unknown setup argument: ${arg}`);
  }

  return options;
}

/**
 * One-shot repo onboarding: initialize artifacts, analyze, build the symbol
 * graph and index, run the readiness assessment, and configure the MCP
 * server. Mirrors `setupRepo` in `packages/vscode-extension/src/index.ts` —
 * that copy stays there unchanged (this command exists so a shell that
 * cannot import it, like the IntelliJ plugin, has an equivalent to call),
 * so the two are accepted to drift rather than sharing an implementation;
 * see docs/KNOWN_LIMITATIONS.md.
 *
 * Never starts the MCP server itself — that is a persistent process, and
 * which process owns "the one I started, that I can later stop" has to be
 * whichever shell called this, not a one-shot CLI invocation.
 *
 * Steps run to completion even when an earlier one fails, for the same
 * reason the VS Code copy does: a developer can retry a single failed step
 * from the dashboard rather than losing everything that already succeeded.
 */
async function runSetupCommand(options: SetupCliOptions): Promise<SetupCliResult> {
  const root = path.resolve(options.startPath ?? process.cwd());
  const steps: SetupStepResult[] = [];

  const track = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      steps.push({ label, ok: true });
    } catch (error) {
      steps.push({
        label,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const setupOneRepo = async (repoRoot: string, label: string): Promise<void> => {
    await track(`Initialize artifacts (${label})`, async () => {
      await new CommandConfigService().init({ startPath: repoRoot });
      await new SafetyPolicyService().init(repoRoot, false);
    });
    await track(`Analyze repo (${label})`, () =>
      new RepoDiscoveryService().analyze({ startPath: repoRoot })
    );
    await track(`Build symbol graph (${label})`, () =>
      new SymbolGraphService().build({ startPath: repoRoot })
    );
    await track(`Repo assessment (${label})`, () =>
      new AdvancedAnalysisService().diagnose({ startPath: repoRoot })
    );
  };

  if (!options.workspace) {
    await setupOneRepo(root, path.basename(root));
    await track("Build index", () => new IndexingService().index({ startPath: root }));
    await track("Configure MCP server", () =>
      new CopilotChatMcpConfigService().write({ startPath: root })
    );

    return { mode: "single", root, steps, ok: steps.every((step) => step.ok) };
  }

  const workspaceService = new WorkspaceService();
  const { workspace } = await workspaceService.show({ startPath: root });
  const repos = workspaceService
    .resolveRepos(workspace)
    .filter((repo) => repo.role !== "workspace root");

  for (const repo of repos) {
    await setupOneRepo(repo.repoRoot, repo.name);
  }

  await track("Build workspace index", () =>
    new IndexingService().indexWorkspace({ startPath: root })
  );

  if (
    await shouldBuildWorkspaceGraph(
      root,
      repos.map((repo) => repo.name)
    )
  ) {
    await track("Build workspace symbol graph", () =>
      new SymbolGraphService().build({ startPath: root })
    );
  } else {
    steps.push({
      label:
        "Build workspace symbol graph (skipped — last build found no code shared between these repos)",
      ok: true
    });
  }

  await track("Configure MCP server", () =>
    new CopilotChatMcpConfigService().write({ startPath: root })
  );

  return { mode: "workspace", root, steps, ok: steps.every((step) => step.ok) };
}

/**
 * Mirrors `shouldBuildWorkspaceGraph` in
 * `packages/vscode-extension/src/index.ts` — same accepted duplication as
 * the rest of this command; see its doc comment there for the reasoning
 * behind the heuristic itself.
 */
async function shouldBuildWorkspaceGraph(
  workspaceRoot: string,
  repoNames: string[]
): Promise<boolean> {
  let state: { repos?: string[]; crossRepoEdgeCount?: number };

  try {
    state = await readJsonFile(
      path.join(workspaceRoot, ".copilot-architect", "graph-workspace.json")
    );
  } catch {
    return true;
  }

  if (state.crossRepoEdgeCount !== 0) return true;

  const learned = [...(state.repos ?? [])].sort();
  const current = [...repoNames].sort();
  return learned.length !== current.length
    ? true
    : learned.some((name, position) => name !== current[position]);
}

function getSetupText(result: SetupCliResult): string {
  const failed = result.steps.filter((step) => !step.ok);
  return [
    `${PROJECT_NAME}: setup (${result.mode})`,
    "",
    `Root: ${result.root}`,
    "",
    ...result.steps.map(
      (step) =>
        `${step.ok ? "✓" : "✗"} ${step.label}${step.error ? ` — ${step.error}` : ""}`
    ),
    "",
    failed.length === 0
      ? "Setup complete."
      : `Setup finished with ${failed.length} failed step(s).`
  ].join("\n");
}

async function runInstructionsCommand(
  options: InstructionsCliOptions
): Promise<CliCommandExecutionResult> {
  const service = new InstructionService();

  if (options.subcommand === "preview") {
    const result = await service.preview({
      startPath: options.startPath,
      outputPath: options.outputPath
    });
    return { exitCode: 0, payload: result, text: getInstructionPreviewText(result) };
  }

  if (options.subcommand === "generate") {
    const result = await service.generate({
      startPath: options.startPath,
      outputPath: options.outputPath
    });
    return {
      exitCode: result.status === "failed" ? 1 : 0,
      payload: result,
      text: getInstructionGenerateText(result)
    };
  }

  const result = await service.validate({
    startPath: options.startPath,
    outputPath: options.outputPath
  });
  return {
    exitCode: result.ok ? 0 : 1,
    payload: result,
    text: getInstructionValidateText(result)
  };
}

async function runWorkspaceCommand(
  options: WorkspaceCliOptions
): Promise<CliCommandExecutionResult> {
  const service = new WorkspaceService();

  if (options.subcommand === "init") {
    const result = await service.init({
      startPath: options.startPath,
      workspaceName: options.workspaceName
    });
    return {
      exitCode: 0,
      payload: result.workspace,
      text: getWorkspaceText("init", result)
    };
  }

  if (options.subcommand === "show" || options.subcommand === "list") {
    const result = await service.show({ startPath: options.startPath });
    return {
      exitCode: 0,
      payload: result.workspace,
      text: getWorkspaceText(options.subcommand, result)
    };
  }

  if (options.subcommand === "add") {
    if (!options.repoPath) {
      throw new Error("workspace add requires a repo path");
    }

    const result = await service.add({
      startPath: options.startPath,
      name: options.repoName,
      repoPath: options.repoPath,
      role: options.role
    });
    return {
      exitCode: 0,
      payload: result.workspace,
      text: getWorkspaceText("add", result)
    };
  }

  if (options.subcommand === "remove") {
    if (!options.repoName) {
      throw new Error("workspace remove requires a repo name or path");
    }

    const result = await service.remove({
      startPath: options.startPath,
      nameOrPath: options.repoName
    });
    return {
      exitCode: 0,
      payload: result.workspace,
      text: getWorkspaceText("remove", result)
    };
  }

  if (options.subcommand === "scan") {
    if (!options.repoPath) {
      throw new Error("workspace scan requires a parent directory");
    }

    const scan = await scanAndRegisterSubRepos(
      service,
      options.startPath,
      options.repoPath
    );
    return {
      exitCode: scan.registered.length > 0 ? 0 : 1,
      payload: scan,
      text: getWorkspaceScanText(scan)
    };
  }

  if (options.subcommand === "index") {
    const payload = await new IndexingService().indexWorkspace({
      startPath: options.startPath,
      rebuild: options.rebuild
    });
    return {
      exitCode: 0,
      payload,
      text: getWorkspaceIndexText(payload)
    };
  }

  if (options.subcommand === "search") {
    if (!options.query) {
      throw new Error("workspace search requires a query");
    }

    const payload = await new IndexingService().searchWorkspace({
      startPath: options.startPath,
      query: options.query,
      limit: options.limit
    });
    return {
      exitCode: 0,
      payload,
      text: getWorkspaceSearchText(payload)
    };
  }

  if (options.subcommand === "impact") {
    if (!options.request) {
      throw new Error("workspace impact requires a request");
    }

    const impact = await new WorkspacePlanningService().analyzeImpact({
      startPath: options.startPath,
      request: options.request,
      searchLimit: options.limit
    });
    return {
      exitCode: 0,
      payload: impact,
      text: getWorkspaceImpactText(impact)
    };
  }

  if (options.subcommand === "plan") {
    if (!options.request) {
      throw new Error("workspace plan requires a request");
    }

    const plan = await new WorkspacePlanningService().createPlan({
      startPath: options.startPath,
      request: options.request,
      searchLimit: options.limit
    });
    return { exitCode: 0, payload: plan, text: getWorkspacePlanText(plan) };
  }

  const validation = await validateWorkspacePlan(options);
  return {
    exitCode: validation.ok ? 0 : 1,
    payload: validation,
    text: getWorkspaceValidatePlanText(validation)
  };
}

function getReviewText(result: ReviewServiceResult): string {
  return [
    `${PROJECT_NAME}: review`,
    "",
    result.report.summary,
    `Findings: ${result.report.findings.length}`,
    `Unexpected files: ${result.report.unexpectedFiles.length}`,
    `Missing tests: ${result.report.missingTests.length}`,
    `Validation: ${result.report.validationStatus ?? "not available"}`,
    `Risks: ${result.report.risks.length}`,
    `Review JSON: ${result.jsonPath}`,
    `Review Markdown: ${result.markdownPath}`,
    `Latest JSON: ${result.latestJsonPath}`,
    `Latest Markdown: ${result.latestMarkdownPath}`
  ].join("\n");
}

function getReviewResolveText(result: ResolveReviewFindingResult): string {
  return [
    `${PROJECT_NAME}: review resolve`,
    "",
    `Finding: ${result.findingId}`,
    `Status: ${result.status}`,
    `Decided by: ${result.disposition.decidedBy}`,
    `Reason: ${result.disposition.reason}`,
    ...(result.disposition.planRevision !== undefined
      ? [`Plan revision: ${result.disposition.planRevision}`]
      : []),
    `Dispositions file: ${result.dispositionsPath}`
  ].join("\n");
}

function getHandoffText(result: HandoffGenerationResult): string {
  return [
    `${PROJECT_NAME}: handoff`,
    "",
    `Plan: ${result.handoff.planId}`,
    `Target agent: ${result.handoff.targetAgent}`,
    `Expected files: ${result.handoff.expectedFiles.length}`,
    `Validation commands: ${result.handoff.validationCommands.length}`,
    `Git checkpoint: ${result.gitCheckpoint.created ? result.gitCheckpoint.checkpointPath : result.gitCheckpoint.message}`,
    `Clipboard: ${result.clipboard.copied ? "copied" : result.clipboard.message}`,
    `Handoff JSON: ${result.jsonPath}`,
    `Handoff Markdown: ${result.markdownPath}`,
    `Latest JSON: ${result.latestJsonPath}`,
    `Latest Markdown: ${result.latestMarkdownPath}`
  ].join("\n");
}

function getInstructionPreviewText(result: InstructionPreviewResult): string {
  return [`${PROJECT_NAME}: instructions preview`, "", result.markdown].join("\n");
}

function getInstructionGenerateText(result: InstructionGenerationSummary): string {
  return [
    `${PROJECT_NAME}: instructions generate`,
    "",
    `Status: ${result.status}`,
    `Output: ${result.outputPath ?? "not written"}`,
    `Backup: ${result.backupPath ?? "none"}`,
    `Skills: ${result.skills.length}`,
    `Prompts: ${result.prompts.length}`,
    `Preserved user content: ${result.preservedUserContent ? "yes" : "no"}`,
    ...result.skills.map(
      (skill) =>
        `- ${skill.id}: ${skill.status} ${skill.outputPath}${skill.backupPath ? ` (backup: ${skill.backupPath})` : ""}`
    ),
    ...result.prompts.map(
      (prompt) =>
        `- ${prompt.id}: ${prompt.status} ${prompt.outputPath}${prompt.backupPath ? ` (backup: ${prompt.backupPath})` : ""}`
    ),
    ...result.messages.map((message) => `- ${message}`)
  ].join("\n");
}

function getInstructionValidateText(result: InstructionValidationResult): string {
  return [
    `${PROJECT_NAME}: instructions validate`,
    "",
    `Status: ${result.ok ? "ok" : "error"}`,
    `Checked: ${result.checkedPath}`,
    `Skills: ${result.skillsPath}`,
    `Prompts: ${result.promptsPath}`,
    ...result.messages.map((message) => `- ${message}`),
    ...result.files.flatMap((file) => [
      "",
      `${file.ok ? "ok" : "error"}: ${file.filePath}`,
      ...file.errors.map((error) => `  - ${error}`),
      ...file.warnings.map((warning) => `  - warning: ${warning}`)
    ])
  ].join("\n");
}

export interface WorkspaceScanResult {
  workspaceRoot: string;
  scannedDir: string;
  registered: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Registers every immediate sub-directory of `scanDir` that looks like a
 * real repo as a workspace repo. Mirrors `registerSubRepos` in
 * `packages/vscode-extension/src/index.ts` — that copy stays there
 * unchanged (this command exists so a shell that cannot import it, like the
 * IntelliJ plugin, has an equivalent to call), so the two are accepted to
 * drift rather than sharing an implementation; see
 * docs/KNOWN_LIMITATIONS.md.
 */
async function scanAndRegisterSubRepos(
  service: WorkspaceService,
  startPath: string | undefined,
  scanDir: string
): Promise<WorkspaceScanResult> {
  const workspaceRoot = path.resolve(startPath ?? process.cwd());
  const resolvedScanDir = path.resolve(scanDir);

  let entries;
  try {
    entries = await readdir(resolvedScanDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Could not read directory ${resolvedScanDir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const subDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(resolvedScanDir, entry.name));

  const skipped: string[] = [];
  const candidates: string[] = [];

  for (const subDir of subDirs) {
    if (await looksLikeRepo(subDir)) {
      candidates.push(subDir);
    } else {
      skipped.push(path.basename(subDir));
    }
  }

  if (candidates.length === 0) {
    return {
      workspaceRoot,
      scannedDir: resolvedScanDir,
      registered: [],
      skipped,
      failed: []
    };
  }

  // Skip workspace init when workspace.json already exists so a re-scan does
  // not drop previously registered repos.
  const existingWorkspace = await readJsonFile<unknown>(
    getArtifactFilePath(workspaceRoot, "workspace")
  ).catch(() => undefined);

  if (!existingWorkspace) {
    await service.init({ startPath: workspaceRoot });
  }

  const registered: string[] = [];
  const failed: string[] = [];

  for (const subDir of candidates) {
    const repoName = path.basename(subDir);
    try {
      await service.add({ startPath: workspaceRoot, name: repoName, repoPath: subDir });
      registered.push(repoName);
    } catch {
      failed.push(repoName);
    }
  }

  return { workspaceRoot, scannedDir: resolvedScanDir, registered, skipped, failed };
}

function getWorkspaceScanText(result: WorkspaceScanResult): string {
  return [
    `${PROJECT_NAME}: workspace scan`,
    "",
    `Scanned: ${result.scannedDir}`,
    `Workspace: ${result.workspaceRoot}`,
    `Registered: ${result.registered.length}`,
    ...result.registered.map((name) => `- ${name}`),
    result.skipped.length > 0
      ? `Skipped (no project file found): ${result.skipped.join(", ")}`
      : "",
    result.failed.length > 0 ? `Failed to register: ${result.failed.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function getWorkspaceText(subcommand: string, result: WorkspaceServiceResult): string {
  const repos = result.workspace.repos ?? [];
  return [
    `${PROJECT_NAME}: workspace ${subcommand}`,
    "",
    `Name: ${result.workspace.workspaceName ?? path.basename(result.workspace.workspaceRoot)}`,
    `Workspace: ${result.workspace.workspaceRoot}`,
    `Repos: ${repos.length || result.workspace.repoRoots.length}`,
    `Workspace file: ${result.workspacePath}`,
    `Created: ${result.created ? "yes" : "no"}`,
    ...repos.map(
      (repo) => `- ${repo.name}: ${repo.path}${repo.role ? ` (${repo.role})` : ""}`
    )
  ].join("\n");
}

function getWorkspaceIndexText(result: WorkspaceIndexResult): string {
  return [
    `${PROJECT_NAME}: workspace index`,
    "",
    `Workspace: ${result.workspace.workspaceRoot}`,
    `Repos indexed: ${result.results.length}`,
    `Workspace repo-map: ${result.repoMapPath}`,
    `Documents: ${result.results.reduce((sum, entry) => sum + entry.result.index.stats.documentCount, 0)}`,
    ...result.results.map(
      (entry) =>
        `- ${entry.repo.name}: ${entry.result.index.stats.documentCount} document(s)`
    )
  ].join("\n");
}

function getWorkspaceSearchText(response: WorkspaceSearchResponse): string {
  const lines = [
    `${PROJECT_NAME}: workspace search`,
    "",
    `Query: ${response.query}`,
    `Repos searched: ${response.repos.length}`,
    `Results: ${response.combinedResults.length}`
  ];

  for (const result of response.combinedResults.slice(0, 10)) {
    lines.push(
      "",
      `${result.repoName}: ${result.relativePath} (score ${result.score})`
    );
  }

  return lines.join("\n");
}

function getWorkspaceImpactText(impact: WorkspaceImpactResult): string {
  return [
    `${PROJECT_NAME}: workspace impact`,
    "",
    `Workspace: ${impact.workspaceName ?? impact.workspaceRoot}`,
    `Repos: ${impact.repos.length}`,
    `Impacted repos: ${impact.impactedRepos.length}`,
    ...impact.impactedRepos.map(
      (repo) =>
        `- ${repo.name}${repo.role ? ` (${repo.role})` : ""}: ${repo.resultCount} match(es), top files ${repo.topFiles.join(", ") || "none"}`
    ),
    `Validation plans: ${impact.perRepoValidationPlans.length}`
  ].join("\n");
}

function getWorkspacePlanText(result: WorkspacePlanningResult): string {
  return [
    getPlanSummaryText(result),
    "",
    "Multi-repo:",
    `Impacted repos: ${result.multiRepo.impactedRepos.length}`,
    ...result.multiRepo.impactedRepos.map(
      (repo) =>
        `- ${repo.name}${repo.role ? ` (${repo.role})` : ""}: ${repo.resultCount} match(es)`
    ),
    `Per-repo validation plans: ${result.multiRepo.perRepoValidationPlans.length}`
  ].join("\n");
}

function getWorkspaceValidatePlanText(result: {
  ok: boolean;
  planPath: string;
  messages: string[];
}): string {
  return [
    `${PROJECT_NAME}: workspace validate-plan`,
    "",
    `Status: ${result.ok ? "ok" : "error"}`,
    `Plan: ${result.planPath}`,
    ...result.messages.map((message) => `- ${message}`)
  ].join("\n");
}

async function validateWorkspacePlan(options: WorkspaceCliOptions): Promise<{
  ok: boolean;
  planPath: string;
  messages: string[];
  perRepoValidationPlans: WorkspaceImpactResult["perRepoValidationPlans"];
}> {
  const repoRoot = path.resolve(options.startPath ?? process.cwd());
  const planPath =
    !options.plan || options.plan === "latest"
      ? path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.json")
      : path.isAbsolute(options.plan)
        ? options.plan
        : path.resolve(repoRoot, options.plan);

  try {
    const plan = await readJsonFile<
      FeaturePlan & {
        multiRepo?: {
          perRepoValidationPlans?: WorkspaceImpactResult["perRepoValidationPlans"];
          impactedRepos?: WorkspaceImpactResult["impactedRepos"];
        };
      }
    >(planPath);
    const perRepoValidationPlans =
      plan.multiRepo?.perRepoValidationPlans ??
      (
        await new WorkspacePlanningService().analyzeImpact({
          startPath: repoRoot,
          request: plan.task || plan.title
        })
      ).perRepoValidationPlans;
    const messages = [
      `Plan ${plan.id} has ${plan.implementationSteps.length} implementation step(s).`,
      `Validation commands: ${plan.validationPlan.commands.length}.`,
      `Requires approval: ${plan.requiresHumanApproval ? "yes" : "no"}.`,
      `Impacted repos: ${plan.multiRepo?.impactedRepos?.length ?? 0}.`,
      `Per-repo validation plans: ${perRepoValidationPlans.length}.`,
      ...perRepoValidationPlans.map(
        (repoPlan) =>
          `${repoPlan.repoName}: ${repoPlan.commands.length} validation command(s).`
      )
    ];
    const ok =
      plan.implementationSteps.length > 0 && plan.validationPlan.commands.length >= 0;

    return { ok, planPath, messages, perRepoValidationPlans };
  } catch {
    return {
      ok: false,
      planPath,
      messages: ["Plan artifact is missing or unreadable."],
      perRepoValidationPlans: []
    };
  }
}

interface StatusControls {
  policyPath: string;
  policyPresent: boolean;
  policyReadable: boolean;
  policyError?: string;
  telemetryEnabled: boolean;
  localFirst: boolean;
  requiredApprovalGates: string[];
  retention: {
    enabled: boolean;
    maxAgeDays: number;
    maxRuns: number;
    dryRunDefault: boolean;
    directories: string[];
  };
}

interface StatusResult {
  workspaceRoot: string;
  artifactRoot: string;
  artifacts: Array<{ name: string; path: string; exists: boolean }>;
  controls: StatusControls;
}

async function getStatus(options: StatusCliOptions): Promise<StatusResult> {
  const workspaceRoot = path.resolve(options.startPath ?? process.cwd());
  const artifactRoot = path.join(workspaceRoot, ARTIFACT_DIRECTORY);
  const policyPath = getArtifactFilePath(workspaceRoot, "policy");
  const policyPresent = await pathExists(policyPath);
  const controls = await getStatusControls(workspaceRoot, policyPath, policyPresent);
  const artifacts = [
    { name: "repo-map", path: getArtifactFilePath(workspaceRoot, "repoMap") },
    { name: "workspace", path: getArtifactFilePath(workspaceRoot, "workspace") },
    { name: "commands", path: getArtifactFilePath(workspaceRoot, "commands") },
    { name: "policy", path: getArtifactFilePath(workspaceRoot, "policy") },
    {
      name: "index",
      path: path.join(getArtifactDirectoryPath(workspaceRoot, "index"), "index.json")
    },
    {
      name: "latest-plan",
      path: path.join(
        getArtifactDirectoryPath(workspaceRoot, "plans"),
        "latest-plan.json"
      )
    },
    {
      name: "latest-validation",
      path: path.join(
        getArtifactDirectoryPath(workspaceRoot, "runs"),
        "latest-validation.json"
      )
    },
    {
      name: "latest-review",
      path: path.join(
        getArtifactDirectoryPath(workspaceRoot, "reviews"),
        "latest-review.json"
      )
    }
  ];

  return {
    workspaceRoot,
    artifactRoot,
    controls,
    artifacts: await Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        exists: await pathExists(artifact.path)
      }))
    )
  };
}

function getStatusText(result: StatusResult): string {
  return [
    `${PROJECT_NAME}: status`,
    "",
    `Workspace: ${result.workspaceRoot}`,
    `Artifact root: ${result.artifactRoot}`,
    `Telemetry: ${result.controls.telemetryEnabled ? "enabled" : "disabled"}`,
    `Local first: ${result.controls.localFirst ? "yes" : "no"}`,
    `Policy: ${result.controls.policyPresent ? "present" : "using defaults"}`,
    `Retention: ${
      result.controls.retention.enabled ? "enabled" : "disabled"
    } (${result.controls.retention.maxAgeDays} day(s), ${
      result.controls.retention.maxRuns
    } file(s) per directory)`,
    `Approval gates: ${result.controls.requiredApprovalGates.join(", ") || "none"}`,
    "",
    "Artifacts:",
    ...result.artifacts.map(
      (artifact) => `- ${artifact.name}: ${artifact.exists ? "present" : "missing"}`
    )
  ].join("\n");
}

function getDiagnosticsText(result: RepoReadinessReport): string {
  const analysis = result.advancedAnalysis;

  return [
    `${PROJECT_NAME}: diagnostics`,
    "",
    `Repo: ${result.repoRoot}`,
    `Status: ${result.status}`,
    `Readiness score: ${result.score}/100`,
    `Advanced summary: ${analysis.summary}`,
    "",
    "Architecture patterns:",
    ...listOrNone(
      analysis.architecturePatterns.map(
        (pattern) =>
          `${withRepoPrefix(pattern.repoName)}${pattern.name} (${pattern.confidence}) - ${pattern.evidence.join(", ")}`
      )
    ),
    "",
    "Routes/APIs:",
    ...listOrNone(
      analysis.routes
        .slice(0, 20)
        .map(
          (route) =>
            `${withRepoPrefix(route.repoName)}${route.kind} ${route.method} ${route.routePath} - ${route.filePath}`
        )
    ),
    "",
    "Risk scores:",
    ...listOrNone(
      analysis.riskScores.map(
        (risk) =>
          `${withRepoPrefix(risk.repoName)}${risk.category}: ${risk.level} (${risk.score}/100)`
      )
    ),
    "",
    "Readiness diagnostics:",
    ...listOrNone(
      result.diagnostics.map(
        (diagnostic) =>
          `${withRepoPrefix(diagnostic.repoName)}${diagnostic.severity}: ${diagnostic.code} - ${diagnostic.message}${
            diagnostic.recommendation ? ` ${diagnostic.recommendation}` : ""
          }`
      )
    ),
    "",
    "Cross-repo interlinks:",
    ...listOrNone(analysis.interlinks.map(describeInterlink))
  ].join("\n");
}

function describeInterlink(interlink: CrossRepoInterlink): string {
  if (interlink.kind === "messaging") {
    return `${interlink.fromRepo} produces to ${interlink.method} "${interlink.path}" (\`${interlink.fromFile}\`) -> ${interlink.toRepo} consumes it (\`${interlink.toFile}\`) [${interlink.confidence}]`;
  }

  return `${interlink.fromRepo} calls ${interlink.method} ${interlink.path} (\`${interlink.fromFile}\`) -> ${interlink.toRepo} (\`${interlink.toFile}\`) [${interlink.confidence}]`;
}

function listOrNone(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None detected."];
}

// Absent for single-repo analysis and for workspace-wide diagnostics
// (MISSING_REPO_MAP, STALE_INDEX) that apply to no single repo.
function withRepoPrefix(repoName: string | undefined): string {
  return repoName ? `${repoName}: ` : "";
}

async function getStatusControls(
  workspaceRoot: string,
  policyPath: string,
  policyPresent: boolean
): Promise<StatusControls> {
  try {
    const policy = await new SafetyPolicyService().load(workspaceRoot);

    return {
      policyPath,
      policyPresent,
      policyReadable: true,
      telemetryEnabled: policy.telemetryEnabled ?? false,
      localFirst: policy.localFirst ?? true,
      requiredApprovalGates: policy.requiredApprovalGates ?? [],
      retention: {
        enabled: policy.artifactRetention?.enabled ?? true,
        maxAgeDays: policy.artifactRetention?.maxAgeDays ?? 30,
        maxRuns: policy.artifactRetention?.maxRuns ?? 50,
        dryRunDefault: policy.artifactRetention?.dryRunDefault ?? true,
        directories: policy.artifactRetention?.directories ?? [
          "plans",
          "handoffs",
          "runs",
          "reviews",
          "diagnostics"
        ]
      }
    };
  } catch (error) {
    return {
      policyPath,
      policyPresent,
      policyReadable: false,
      policyError: error instanceof Error ? error.message : String(error),
      telemetryEnabled: false,
      localFirst: true,
      requiredApprovalGates: [],
      retention: {
        enabled: true,
        maxAgeDays: 30,
        maxRuns: 50,
        dryRunDefault: true,
        directories: ["plans", "handoffs", "runs", "reviews", "diagnostics"]
      }
    };
  }
}

function getServePayload(server: WebServerStartResult): Record<string, unknown> {
  return {
    status: "started",
    url: server.url,
    host: server.host,
    port: server.port,
    repoRoot: server.repoRoot,
    localOnly: true,
    defaultHost: DEFAULT_WEB_HOST,
    defaultPort: DEFAULT_WEB_PORT
  };
}

function getServeText(server: WebServerStartResult): string {
  return [
    `${PROJECT_NAME}: serve`,
    "",
    `URL: ${server.url}`,
    `Repo: ${server.repoRoot}`,
    `Host: ${server.host}`,
    `Port: ${server.port}`,
    "Scope: local-only",
    "",
    "Press Ctrl+C to stop."
  ].join("\n");
}

async function waitForServeShutdown(server: WebServerStartResult): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().finally(resolve);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function parseTargetAgent(value: string): HandoffPrompt["targetAgent"] {
  if (
    value === "copilot" ||
    value === "codex" ||
    value === "claude-code" ||
    value === "generic"
  ) {
    return value;
  }

  throw new Error("Expected --target to be copilot, codex, claude-code, or generic");
}

function isWorkspaceSubcommand(
  value: string | undefined
): value is WorkspaceCliOptions["subcommand"] {
  return (
    value === "init" ||
    value === "show" ||
    value === "list" ||
    value === "add" ||
    value === "remove" ||
    value === "scan" ||
    value === "index" ||
    value === "search" ||
    value === "impact" ||
    value === "plan" ||
    value === "validate-plan"
  );
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface DemoCliOptions {
  startPath?: string;
  json: boolean;
}

interface DemoStepResult {
  step: string;
  ok: boolean;
  message: string;
  durationMs: number;
}

interface DemoResult {
  success: boolean;
  repoRoot: string;
  steps: DemoStepResult[];
  nextSteps: string[];
}

function parseDemoArgs(args: string[]): DemoCliOptions {
  let startPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "--path" || arg === "--root") && args[index + 1]) {
      startPath = args[++index];
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { startPath, json };
}

async function runDemo(options: {
  startPath?: string;
  stdout: (message: string) => void;
}): Promise<DemoResult> {
  const { startPath, stdout } = options;
  const steps: DemoStepResult[] = [];

  function log(message: string): void {
    stdout(`  ${message}`);
  }

  stdout(`\n${PROJECT_NAME} demo`);
  stdout("=".repeat(40));
  stdout("Running a quick end-to-end demonstration...\n");

  async function runStep<T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<{ ok: boolean; result?: T; message: string }> {
    const start = Date.now();
    stdout(`▶ ${label}`);
    try {
      const result = await fn();
      const ms = Date.now() - start;
      steps.push({ step: label, ok: true, message: "ok", durationMs: ms });
      log(`✓ done (${ms}ms)`);
      return { ok: true, result, message: "ok" };
    } catch (error) {
      const ms = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ step: label, ok: false, message, durationMs: ms });
      log(`✗ ${message}`);
      return { ok: false, message };
    }
  }

  // Step 1: Analyze repo
  let repoRoot = path.resolve(startPath ?? process.cwd());
  await runStep("Analyze repo structure", async () => {
    const result = await new RepoDiscoveryService().analyze({ startPath });
    repoRoot = result.repoRoot;
    const map = result.repoMap;
    log(`Repo: ${repoRoot}`);
    log(`Languages: ${map.summary.primaryLanguages.join(", ") || "none detected"}`);
    log(`Frameworks: ${map.summary.primaryFrameworks.join(", ") || "none detected"}`);
    return result;
  });

  // Step 2: Build index
  const indexStep = await runStep("Build local search index", async () => {
    const result = await new IndexingService().index({ startPath: repoRoot });
    log(`Indexed ${result.index.documents.length} files (${result.mode} mode)`);
    return result;
  });

  // Step 3: Search
  if (indexStep.ok) {
    await runStep('Search index for "test"', async () => {
      const response = await new IndexingService().search({
        startPath: repoRoot,
        query: "test",
        limit: 5
      });
      log(`Found ${response.results.length} results`);
      for (const hit of response.results.slice(0, 3)) {
        log(`  ${hit.relativePath} (score: ${hit.score.toFixed(2)})`);
      }
      return response;
    });
  }

  // Step 4: Diagnostics
  await runStep("Run repo readiness diagnostics", async () => {
    const result = await new AdvancedAnalysisService().diagnose({
      startPath: repoRoot
    });
    log(`Status: ${result.status}`);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    const warnings = result.diagnostics.filter((d) => d.severity === "warning");
    if (errors.length > 0) log(`Errors: ${errors.map((d) => d.message).join(", ")}`);
    if (warnings.length > 0) log(`Warnings: ${warnings.length} warning(s) found`);
    return result;
  });

  stdout("");
  const failedCount = steps.filter((s) => !s.ok).length;
  const success = failedCount === 0;

  // Kept in step with the commands that exist: `agents install` was deleted
  // in the redesign, and a demo that ends by naming a command the CLI refuses
  // is the first thing a new developer sees.
  const nextSteps = [
    `npm run cli -- plan "Describe your feature here"`,
    "npm run cli -- instructions generate",
    "npm run cli -- mcp config",
    "npm run cli -- validate --test",
    "npm run cli -- review"
  ];

  return { success, repoRoot, steps, nextSteps };
}

function getDemoSummaryText(result: DemoResult): string {
  const passed = result.steps.filter((s) => s.ok).length;
  const failed = result.steps.filter((s) => !s.ok).length;
  const status = result.success ? "PASSED" : `${failed} step(s) failed`;

  return [
    "",
    `Demo result: ${status} (${passed}/${result.steps.length} steps ok)`,
    "",
    "Next steps:",
    ...result.nextSteps.map((step) => `  ${step}`)
  ].join("\n");
}

function isCliCommand(value: string): value is CliCommandName {
  return CLI_COMMANDS.includes(value as CliCommandName);
}

function isDirectRun(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint ? import.meta.url === pathToFileURL(entryPoint).href : false;
}

if (isDirectRun()) {
  const result = await runCli();
  process.exitCode = result.exitCode;
}
