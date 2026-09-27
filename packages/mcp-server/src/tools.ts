import { readFile } from "node:fs/promises";
import path from "node:path";

import { RepoDiscoveryService, WorkspaceService } from "@copilot-architect/core";
import { SymbolGraphService } from "@copilot-architect/graph";
import {
  IndexingService,
  shapeInventoryForModel,
  shapeSearchForModel
} from "@copilot-architect/indexer";
import { QueryIntentService } from "@copilot-architect/intent";
import { ContextMeasurementService } from "@copilot-architect/measurement";
import {
  FeaturePlanningService,
  WorkspacePlanningService,
  readApprovedPlan,
  writeApprovedPlan,
  applyFileEdits,
  applyPlanChanges,
  describeRefusals,
  verifyPlanFreshness,
  createPlanContract,
  buildPlannedChange,
  verifySelectedChanges,
  type FileEdit,
  type SelectedChange,
  type PlannedChange,
  type PlanContract
} from "@copilot-architect/planner";
import { GroundingService } from "@copilot-architect/grounding";
import { ReviewService } from "@copilot-architect/reviewer";
import { SessionService } from "@copilot-architect/session";
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
        shapeInventoryForModel(
          await new IndexingService().listFiles({
            startPath: resolveStartPath(args, options),
            filter: optionalStringArg(args, "filter"),
            limit: numberArg(args, "limit", 300)
          })
        )
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
        shapeSearchForModel(
          await new IndexingService().search({
            startPath: resolveStartPath(args, options),
            query: stringArg(args, "query"),
            limit: numberArg(args, "limit", 20)
          })
        )
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
        shapeSearchForModel(
          await new IndexingService().findSimilarFeatures({
            startPath: resolveStartPath(args, options),
            query: stringArg(args, "query"),
            limit: numberArg(args, "limit", 12)
          })
        )
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
        return { repoMap, search: shapeSearchForModel(search) };
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
    /**
     * The session model, for clients that are not the extension.
     *
     * Everything the redesign built — sessions, decisions, plan contracts,
     * grounding — was reachable only from `@architect`. Where policy forbids
     * installing an extension, MCP is the whole product, and it was still
     * serving the pre-redesign surface.
     */
    tool(
      "get_session",
      "Read the active Copilot Architect session: feature, phase, confirmed decisions, and plan versions. Returns null when no session is open.",
      commonSchema,
      true,
      async (args) => {
        const workspaceRoot = resolveStartPath(args, options);
        // peek, not current: reading a session must not park it. A caller
        // asking what the session is has not asked to end it.
        const peeked = await new SessionService().peek({ workspaceRoot });

        if (!peeked) {
          return { session: null, reason: "no active session in this workspace" };
        }

        const { session, staleBranch } = peeked;
        return {
          session: {
            title: session.title,
            phase: session.phase,
            status: session.status,
            decisions: new SessionService().activeDecisions(session),
            plans: session.plans.map((plan) => ({
              version: plan.version,
              status: plan.status,
              approvedAt: plan.approvedAt,
              implementedAt: plan.implementedAt
            }))
          },
          staleBranch
        };
      }
    ),
    tool(
      "get_approved_plan_contract",
      "Read the latest approved plan contract: the files it changes, why, each file's content at plan time, and the decisions it was approved under.",
      commonSchema,
      true,
      async (args) => {
        const workspaceRoot = resolveStartPath(args, options);
        const plan = await readApprovedPlan(workspaceRoot);

        return plan
          ? { plan }
          : {
              plan: null,
              // Distinct from an empty plan: no plan has been approved, which
              // means nothing authorizes writing code.
              reason: "no plan has been approved in this workspace"
            };
      }
    ),
    tool(
      "draft_plan_contract",
      "Draft a plan contract into the session from a file selection you have " +
        "already made — call search_repo and get_symbol_graph first to decide " +
        "which files actually need to change, the same way the VS Code " +
        "extension's /create-plan does; do not pass every related file, only " +
        "ones that actually change. `files` is `{path, kind, reason, symbol?, " +
        "steps?}[]`: `kind` is add/update/delete, `reason` is why this file " +
        "changes, `symbol` is one symbol in that file your reason rests on " +
        "(checked against the index — cite one or the reason cannot be " +
        "verified), `steps` is what actually happens to the file. An " +
        "`update`/`delete` naming a path outside the index is dropped and " +
        "reported back; nothing else is. This only drafts — nothing is " +
        "authorized to write until approve_plan_contract is called on this " +
        "exact version.",
      draftPlanContractSchema,
      false,
      async (args) => draftPlanContract(resolveStartPath(args, options), args)
    ),
    tool(
      "approve_plan_contract",
      "Approve a plan version drafted by draft_plan_contract, freezing it as " +
        "the plan apply_plan_edit will authorize writes against. `version` is " +
        "required — approval is always per-revision, never 'whatever is " +
        "newest'. The IDE's own tool-call approval on THIS call is the human " +
        "sign-off; nothing else in this server treats a draft as approved.",
      approvePlanContractSchema,
      false,
      async (args) => approvePlanContract(resolveStartPath(args, options), args)
    ),
    tool(
      "apply_plan_edit",
      "Edit one file from the approved plan by quoting what to replace, the " +
        "same discipline /implement uses in the VS Code extension: each edit's " +
        "`search` text must appear exactly once in the file, copied character " +
        "for character, or the whole file is left untouched and the reason is " +
        "returned. `relativePath` must name a file the approved plan lists as " +
        "an `update` — this tool refuses anything not authorized by an " +
        "approved plan, and refuses if the file drifted since the plan was " +
        "read. One block per change; leave the replace side empty to delete " +
        "the searched text. This is the one tool in this server that writes " +
        "to disk — the IDE's own tool-call approval is the human gate before " +
        "anything lands.",
      applyPlanEditSchema,
      false,
      async (args) => applyPlanEdit(resolveStartPath(args, options), args)
    ),
    tool(
      "verify_claims",
      "Check an answer's claims about this repository against the index. Backticked paths, file:line citations and qualified symbols are verified; prose is not, and the report says so.",
      { ...commonSchema, text: z.string() },
      true,
      async (args) => {
        const startPath = resolveStartPath(args, options);
        const text = String((args as { text?: unknown }).text ?? "");
        return new GroundingService().verify(text, { startPath });
      }
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

function editsArg(args: Record<string, unknown>, key: string): FileEdit[] {
  const value = args[key];

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array of { search, replace }`);
  }

  return value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).search !== "string"
    ) {
      throw new Error(`${key}[${index}] must have a string "search" field`);
    }

    const replace = (entry as Record<string, unknown>).replace;
    return {
      search: (entry as Record<string, unknown>).search as string,
      replace: typeof replace === "string" ? replace : ""
    };
  });
}

interface PlanFileArg {
  path: string;
  kind: "add" | "update" | "delete";
  reason: string;
  symbol?: string;
  steps?: string[];
}

function filesArg(args: Record<string, unknown>, key: string): PlanFileArg[] {
  const value = args[key];

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array of { path, kind, reason }`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${key}[${index}] must be an object`);
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path.trim().length === 0) {
      throw new Error(`${key}[${index}] must have a non-empty "path"`);
    }
    if (record.kind !== "add" && record.kind !== "update" && record.kind !== "delete") {
      throw new Error(`${key}[${index}].kind must be "add", "update", or "delete"`);
    }
    if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
      throw new Error(`${key}[${index}] must have a non-empty "reason"`);
    }

    return {
      path: record.path,
      kind: record.kind,
      reason: record.reason,
      symbol: typeof record.symbol === "string" ? record.symbol : undefined,
      steps: stringArrayArg(record, "steps")
    };
  });
}

/**
 * Drafts a plan contract into the session from a file selection Copilot
 * already made — the same contract `/create-plan` builds in the VS Code
 * extension, so `apply_plan_edit` can authorize against it once approved.
 *
 * The selection itself is not this tool's job: Copilot is expected to have
 * called search_repo / get_symbol_graph and decided which files actually
 * need to change, the same division of labor selectPlanChanges enforces in
 * the extension. This tool only validates and records that decision — an
 * `update`/`delete` naming a path outside the index is dropped rather than
 * quoting a snapshot of a file that is not there, and a cited symbol that
 * does not check out is flagged, never silently dropped, since the file may
 * still be the right one even when the stated reason is not.
 */
async function draftPlanContract(
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const request = stringArg(args, "request");
  const approach = stringArrayArg(args, "approach");
  const files = filesArg(args, "files");

  const indexing = new IndexingService();
  const inventory = await indexing
    .listFiles({ startPath: workspaceRoot, limit: Number.MAX_SAFE_INTEGER })
    .catch(() => undefined);
  const indexedPaths = new Set(
    (inventory?.files ?? []).map((file) =>
      file.repoName ? `${file.repoName}/${file.relativePath}` : file.relativePath
    )
  );

  const selection: SelectedChange[] = [];
  const stepsByPath = new Map<string, string[]>();
  const dropped: Array<{ path: string; reason: string }> = [];

  for (const file of files) {
    if (file.kind !== "add" && !indexedPaths.has(file.path)) {
      dropped.push({
        path: file.path,
        reason: `not in the index — a plan cannot quote a snapshot of a file that is not there`
      });
      continue;
    }

    if (file.steps && file.steps.length > 0) {
      stepsByPath.set(file.path, file.steps);
    }

    selection.push({
      kind: file.kind,
      relativePath: file.path,
      rationale: file.reason,
      ...(file.symbol ? { evidenceSymbol: file.symbol } : {})
    });
  }

  if (selection.length === 0) {
    return {
      ok: false,
      reason: "no valid files to plan — every file named was dropped",
      dropped
    };
  }

  const symbolsByFile = await indexing
    .symbolsByFile({ startPath: workspaceRoot })
    .catch(() => new Map<string, Set<string>>());
  const verified = verifySelectedChanges(selection, symbolsByFile);

  const changes: PlannedChange[] = [];
  for (const change of verified) {
    changes.push(
      await buildPlannedChange({
        repoRoot: workspaceRoot,
        relativePath: change.relativePath,
        kind: change.kind,
        rationale: change.rationale,
        ...(stepsByPath.has(change.relativePath)
          ? { intent: stepsByPath.get(change.relativePath) }
          : {})
      })
    );
  }

  const sessions = new SessionService();
  const current = await sessions.current({ workspaceRoot });
  const session = current
    ? current.phase === "plan"
      ? current
      : await sessions.setPhase({ workspaceRoot }, "plan")
    : await sessions.open({ workspaceRoot, title: request, phase: "plan" });

  const version = session.plans.length + 1;
  const plan = createPlanContract({
    request,
    version,
    decisions: [],
    changes,
    ...(approach && approach.length > 0 ? { approach } : {})
  });
  await sessions.addPlanVersion({ workspaceRoot }, { ...plan });

  return {
    ok: true,
    version,
    plan,
    evidence: verified.map((change) => ({
      path: change.relativePath,
      evidence: change.evidence,
      ...(change.evidenceReason ? { reason: change.evidenceReason } : {})
    })),
    dropped
  };
}

/**
 * Approves a drafted plan version, freezing it into the same
 * `plans/approved/latest.json` the VS Code extension's Approve button
 * writes — the only thing `apply_plan_edit` will authorize a write against.
 */
async function approvePlanContract(
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const version = requiredNumberArg(args, "version");

  const sessions = new SessionService();
  const session = await sessions.current({ workspaceRoot });
  if (!session) {
    return { ok: false, reason: "no active session in this workspace" };
  }

  const target = session.plans.find((entry) => entry.version === version);
  if (!target) {
    return {
      ok: false,
      reason: `no plan version ${version} in this session — draft one with draft_plan_contract first`
    };
  }

  const approved = await sessions.approvePlan({ workspaceRoot }, version);
  const latest = sessions.latestApprovedPlan(approved);

  if (!latest || latest.version !== version) {
    return { ok: false, reason: "approval did not take effect" };
  }

  await writeApprovedPlan(workspaceRoot, latest.content as unknown as PlanContract);

  return { ok: true, version };
}

/**
 * Applies one file's worth of search/replace edits from an approved plan.
 *
 * The only write path in this server, so every guard `/implement` already
 * enforces in the VS Code extension applies here too: the target must be a
 * file the approved plan actually lists as an `update` (a plan authorizes
 * specific files, not "any file this workspace has"), the plan must not have
 * drifted since it was read (an edit built against stale line numbers can
 * corrupt a file that moved underneath it), and every edit must match its
 * search text exactly once or nothing is written at all.
 */
async function applyPlanEdit(
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const relativePath = stringArg(args, "relativePath");
  const edits = editsArg(args, "edits");

  const plan = await readApprovedPlan(workspaceRoot);
  if (!plan) {
    return {
      ok: false,
      // Same wording as get_approved_plan_contract's empty case: a draft is
      // not authorization to write code.
      reason: "no plan has been approved in this workspace"
    };
  }

  const change = plan.changes.find((entry) => entry.relativePath === relativePath);
  if (!change) {
    return {
      ok: false,
      reason: `${relativePath} is not part of the approved plan — apply_plan_edit refuses to write outside what was authorized`
    };
  }

  if (change.kind !== "update") {
    return {
      ok: false,
      reason: `${relativePath} is planned as "${change.kind}" in the approved plan; apply_plan_edit only edits an existing file (kind "update")`
    };
  }

  const freshness = await verifyPlanFreshness(plan, workspaceRoot);
  if (!freshness.ok) {
    return {
      ok: false,
      reason:
        "the code moved since this plan was written — patching against a stale snapshot would corrupt it; re-plan before editing",
      drifted: freshness.drifted,
      missing: freshness.missing
    };
  }

  let original: string;
  try {
    original = await readFile(path.join(workspaceRoot, relativePath), "utf8");
  } catch {
    return { ok: false, reason: "the file could not be read" };
  }

  const result = applyFileEdits(original, edits);
  const refusal = describeRefusals(result.refused);
  if (refusal) {
    return { ok: false, reason: refusal, refused: result.refused };
  }

  const applied = await applyPlanChanges({
    workspaceRoot,
    changes: [{ relativePath, kind: "update", afterText: result.text }]
  });

  if (applied.refused.length > 0) {
    return { ok: false, reason: applied.refused[0].reason };
  }

  return { ok: true, written: relativePath, editsApplied: result.applied };
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

const applyPlanEditSchema = {
  ...commonSchema,
  relativePath: z.string(),
  edits: z.array(
    z.object({
      search: z.string(),
      replace: z.string()
    })
  )
};

const draftPlanContractSchema = {
  ...commonSchema,
  request: z.string(),
  approach: z.array(z.string()).optional(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["add", "update", "delete"]),
      reason: z.string(),
      // A symbol the reason rests on, checked against the index. Optional,
      // but leaving it out means the reason cannot be checked at all.
      symbol: z.string().optional(),
      steps: z.array(z.string()).optional()
    })
  )
};

const approvePlanContractSchema = {
  ...commonSchema,
  version: z.number().positive()
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
