import path from "node:path";

import { AgentService } from "@copilot-architect/agents";
import { RepoDiscoveryService, WorkspaceService } from "@copilot-architect/core";
import { SymbolGraphService } from "@copilot-architect/graph";
import { IndexingService } from "@copilot-architect/indexer";
import { QueryIntentService } from "@copilot-architect/intent";
import { ContextMeasurementService } from "@copilot-architect/measurement";
import {
  FeaturePlanningService,
  WorkspacePlanningService
} from "@copilot-architect/planner";
import { ReviewService } from "@copilot-architect/reviewer";
import {
  CURRENT_SCHEMA_VERSION,
  type DetectedCommand,
  type RepoCommandSet,
  type RepoMap,
  type UniversalRepoMap,
  readJsonFile,
  resolveRegisteredRepos
} from "@copilot-architect/shared";
import {
  CommandConfigService,
  SafetyPolicyService,
  mergeCustomCommandsWithDetected
} from "@copilot-architect/validator";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { CopilotArchitectMcpServerOptions } from "./server.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface CopilotArchitectMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  readOnly: boolean;
  handler: ToolHandler;
}

export function registerCopilotArchitectTools(
  server: McpServer,
  options: CopilotArchitectMcpServerOptions = {}
): CopilotArchitectMcpToolDefinition[] {
  const tools = createCopilotArchitectTools(options);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly
        }
      },
      async (args) => {
        try {
          return toToolResult(await tool.handler(args as Record<string, unknown>));
        } catch (error) {
          return toToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    );
  }

  return tools;
}

export function createCopilotArchitectTools(
  options: CopilotArchitectMcpServerOptions = {}
): CopilotArchitectMcpToolDefinition[] {
  return [
    tool(
      "repo_map",
      "Read or generate the current repo map.",
      commonSchema,
      true,
      async (args) => ensureRepoMap(resolveStartPath(args, options))
    ),
    tool(
      "get_symbol_graph",
      "Build (or rebuild) the repo's symbol/dependency graph: file, class, " +
        "function, and method nodes, plus imports/calls/extends/implements " +
        "edges between them. Use this to find what actually depends on or " +
        "is called by a piece of code, not just what shares keywords with it.",
      commonSchema,
      true,
      async (args) =>
        (
          await new SymbolGraphService().build({
            startPath: resolveStartPath(args, options)
          })
        ).graph
    ),
    tool(
      "workspace_map",
      "Read or generate the current multi-repo workspace map.",
      commonSchema,
      true,
      async (args) =>
        new WorkspaceService().createWorkspaceMap({
          startPath: resolveStartPath(args, options)
        })
    ),
    tool(
      "detect_languages",
      "List detected languages.",
      commonSchema,
      true,
      async (args) => {
        const repoMap = await ensureRepoMap(resolveStartPath(args, options));
        return repoMap.repos.flatMap((repo) => repo.languages);
      }
    ),
    tool(
      "detect_frameworks",
      "List detected frameworks.",
      commonSchema,
      true,
      async (args) => {
        const repoMap = await ensureRepoMap(resolveStartPath(args, options));
        return repoMap.repos.flatMap((repo) => repo.frameworks);
      }
    ),
    tool(
      "detect_package_managers",
      "List detected package managers.",
      commonSchema,
      true,
      async (args) => {
        const repoMap = await ensureRepoMap(resolveStartPath(args, options));
        return repoMap.repos.flatMap((repo) => repo.packageManagers);
      }
    ),
    tool(
      "detect_build_commands",
      "List detected build commands.",
      commonSchema,
      true,
      async (args) => {
        const repoMap = await ensureRepoMap(resolveStartPath(args, options));
        return repoMap.repos.flatMap((repo) => repo.commands.build);
      }
    ),
    tool(
      "detect_test_commands",
      "List detected test commands.",
      commonSchema,
      true,
      async (args) => {
        const repoMap = await ensureRepoMap(resolveStartPath(args, options));
        return repoMap.repos.flatMap((repo) => repo.commands.test);
      }
    ),
    tool(
      "list_repo_files",
      "List what the repo index actually contains: file paths with their " +
        "language, size, declared symbols, and per-language/per-directory " +
        "counts. Use this FIRST when asked to analyze, explain or map a repo " +
        "— search_repo needs a query, and guessed keywords find nothing in a " +
        "codebase whose identifiers are OrderService rather than 'main'. " +
        "Optional `filter` narrows by path substring; `limit` caps the list " +
        "(default 300) while `totalFiles` still reports the true count.",
      listFilesSchema,
      true,
      async (args) =>
        new IndexingService().listFiles({
          startPath: resolveStartPath(args, options),
          filter: optionalStringArg(args, "filter"),
          limit: numberArg(args, "limit", 300)
        })
    ),
    tool(
      "search_repo",
      "Search the current repo index. Hybrid ranking: keyword match, path/symbol " +
        "match, and — when get_symbol_graph has been run — files connected via " +
        "the symbol graph even with no shared vocabulary. Each result's " +
        "`signals` field says which of these found it.",
      searchSchema,
      true,
      async (args) =>
        new IndexingService().search({
          startPath: resolveStartPath(args, options),
          query: stringArg(args, "query"),
          limit: numberArg(args, "limit", 20)
        })
    ),
    tool(
      "analyze_query_intent",
      "Classify a natural-language query's intent (debugging/feature/refactor/test) " +
        "and resolve its likely components, relevant tests, and recently-changed " +
        "files by running the query through search_repo's hybrid ranking. Use " +
        "this before planning or investigating to scope which files matter.",
      searchSchema,
      true,
      async (args) =>
        new QueryIntentService().analyze({
          startPath: resolveStartPath(args, options),
          query: stringArg(args, "query"),
          limit: numberArg(args, "limit", 8)
        })
    ),
    tool(
      "search_across_repos",
      "Search across the current workspace repos.",
      searchSchema,
      true,
      async (args) =>
        new IndexingService().searchWorkspace({
          startPath: resolveStartPath(args, options),
          query: stringArg(args, "query"),
          limit: numberArg(args, "limit", 20)
        })
    ),
    tool(
      "analyze_cross_repo_impact",
      "Analyze likely cross-repo impact for a feature request.",
      requestSchema,
      true,
      async (args) =>
        new WorkspacePlanningService().analyzeImpact({
          startPath: resolveStartPath(args, options),
          request: stringArg(args, "request"),
          searchLimit: numberArg(args, "limit", 12)
        })
    ),
    tool(
      "find_similar_feature",
      "Find similar feature candidates in the local index.",
      searchSchema,
      true,
      async (args) =>
        new IndexingService().findSimilarFeatures({
          startPath: resolveStartPath(args, options),
          query: stringArg(args, "query"),
          limit: numberArg(args, "limit", 12)
        })
    ),
    tool(
      "find_impacted_files",
      "Find likely impacted files for a request.",
      requestSchema,
      true,
      async (args) => {
        const response = await new IndexingService().findSimilarFeatures({
          startPath: resolveStartPath(args, options),
          query: stringArg(args, "request"),
          limit: numberArg(args, "limit", 12)
        });
        return response.results.map((result) => ({
          filePath: result.relativePath,
          score: result.score,
          matchedFields: result.matchedFields
        }));
      }
    ),
    tool(
      "analyze_impact",
      "Generate impact context for a request without implementation.",
      requestSchema,
      true,
      async (args) => {
        const plan = await new FeaturePlanningService().createPlanPreview({
          startPath: resolveStartPath(args, options),
          request: stringArg(args, "request"),
          searchLimit: numberArg(args, "limit", 12)
        });
        return {
          impactAnalysis: plan.plan.impactAnalysis,
          impactedLanguages: plan.plan.impactedLanguages,
          impactedFrameworks: plan.plan.impactedFrameworks,
          impactedModules: plan.plan.impactedModules,
          likelyFilesToModify: plan.plan.likelyFilesToModify,
          likelyNewFiles: plan.plan.likelyNewFiles
        };
      }
    ),
    tool(
      "generate_plan_context",
      "Generate repo/search context for a feature plan.",
      requestSchema,
      true,
      async (args) => {
        const startPath = resolveStartPath(args, options);
        const repoMap = await ensureRepoMap(startPath);
        const search = await new IndexingService().findSimilarFeatures({
          startPath,
          query: stringArg(args, "request"),
          limit: numberArg(args, "limit", 12)
        });
        return { repoMap, search };
      }
    ),
    tool(
      "measure_context_reduction",
      "Measure how much context a feature request's plan.relevantFiles " +
        "selection actually saves versus naively sending the whole repo: " +
        "file counts, byte sizes, and a rough token estimate for both, plus " +
        "the reduction percentage. Use this to check the actual " +
        "token-reduction claim for a request rather than assume it.",
      requestSchema,
      true,
      async (args) =>
        new ContextMeasurementService().measure({
          startPath: resolveStartPath(args, options),
          request: stringArg(args, "request")
        })
    ),
    tool(
      "generate_feature_plan",
      "Generate a feature plan artifact (revision 1). Requires approved=true. " +
        "Fails if a draft plan already exists — use revise_feature_plan to " +
        "incorporate feedback into it, or pass restart=true to discard it.",
      generateFeaturePlanSchema,
      false,
      async (args) => {
        if (args.approved !== true) {
          return {
            ok: false,
            error: "generate_feature_plan writes artifacts and requires approved=true."
          };
        }

        const startPath = resolveStartPath(args, options);
        const existingDraft = await readExistingDraftPlan(startPath);

        if (
          existingDraft &&
          existingDraft.status === "draft" &&
          args.restart !== true
        ) {
          return {
            ok: false,
            error: `A draft plan already exists at revision ${existingDraft.revision}. Use revise_feature_plan to incorporate feedback, or pass restart=true to discard the draft.`
          };
        }

        return new FeaturePlanningService().createPlan({
          startPath,
          request: stringArg(args, "request"),
          searchLimit: numberArg(args, "limit", 12)
        });
      }
    ),
    tool(
      "revise_feature_plan",
      "Revise the current draft plan in place with feedback from a conversation " +
        "turn or a code review, without discarding prior revisions.",
      reviseFeaturePlanSchema,
      false,
      async (args) =>
        new FeaturePlanningService().revisePlan({
          startPath: resolveStartPath(args, options),
          planId: typeof args.planId === "string" ? args.planId : undefined,
          feedback: stringArg(args, "feedback"),
          sections: isPlainObject(args.sections) ? args.sections : undefined,
          source: args.source === "code-review" ? "code-review" : "human-feedback",
          reviewFindingIds: stringArrayArg(args, "reviewFindingIds")
        })
    ),
    tool(
      "approve_plan",
      "Approve one specific plan revision, freezing it and promoting it to " +
        "latest-plan.*. Revision is required — approval is always per-revision, " +
        "never 'whatever is newest'.",
      approvePlanSchema,
      false,
      async (args) =>
        new FeaturePlanningService().approvePlan({
          startPath: resolveStartPath(args, options),
          planId: typeof args.planId === "string" ? args.planId : undefined,
          revision: requiredNumberArg(args, "revision"),
          approvedBy: stringArg(args, "approvedBy"),
          note: typeof args.note === "string" ? args.note : undefined
        })
    ),
    tool(
      "get_validation_commands",
      "Get merged detected and custom validation commands.",
      commonSchema,
      true,
      async (args) => getValidationCommands(resolveStartPath(args, options))
    ),
    tool(
      "get_safety_policy",
      "Read the active safety policy.",
      commonSchema,
      true,
      async (args) => new SafetyPolicyService().load(resolveStartPath(args, options))
    ),
    tool(
      "get_latest_plan",
      "Read the latest generated plan artifact.",
      commonSchema,
      true,
      async (args) =>
        readOptionalArtifact(resolveStartPath(args, options), "plans/latest-plan.json")
    ),
    tool(
      "get_latest_validation",
      "Read the latest validation report artifact.",
      commonSchema,
      true,
      async (args) =>
        readOptionalArtifact(
          resolveStartPath(args, options),
          "runs/latest-validation.json"
        )
    ),
    tool(
      "get_latest_review",
      "Read the latest review report artifact when available.",
      commonSchema,
      true,
      async (args) =>
        readOptionalArtifact(
          resolveStartPath(args, options),
          "reviews/latest-review.json"
        )
    ),
    tool(
      "resolve_review_finding",
      "Record a durable accept/decline decision on one review finding by its " +
        "stable id. A declined finding never reappears on the next review; an " +
        "accepted one should be folded into a plan revision separately via " +
        "revise_feature_plan. reason is required for both decisions — it is " +
        "the audit trail.",
      resolveReviewFindingSchema,
      false,
      async (args) =>
        new ReviewService().resolveFinding({
          startPath: resolveStartPath(args, options),
          findingId: stringArg(args, "findingId"),
          decision: args.decision === "accept" ? "accept" : "decline",
          reason: stringArg(args, "reason"),
          decidedBy: stringArg(args, "decidedBy"),
          planRevision:
            typeof args.planRevision === "number" ? args.planRevision : undefined
        })
    ),
    tool(
      "agent_status",
      "Report Copilot Architect custom agent and MCP readiness.",
      commonSchema,
      true,
      async (args) =>
        new AgentService().doctor({ startPath: resolveStartPath(args, options) })
    )
  ];
}

export function listCopilotArchitectMcpToolNames(): string[] {
  return createCopilotArchitectTools().map((toolDefinition) => toolDefinition.name);
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodType>,
  readOnly: boolean,
  handler: ToolHandler
): CopilotArchitectMcpToolDefinition {
  return { name, description, inputSchema, readOnly, handler };
}

async function ensureRepoMap(startPath: string): Promise<UniversalRepoMap> {
  const registered = await resolveRegisteredRepos(startPath);

  if (registered.length === 0) {
    return (await new RepoDiscoveryService().analyze({ startPath })).repoMap;
  }

  // A workspace root holds registration, not code. Analyzing it alone handed
  // every detect_* tool an empty repo map, so each reported that the workspace
  // had no languages, frameworks or build commands.
  const repos: RepoMap[] = [];

  for (const repo of registered) {
    const analyzed = await new RepoDiscoveryService()
      .analyze({ startPath: repo.repoRoot })
      // One unanalyzable repo must not blank the whole map.
      .catch(() => undefined);

    for (const entry of analyzed?.repoMap.repos ?? []) {
      repos.push({
        ...entry,
        displayName: repo.name,
        // Stamp the repo each command runs in. Without it detect_test_commands
        // returns a bare `npm test` / `mvn test` list with no way to tell which
        // repo either belongs to — and running them at the workspace root fails.
        commands: stampCommandCwd(entry.commands, entry.repoRoot)
      });
    }
  }

  const languages = [
    ...new Set(repos.flatMap((repo) => repo.languages.map((language) => language.name)))
  ];
  const frameworks = [
    ...new Set(
      repos.flatMap((repo) => repo.frameworks.map((framework) => framework.name))
    )
  ];
  const projectCount = repos.reduce((total, repo) => total + repo.projects.length, 0);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceRoot: startPath,
    repos,
    summary: {
      summary: `Workspace of ${repos.length} repos: ${repos.map((repo) => repo.displayName).join(", ")}`,
      primaryLanguages: languages,
      primaryFrameworks: frameworks,
      projectCount,
      repoCount: repos.length
    }
  };
}

async function getValidationCommands(startPath: string): Promise<unknown> {
  const repoMap = await ensureRepoMap(startPath);

  if (repoMap.repos.length === 0) {
    return {
      commands: [],
      diagnostics: ["Repo map does not contain any repositories."]
    };
  }

  const customConfig = await new CommandConfigService().load({
    startPath: repoMap.workspaceRoot,
    allowMissing: true
  });
  // Every repo, not just repos[0] — a workspace used to report only its first
  // repo's commands, so the others looked as though they had none.
  const commands = mergeRepoCommandSets(repoMap.repos);

  return {
    commands: mergeCustomCommandsWithDetected(commands, customConfig.commands),
    detected: detectedValidationCommands(commands),
    custom: customConfig.commands.map((customCommand) => customCommand.command),
    perRepo: repoMap.repos.map((repo) => ({
      repo: repo.displayName,
      repoRoot: repo.repoRoot,
      detected: detectedValidationCommands(repo.commands)
    }))
  };
}

/**
 * Union of every repo's commands, each stamped with the repo it runs in.
 * The `cwd` matters: a build command detected in svc-orders would simply fail
 * if a caller ran it at the workspace root.
 */
function mergeRepoCommandSets(repos: RepoMap[]): RepoCommandSet {
  const merged = repos.map((repo) => stampCommandCwd(repo.commands, repo.repoRoot));

  return {
    build: merged.flatMap((commands) => commands.build),
    test: merged.flatMap((commands) => commands.test),
    lint: merged.flatMap((commands) => commands.lint),
    format: merged.flatMap((commands) => commands.format),
    validation: merged.flatMap((commands) => commands.validation)
  };
}

/** Records the repo each command must run in, leaving an explicit cwd alone. */
function stampCommandCwd(commands: RepoCommandSet, repoRoot: string): RepoCommandSet {
  const stamp = <T extends DetectedCommand>(entries: T[]): T[] =>
    entries.map((entry) => ({ ...entry, cwd: entry.cwd ?? repoRoot }));

  return {
    build: stamp(commands.build),
    test: stamp(commands.test),
    lint: stamp(commands.lint),
    format: stamp(commands.format),
    validation: stamp(commands.validation)
  };
}

function detectedValidationCommands(commands: RepoCommandSet): DetectedCommand[] {
  return [
    ...commands.test,
    ...commands.build,
    ...commands.lint,
    ...commands.format,
    ...commands.validation
  ];
}

async function readExistingDraftPlan(
  startPath: string
): Promise<{ status: string; revision: number } | undefined> {
  const repoMap = await ensureRepoMap(startPath);
  const latestPlanPath = path.join(
    repoMap.workspaceRoot,
    ".copilot-architect",
    "plans",
    "latest-plan.json"
  );

  return (await tryReadJson(latestPlanPath)) as
    { status: string; revision: number } | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayArg(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");

  return strings.length > 0 ? strings : undefined;
}

async function readOptionalArtifact(
  startPath: string,
  relativeArtifactPath: string
): Promise<unknown> {
  const repoMap = await ensureRepoMap(startPath);
  const artifactPath = path.join(
    repoMap.workspaceRoot,
    ".copilot-architect",
    relativeArtifactPath
  );
  const value = await tryReadJson(artifactPath);

  return (
    value ?? {
      missing: true,
      artifactPath,
      message: "Artifact does not exist yet."
    }
  );
}

async function tryReadJson(filePath: string): Promise<unknown | undefined> {
  try {
    return await readJsonFile<unknown>(filePath);
  } catch {
    return undefined;
  }
}

function toToolResult(data: unknown): CallToolResult {
  const isFailure = isToolFailure(data);

  return {
    isError: isFailure || undefined,
    content: [
      {
        type: "text",
        text: `${JSON.stringify(isFailure ? data : { ok: true, data }, null, 2)}\n`
      }
    ]
  };
}

function isToolFailure(data: unknown): data is { ok: false; error: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "ok" in data &&
    (data as { ok: unknown }).ok === false &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  );
}

function resolveStartPath(
  args: Record<string, unknown>,
  options: CopilotArchitectMcpServerOptions
): string {
  return path.resolve(
    typeof args.path === "string" ? args.path : (options.startPath ?? process.cwd())
  );
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = args[key];

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  return fallback;
}

function requiredNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} is required`);
  }

  return value;
}

const commonSchema = {
  path: z.string().optional()
};

const searchSchema = {
  ...commonSchema,
  query: z.string(),
  limit: z.number().positive().optional()
};

const listFilesSchema = {
  ...commonSchema,
  filter: z.string().optional(),
  limit: z.number().positive().optional()
};

const requestSchema = {
  ...commonSchema,
  request: z.string(),
  limit: z.number().positive().optional()
};

const approvedRequestSchema = {
  ...requestSchema,
  approved: z.boolean().optional()
};

const generateFeaturePlanSchema = {
  ...approvedRequestSchema,
  restart: z.boolean().optional()
};

const reviseFeaturePlanSchema = {
  ...commonSchema,
  planId: z.string().optional(),
  feedback: z.string(),
  sections: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(["human-feedback", "code-review"]).optional(),
  reviewFindingIds: z.array(z.string()).optional()
};

const approvePlanSchema = {
  ...commonSchema,
  planId: z.string().optional(),
  revision: z.number(),
  approvedBy: z.string(),
  note: z.string().optional()
};

const resolveReviewFindingSchema = {
  ...commonSchema,
  findingId: z.string(),
  decision: z.enum(["accept", "decline"]),
  reason: z.string(),
  decidedBy: z.string(),
  planRevision: z.number().optional()
};
