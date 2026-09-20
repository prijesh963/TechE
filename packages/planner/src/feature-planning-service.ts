import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AdvancedAnalysisService, RepoDiscoveryService } from "@copilot-architect/core";
import type { SymbolEdgeKind, SymbolGraph } from "@copilot-architect/graph";
import { IndexingService, type SearchResult } from "@copilot-architect/indexer";
import {
  classifyIntent,
  extractEntities,
  type QueryIntentLabel
} from "@copilot-architect/intent";
import {
  CURRENT_SCHEMA_VERSION,
  type AdvancedAnalysis,
  type AdvancedRiskScore,
  type DetectedCommand,
  type FeaturePlan,
  type IntegrationInfo,
  type PlanQualityCheck,
  type PlanQualityScore,
  type PlanStep,
  type RepoMap,
  type RiskItem,
  type RouteApiEndpoint,
  type TestRelationship,
  type UniversalRepoMap,
  type ValidationCommand,
  type WorkspaceConfig,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  readJsonFile,
  writeJsonFile
} from "@copilot-architect/shared";
import {
  CommandConfigService,
  mergeValidationCommands,
  type ParsedCustomCommand
} from "@copilot-architect/validator";

import { renderFeaturePlanMarkdown } from "./markdown-renderer.js";
import type {
  FeaturePlanArtifact,
  FeaturePlanPreviewResult,
  FeaturePlanningOptions,
  FeaturePlanningResult,
  PlanApproval,
  PlanApprovalOptions,
  PlanArtifactPaths,
  PlanDraftArtifactPaths,
  PlanEndpointReference,
  PlanFileReference,
  PlanningContextSummary,
  PlanRevisionEntry,
  PlanRevisionOptions,
  PlanRevisionSummary,
  StackSpecificPlan
} from "./models.js";

interface PlanningContext {
  workspaceConfig?: WorkspaceConfig;
  customCommands: ParsedCustomCommand[];
  instructionFiles: string[];
}

export class FeaturePlanningService {
  async createPlan(options: FeaturePlanningOptions): Promise<FeaturePlanningResult> {
    const preview = await this.createPlanPreview(options);
    const revisionEntry: PlanRevisionEntry = {
      revision: 1,
      at: preview.plan.generatedAt,
      source: "initial",
      feedback: options.request.trim(),
      changedSections: []
    };
    const plan: FeaturePlanArtifact = {
      ...preview.plan,
      revision: 1,
      revisions: [revisionEntry]
    };
    const markdown = renderFeaturePlanMarkdown(plan);
    const paths = createPlanArtifactPaths(preview.repoRoot, plan.id);
    const draftPaths = createPlanDraftPaths(preview.repoRoot, plan.id, 1);

    await mkdir(getArtifactDirectoryPath(preview.repoRoot, "plans"), {
      recursive: true
    });
    await mkdir(path.dirname(draftPaths.draftJsonPath), { recursive: true });
    await writeJsonFile(paths.timestampJsonPath, plan);
    await writeJsonFile(paths.latestJsonPath, plan);
    await writeJsonFile(draftPaths.draftJsonPath, plan);
    await writeTextFile(paths.timestampMarkdownPath, markdown);
    await writeTextFile(paths.latestMarkdownPath, markdown);
    await writeTextFile(draftPaths.draftMarkdownPath, markdown);

    return {
      ...preview,
      plan,
      markdown,
      jsonPath: paths.timestampJsonPath,
      markdownPath: paths.timestampMarkdownPath,
      latestJsonPath: paths.latestJsonPath,
      latestMarkdownPath: paths.latestMarkdownPath
    };
  }

  /**
   * Edits the current draft in place instead of regenerating it, so
   * feedback from earlier conversation turns is never discarded. See
   * docs/PLAN_LIFECYCLE_DESIGN.md section 1.
   */
  async revisePlan(options: PlanRevisionOptions): Promise<FeaturePlanningResult> {
    const feedback = options.feedback.trim();

    if (!feedback) {
      throw new Error("feedback is required to revise a plan");
    }

    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repoRoot = repoMap.workspaceRoot;
    const planId = options.planId ?? (await findLatestDraftPlanId(repoRoot));

    if (!planId) {
      throw new Error(
        "No draft plan found to revise. Call generate_feature_plan first."
      );
    }

    const current = await loadLatestDraftRevision(repoRoot, planId);
    const nextRevision = current.revision + 1;
    const changedSections = options.sections ? Object.keys(options.sections) : [];
    const revisionEntry: PlanRevisionEntry = {
      revision: nextRevision,
      at: new Date().toISOString(),
      source: options.source ?? "human-feedback",
      feedback,
      changedSections,
      reviewFindingIds: options.reviewFindingIds
    };
    const plan: FeaturePlanArtifact = {
      ...current,
      ...(options.sections ?? {}),
      // A revision is always unapproved: the previous approval was granted
      // for the revision it replaces, not for this one.
      status: "draft",
      approval: undefined,
      revision: nextRevision,
      supersedes: `${planId}-rev${current.revision}`,
      revisions: [...current.revisions, revisionEntry]
    };
    const markdown = renderFeaturePlanMarkdown(plan);
    const paths = createPlanArtifactPaths(repoRoot, planId);
    const draftPaths = createPlanDraftPaths(repoRoot, planId, nextRevision);

    await mkdir(path.dirname(draftPaths.draftJsonPath), { recursive: true });
    await writeJsonFile(draftPaths.draftJsonPath, plan);
    await writeJsonFile(paths.latestJsonPath, plan);
    await writeTextFile(draftPaths.draftMarkdownPath, markdown);
    await writeTextFile(paths.latestMarkdownPath, markdown);

    return {
      repoRoot,
      plan,
      markdown,
      jsonPath: draftPaths.draftJsonPath,
      markdownPath: draftPaths.draftMarkdownPath,
      latestJsonPath: paths.latestJsonPath,
      latestMarkdownPath: paths.latestMarkdownPath,
      searchResults: []
    };
  }

  /**
   * Stamps approval onto one specific, already-saved revision and promotes
   * exactly that revision to latest-plan.*. Approval is always per-revision
   * — there is no "approve whatever is newest". See
   * docs/PLAN_LIFECYCLE_DESIGN.md section 2.
   */
  async approvePlan(options: PlanApprovalOptions): Promise<FeaturePlanningResult> {
    const approvedBy = options.approvedBy.trim();

    if (!approvedBy) {
      throw new Error("approvedBy is required to approve a plan");
    }

    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repoRoot = repoMap.workspaceRoot;
    const planId = options.planId ?? (await findLatestDraftPlanId(repoRoot));

    if (!planId) {
      throw new Error(
        "No draft plan found to approve. Call generate_feature_plan first."
      );
    }

    const draftPaths = createPlanDraftPaths(repoRoot, planId, options.revision);
    const target = await readOptionalJson<FeaturePlanArtifact>(
      draftPaths.draftJsonPath
    );

    if (!target) {
      throw new Error(
        `Revision ${options.revision} not found for plan "${planId}". Call plan revisions to see what exists.`
      );
    }

    const approval: PlanApproval = {
      approvedAt: new Date().toISOString(),
      approvedBy,
      revision: options.revision,
      note: options.note
    };
    const plan: FeaturePlanArtifact = {
      ...target,
      status: "approved",
      approval
    };
    const markdown = renderFeaturePlanMarkdown(plan);
    const paths = createPlanArtifactPaths(repoRoot, planId);
    const approvedCopyPath = createApprovedPlanPath(repoRoot, planId, options.revision);

    await mkdir(path.dirname(approvedCopyPath), { recursive: true });
    // Keep the draft revision consistent with its own approval state...
    await writeJsonFile(draftPaths.draftJsonPath, plan);
    await writeTextFile(draftPaths.draftMarkdownPath, markdown);
    // ...and freeze an immutable copy that later revisions can never touch.
    await writeJsonFile(approvedCopyPath, plan);
    // Promote this exact revision to latest, even if newer unapproved
    // drafts exist.
    await writeJsonFile(paths.latestJsonPath, plan);
    await writeTextFile(paths.latestMarkdownPath, markdown);

    return {
      repoRoot,
      plan,
      markdown,
      jsonPath: approvedCopyPath,
      markdownPath: draftPaths.draftMarkdownPath,
      latestJsonPath: paths.latestJsonPath,
      latestMarkdownPath: paths.latestMarkdownPath,
      searchResults: []
    };
  }

  async listRevisions(options: {
    startPath?: string;
    strictRoot?: boolean;
    planId?: string;
  }): Promise<PlanRevisionSummary[]> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repoRoot = repoMap.workspaceRoot;
    const planId = options.planId ?? (await findLatestDraftPlanId(repoRoot));

    if (!planId) {
      throw new Error("No draft plan found. Call generate_feature_plan first.");
    }

    const revisionNumbers = await listDraftRevisionNumbers(repoRoot, planId);

    return Promise.all(
      revisionNumbers.map(async (revision) => {
        const plan = await readJsonFile<FeaturePlanArtifact>(
          createPlanDraftPaths(repoRoot, planId, revision).draftJsonPath
        );
        const latestEntry = plan.revisions[plan.revisions.length - 1];

        return {
          revision: plan.revision,
          status: plan.status,
          at: latestEntry?.at ?? plan.generatedAt,
          source: latestEntry?.source ?? "initial",
          approval: plan.approval
        };
      })
    );
  }

  async showRevision(options: {
    startPath?: string;
    strictRoot?: boolean;
    planId?: string;
    revision?: number;
  }): Promise<FeaturePlanArtifact> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repoRoot = repoMap.workspaceRoot;
    const planId = options.planId ?? (await findLatestDraftPlanId(repoRoot));

    if (!planId) {
      throw new Error("No draft plan found. Call generate_feature_plan first.");
    }

    if (options.revision === undefined) {
      return loadLatestDraftRevision(repoRoot, planId);
    }

    const draftPaths = createPlanDraftPaths(repoRoot, planId, options.revision);
    const plan = await readOptionalJson<FeaturePlanArtifact>(draftPaths.draftJsonPath);

    if (!plan) {
      throw new Error(`Revision ${options.revision} not found for plan "${planId}".`);
    }

    return plan;
  }

  async createPlanPreview(
    options: FeaturePlanningOptions
  ): Promise<FeaturePlanPreviewResult> {
    const request = options.request.trim();

    if (!request) {
      throw new Error("Feature request is required");
    }

    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repoRoot = repoMap.workspaceRoot;
    const planningContext = await loadPlanningContext(repoRoot);
    const indexer = new IndexingService();
    await indexer.index({ startPath: repoRoot, strictRoot: options.strictRoot });
    // Intent-aware retrieval (see docs/CODEBASE_INTELLIGENCE_DESIGN.md
    // section 4): reuse #3's pure classification/entity-extraction to
    // search on the request's subject terms rather than the raw sentence.
    const requestIntent = classifyIntent(request);
    const requestEntities = extractEntities(request);
    const refinedQuery =
      requestEntities.length > 0 ? requestEntities.join(" ") : request;
    const searchResponse = await indexer.findSimilarFeatures({
      startPath: repoRoot,
      strictRoot: options.strictRoot,
      query: refinedQuery,
      limit: options.searchLimit ?? 12
    });
    const repo = repoMap.repos[0];

    if (!repo) {
      throw new Error("Repo map does not contain any repositories");
    }

    const advancedAnalysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot,
      request,
      repoMap
    });
    // Read-only, same precedent as packages/indexer's own tryReadGraph:
    // never build the graph inline here, only cite it if it already exists.
    const graph = await tryReadGraph(repoRoot);
    const plan = buildPlan(
      request,
      requestIntent,
      requestEntities,
      repoMap,
      repo,
      searchResponse.results,
      graph,
      planningContext,
      advancedAnalysis
    );
    const markdown = renderFeaturePlanMarkdown(plan);

    return {
      repoRoot,
      plan,
      markdown,
      searchResults: searchResponse.results
    };
  }
}

async function tryReadGraph(repoRoot: string): Promise<SymbolGraph | undefined> {
  try {
    return await readJsonFile<SymbolGraph>(getArtifactFilePath(repoRoot, "graph"));
  } catch {
    return undefined;
  }
}

async function ensureRepoMap(
  startPath: string,
  strictRoot: boolean | undefined
): Promise<UniversalRepoMap> {
  const repoMapPath = getArtifactFilePath(startPath, "repoMap");

  try {
    return await readJsonFile<UniversalRepoMap>(repoMapPath);
  } catch {
    return (await new RepoDiscoveryService().analyze({ startPath, strictRoot }))
      .repoMap;
  }
}

async function loadPlanningContext(repoRoot: string): Promise<PlanningContext> {
  const workspaceConfig = await readOptionalJson<WorkspaceConfig>(
    getArtifactFilePath(repoRoot, "workspace")
  );
  const commandsPath =
    resolveRepoLocalPath(repoRoot, workspaceConfig?.customCommandsPath) ??
    getArtifactFilePath(repoRoot, "commands");
  const commandConfig = await new CommandConfigService().load({
    startPath: repoRoot,
    configPath: commandsPath,
    allowMissing: true
  });

  return {
    workspaceConfig,
    customCommands: commandConfig.commands,
    instructionFiles: await findInstructionFiles(repoRoot)
  };
}

function buildPlan(
  request: string,
  requestIntent: QueryIntentLabel,
  requestEntities: string[],
  repoMap: UniversalRepoMap,
  repo: RepoMap,
  searchResults: SearchResult[],
  graph: SymbolGraph | undefined,
  planningContext: PlanningContext,
  advancedAnalysis: AdvancedAnalysis
): FeaturePlanArtifact {
  const id = timestampId();
  const title = titleFromRequest(request);
  const candidateFiles = new Set(searchResults.map((result) => result.relativePath));
  const citations = buildGraphCitations(graph, candidateFiles);
  const relevantFiles = searchResults
    .slice(0, 8)
    .map((result) => toRelevantFile(result, requestEntities, citations));
  const similarFeatureCandidates = searchResults
    .filter((result) => !result.isConfigFile)
    .slice(0, 6)
    .map((result) => ({
      filePath: result.relativePath,
      score: result.score,
      reason: describeRelevance(result, requestEntities, citations)
    }));
  const impactedModules = inferImpactedModules(searchResults, repo);
  const validationCommands = collectValidationCommands(
    repo,
    planningContext.customCommands
  );
  const stackSpecificPlan = createStackSpecificPlan(repo);
  const likelyFilesToModify = inferLikelyFilesToModify(searchResults);
  const relatedEndpoints = selectRelatedEndpoints(
    request,
    advancedAnalysis.routes,
    advancedAnalysis.testRelationships,
    likelyFilesToModify
  );
  const likelyNewFiles = inferLikelyNewFiles(
    repo,
    request,
    impactedModules,
    searchResults
  );
  const assumptions = createAssumptions(repo, searchResults, planningContext);
  const openQuestions = createOpenQuestions(repo, request, planningContext);
  const risks = createRisks(repo, searchResults, advancedAnalysis.riskScores);
  const testStrategy = createTestStrategy(repo, validationCommands);
  const requestInterpretation = `Implement "${request}" using the existing repository patterns, with changes scoped to the most relevant modules and with validation evidence before handoff.`;
  const affectedCommands = validationCommands.map((command) =>
    [command.command, ...command.args].join(" ")
  );
  const impactedLanguages = repo.languages.map((language) => language.name);
  const impactedFrameworks = repo.frameworks.map((framework) => framework.name);
  const featurePlan: FeaturePlan = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    id,
    title,
    task: request,
    status: "draft",
    repoRoot: repo.repoRoot,
    summary: `Plan for ${request} across ${repoMap.summary.projectCount} detected project(s).`,
    assumptions,
    implementationSteps: createImplementationSteps(
      request,
      likelyFilesToModify,
      likelyNewFiles,
      stackSpecificPlan,
      relatedEndpoints
    ),
    impactAnalysis: {
      summary: `Likely impact spans ${impactedModules.length || 1} module/folder area(s), ${impactedLanguages.length || 0} language(s), and ${impactedFrameworks.length || 0} framework(s).`,
      affectedProjects: repo.projects.map((project) => project.name),
      affectedFiles: likelyFilesToModify,
      affectedCommands,
      risks,
      testGaps: createTestGaps(searchResults, repo, relatedEndpoints)
    },
    validationPlan: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      commands: validationCommands,
      strategy:
        "Run focused tests for touched modules first, then run detected build/lint/test commands before implementation handoff.",
      requiredEvidence: [
        "Plan approval confirmation",
        "Relevant test output",
        "Build/lint output when available",
        "Review report from git diff after implementation"
      ]
    },
    requiresHumanApproval: true
  };

  const planQuality = createPlanQualityScore({
    relevantFiles,
    likelyFilesToModify,
    validationCommands,
    assumptions,
    advancedAnalysis
  });

  return {
    ...featurePlan,
    requestInterpretation,
    requestIntent,
    requestEntities,
    repoArchitectureSummary: repoMap.summary.summary,
    planningContext: summarizePlanningContext(planningContext),
    relevantFiles,
    similarFeatureCandidates,
    impactedLanguages,
    impactedFrameworks,
    impactedModules,
    likelyFilesToModify,
    likelyNewFiles,
    frontendImpact: createFrontendImpact(repo, request),
    backendImpact: createBackendImpact(repo, request),
    dataConfigImpact: createDataConfigImpact(repo, request),
    securityConsiderations: createSecurityConsiderations(request),
    performanceConsiderations: createPerformanceConsiderations(request),
    testStrategy,
    openQuestions,
    humanApprovalCheckpoint:
      "Stop here for human approval before generating or applying implementation handoff prompts.",
    stackSpecificPlan,
    advancedAnalysis,
    riskScores: advancedAnalysis.riskScores,
    planQuality,
    readinessDiagnostics: advancedAnalysis.diagnostics,
    relatedEndpoints,
    revision: 1,
    revisions: []
  };
}

function collectValidationCommands(
  repo: RepoMap,
  customCommands: ParsedCustomCommand[]
): ValidationCommand[] {
  const commands: DetectedCommand[] = [
    ...repo.commands.test,
    ...repo.commands.build,
    ...repo.commands.lint,
    ...repo.commands.format,
    ...repo.commands.validation
  ];
  const detectedCommands = commands.map((command, index) => ({
    kind: "validation" as const,
    name: command.name || `validation-${index + 1}`,
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    description: command.description,
    confidence: command.confidence,
    source: command.source,
    required: index < 3
  }));

  return mergeValidationCommands(detectedCommands, customCommands).slice(0, 8);
}

function createImplementationSteps(
  request: string,
  likelyFilesToModify: string[],
  likelyNewFiles: string[],
  stackSpecificPlan: StackSpecificPlan,
  relatedEndpoints: PlanEndpointReference[]
): PlanStep[] {
  const endpointDetails =
    relatedEndpoints.length > 0
      ? `Touch the related endpoint(s) ${relatedEndpoints
          .map((endpoint) => formatEndpoint(endpoint))
          .join("; ")}.`
      : flattenStackSpecificPlan(stackSpecificPlan).join(" ");
  const endpointFiles = unique([
    ...likelyNewFiles,
    ...relatedEndpoints.map((endpoint) => endpoint.filePath)
  ]);
  const endpointTestFiles = relatedEndpoints
    .map((endpoint) => endpoint.testFile)
    .filter((testFile): testFile is string => Boolean(testFile));

  return [
    {
      id: "step-1",
      title: "Confirm scope and existing patterns",
      details: `Review relevant files and similar candidates for "${request}" before making changes.`,
      files: likelyFilesToModify,
      dependsOn: []
    },
    {
      id: "step-2",
      title: "Update domain/application behavior",
      details:
        "Implement the smallest coherent behavior change in existing modules before adding new abstractions.",
      files: [...likelyFilesToModify, ...likelyNewFiles],
      dependsOn: ["step-1"]
    },
    {
      id: "step-3",
      title: "Add or update stack-specific integration points",
      details: endpointDetails,
      files: endpointFiles,
      dependsOn: ["step-2"]
    },
    {
      id: "step-4",
      title: "Add focused tests and validation evidence",
      details:
        endpointTestFiles.length > 0
          ? `Add tests around the new workflow and extend existing endpoint tests (${endpointTestFiles.join(", ")}); then run the detected validation commands.`
          : "Add tests around the new workflow and run the detected validation commands.",
      files: unique([
        ...likelyFilesToModify.filter(isLikelyTestFile),
        ...endpointTestFiles
      ]),
      dependsOn: ["step-2", "step-3"]
    },
    {
      id: "step-5",
      title: "Prepare review notes",
      details:
        "Summarize behavior changes, validation evidence, risks, and any follow-up questions.",
      files: [],
      dependsOn: ["step-4"]
    }
  ];
}

function createStackSpecificPlan(repo: RepoMap): StackSpecificPlan {
  const frameworks = new Set(repo.frameworks.map((framework) => framework.name));
  const languages = new Set(repo.languages.map((language) => language.name));

  return {
    react: frameworks.has("React")
      ? [
          "Identify affected components and keep props/state changes close to existing patterns.",
          "Add or update hooks only if shared client-side workflow state is needed.",
          "Check route/page files for navigation or workflow entry points.",
          "Update API client calls if the workflow requires backend coordination.",
          "Add component and interaction tests for the workflow."
        ]
      : [],
    angular: frameworks.has("Angular")
      ? [
          "Identify affected components and templates.",
          "Add or update services for workflow coordination.",
          "Check modules for declarations/providers if new Angular artifacts are needed.",
          "Review guards/interceptors for authorization or API behavior.",
          "Add or update spec files for components and services."
        ]
      : [],
    python: languages.has("Python")
      ? [
          "Identify Python modules/packages that own the workflow.",
          "Update service functions before adding new package structure.",
          "Check FastAPI/Flask/Django routes if the request exposes API behavior.",
          "Add pytest or unittest coverage for success and failure paths."
        ]
      : [],
    java: languages.has("Java")
      ? [
          "Identify Java packages that own controllers, services, repositories, and DTOs.",
          "Keep workflow logic in services rather than controllers.",
          "Update persistence/repository contracts if the workflow changes stored state.",
          "Add JUnit coverage for service behavior and API boundaries."
        ]
      : [],
    integrations: createIntegrationGuidance(repo.integrations ?? []),
    generic: [
      "Follow nearby naming, folder, and test conventions.",
      "Prefer extending existing modules over creating new architecture.",
      "Keep implementation handoff blocked until this plan is approved."
    ]
  };
}

/**
 * Guidance specific to each detected integration, plus a per-category
 * baseline. Composing per detection rather than per stack combination is what
 * lets an arbitrary mix ("Java + Oracle + Kafka + micro-frontend") produce
 * guidance for all four without a branch per combination — and it means a
 * newly detected integration still gets category-shaped advice for free.
 */
const INTEGRATION_GUIDANCE: Record<string, string> = {
  Oracle:
    "Oracle: confirm how schema changes are applied (Flyway/Liquibase vs manual DDL), check sequence/trigger usage, and review transaction boundaries before changing persistence code.",
  MongoDB:
    "MongoDB: adding document fields is backward compatible but removing or renaming them is not — check existing documents, index coverage for new query shapes, and prefer repository methods over ad-hoc queries.",
  Kafka:
    "Kafka: a payload change is a contract change. Update producers AND consumers, check serializer/schema compatibility, and consider replay of already-published messages by existing consumer groups.",
  "IBM MQ":
    "IBM MQ: verify queue/channel configuration, message format and acknowledgement mode, and whether producer and consumer must be deployed together.",
  JMS: "JMS: check the message format, acknowledgement mode, and dead-letter/retry behavior; a listener signature change affects every producer on that destination.",
  "Module Federation":
    "Module Federation: exposed modules and shared dependencies bind at RUNTIME, not build time. A change to an exposed contract or a shared dependency version affects every remote — check host and remote alignment together.",
  "single-spa":
    "single-spa: registered applications are mounted at runtime; check the registration config and cross-app shared state before changing an app's public surface.",
  OpenFeign:
    "OpenFeign: a REST contract change breaks the Feign client interface in calling services — update both sides and their tests together.",
  Kubernetes:
    "Kubernetes: a code change to env vars, config, ports, or readiness/liveness behavior needs a matching change to the Deployment/Service manifest — the two drift independently unless updated together.",
  "Docker Compose":
    "Docker Compose: service definitions (ports, env, volumes, depends_on) are a contract with the code that reads them — check the compose file alongside a config or startup change.",
  Nx: "Nx: check the workspace's own project graph (`nx graph`, or a project's `implicitDependencies`) for what else depends on the project being changed before assuming the change is isolated.",
  Turborepo:
    "Turborepo: check turbo.json's task dependsOn graph for what else in the workspace depends on the project being changed before assuming the change is isolated.",
  Playwright:
    "Playwright: a shared locator, fixture or page object affects every spec that uses it, not just the file being changed — and a spec that starts failing intermittently is worth treating as a real regression before assuming it is flaky.",
  Cucumber:
    "Cucumber: a step definition is matched to feature files by its step text, not by filename — rewording or reparameterizing a step can silently stop matching every scenario still phrased the old way, across the whole suite, not just the file being edited.",
  TestNG:
    "TestNG: check testng.xml's suite and group membership, and any dependsOnMethods/dependsOnGroups — a renamed or reordered test can silently drop out of a suite or break an execution-order dependency."
};

const CATEGORY_GUIDANCE: Record<string, string> = {
  datastore:
    "Datastore change: plan the migration path and rollback, and confirm whether existing rows/documents need backfilling.",
  messaging:
    "Messaging change: treat the message shape as a published contract — identify every producer and consumer before changing it.",
  "micro-frontend":
    "Micro-frontend: changes cross application boundaries at runtime; confirm which host or remote owns the change and how versions are aligned.",
  microservice:
    "Microservice platform: an API change ripples to callers, gateway routes and service registration — enumerate the calling services before changing a contract.",
  // Helm relies on this baseline rather than a name-specific entry — same
  // precedent as "Web Components" under micro-frontend: not every detected
  // name needs its own line, and the category still guarantees one.
  orchestration:
    "Deployment topology: check the manifest or compose file for the service alongside the code — ports, environment variables, resource limits and inter-service links can silently drift from what the code now needs.",
  "monorepo-tooling":
    "Monorepo build graph: other projects in this repo may depend on the one being changed — check the build tool's own dependency graph, not just imports, before assuming the change is isolated.",
  "test-automation":
    "Test automation: a change to a shared step, fixture, locator or page object can silently break every scenario or spec that uses it — check what else calls the changed helper before assuming the change is contained to one test file."
};

function createIntegrationGuidance(integrations: IntegrationInfo[]): string[] {
  if (integrations.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const categoriesSeen = new Set<string>();

  for (const integration of integrations) {
    const specific = INTEGRATION_GUIDANCE[integration.name];
    if (specific) {
      lines.push(specific);
    }
    categoriesSeen.add(integration.category);
  }

  // One baseline line per category covers integrations with no specific entry,
  // so a newly added detection is never silently guidance-free.
  for (const category of [...categoriesSeen].sort()) {
    const baseline = CATEGORY_GUIDANCE[category];
    if (baseline) {
      lines.push(baseline);
    }
  }

  const detected = integrations
    .map((integration) => `${integration.name} (${integration.confidence} confidence)`)
    .join(", ");
  lines.push(`Detected integrations to account for: ${detected}.`);

  return lines;
}

function createFrontendImpact(repo: RepoMap, request: string): string[] {
  const frameworkNames = repo.frameworks.map((framework) => framework.name);
  const impacts: string[] = [];

  if (frameworkNames.some((name) => ["React", "Angular", "Next.js"].includes(name))) {
    impacts.push(`UI may need workflow affordances for ${request}.`);
    impacts.push("Review route/page/component boundaries before adding screens.");
  }

  return impacts;
}

function createBackendImpact(repo: RepoMap, request: string): string[] {
  const languages = repo.languages.map((language) => language.name);
  const frameworks = repo.frameworks.map((framework) => framework.name);
  const impacts: string[] = [];

  if (
    languages.some((language) =>
      ["Python", "Java", "TypeScript", "JavaScript"].includes(language)
    )
  ) {
    impacts.push(`Backend or service logic may need to enforce ${request}.`);
  }

  if (
    frameworks.some((framework) =>
      ["FastAPI", "Flask", "Django", "Spring Boot", "Node.js"].includes(framework)
    )
  ) {
    impacts.push("Review API handlers/controllers and service boundaries.");
  }

  return impacts;
}

function createDataConfigImpact(repo: RepoMap, request: string): string[] {
  const impacts = [
    "Check whether new configuration, status values, or schema changes are required."
  ];

  if (repo.packageManagers.length > 0) {
    impacts.push(
      "Avoid dependency changes unless existing packages cannot support the workflow."
    );
  }

  if (request.toLowerCase().includes("approval")) {
    impacts.push(
      "Approval workflows often require persisted state, audit fields, or transition rules."
    );
  }

  return impacts;
}

function createSecurityConsiderations(request: string): string[] {
  const considerations = [
    "Confirm authorization boundaries before exposing or modifying workflow actions.",
    "Do not log secrets, tokens, or sensitive payloads while adding validation evidence."
  ];

  if (request.toLowerCase().includes("approval")) {
    considerations.push(
      "Approval actions should record actor, timestamp, and allowed state transitions."
    );
  }

  return considerations;
}

function createPerformanceConsiderations(request: string): string[] {
  return [
    `Keep ${request} queries scoped and avoid broad scans in request paths.`,
    "Reuse existing caching, pagination, and batching patterns where present."
  ];
}

function createTestStrategy(
  repo: RepoMap,
  validationCommands: ValidationCommand[]
): string[] {
  const strategy = [
    "Add focused tests for the changed workflow before broad regression runs.",
    "Cover success, failure, and permission/state-transition paths."
  ];

  if (repo.commands.test.length > 0) {
    strategy.push(
      "Run detected test commands and capture output as validation evidence."
    );
  }

  if (validationCommands.some((command) => command.name.includes("lint"))) {
    strategy.push("Run lint checks after implementation changes.");
  }

  if (validationCommands.some((command) => command.name.includes("build"))) {
    strategy.push("Run build checks to catch type and integration errors.");
  }

  return strategy;
}

function createAssumptions(
  repo: RepoMap,
  searchResults: SearchResult[],
  planningContext: PlanningContext
): string[] {
  return [
    "Existing repository patterns should be followed before introducing new abstractions.",
    searchResults.length > 0
      ? "Search results identify the most likely starting points, but final file ownership must be confirmed by inspection."
      : "No strong similar feature candidates were found in the local index.",
    repo.commands.test.length > 0
      ? "Detected test commands are expected to be the first validation layer."
      : "No test command was detected yet; validation may require custom command configuration in a later phase.",
    planningContext.customCommands.length > 0
      ? "Custom command configuration is available and should be considered part of validation."
      : "No custom command configuration was found for this plan.",
    planningContext.instructionFiles.length > 0
      ? "Existing instruction files should shape implementation handoff wording."
      : "No generated instruction files were found for this plan."
  ];
}

function createOpenQuestions(
  repo: RepoMap,
  request: string,
  planningContext: PlanningContext
): string[] {
  const questions = [
    `What exact acceptance criteria define "${request}"?`,
    "Which user roles or systems are allowed to trigger the workflow?",
    "Which existing module owns the final behavior?"
  ];

  if (repo.languages.length > 1) {
    questions.push(
      "Which repo/project boundary should own cross-stack workflow changes?"
    );
  }

  if ((planningContext.workspaceConfig?.repoRoots.length ?? 0) > 1) {
    questions.push("Which workspace repo owns the primary implementation?");
  }

  return questions;
}

function createRisks(
  repo: RepoMap,
  searchResults: SearchResult[],
  riskScores: AdvancedRiskScore[]
): RiskItem[] {
  const risks: RiskItem[] = [
    {
      severity: "medium",
      title: "Behavior spread across modules",
      details:
        "The feature may touch multiple folders or layers if workflow ownership is unclear.",
      mitigation:
        "Start from the highest-ranked relevant files and keep changes scoped."
    }
  ];

  if (searchResults.length === 0) {
    risks.push({
      severity: "medium",
      title: "No similar feature found",
      details: "The local index did not find strong nearby examples.",
      mitigation:
        "Inspect architecture summaries and ask for approval before broad changes."
    });
  }

  if (repo.commands.test.length === 0) {
    risks.push({
      severity: "medium",
      title: "Missing detected tests",
      details: "No test command was detected in repo analysis.",
      mitigation:
        "Add custom command configuration in Phase 8 or document manual validation."
    });
  }

  for (const riskScore of riskScores.filter((risk) => risk.level !== "low")) {
    risks.push({
      severity: riskScore.level,
      title: `${riskScore.category} risk score: ${riskScore.level}`,
      details: `${riskScore.score}/100. ${riskScore.reasons.join(" ")}`,
      mitigation: riskScore.mitigation
    });
  }

  return risks;
}

function createPlanQualityScore(input: {
  relevantFiles: PlanFileReference[];
  likelyFilesToModify: string[];
  validationCommands: ValidationCommand[];
  assumptions: string[];
  advancedAnalysis: AdvancedAnalysis;
}): PlanQualityScore {
  const checks: PlanQualityCheck[] = [
    {
      name: "context",
      passed:
        input.advancedAnalysis.architecturePatterns.length > 0 ||
        input.relevantFiles.length > 0,
      score:
        input.advancedAnalysis.architecturePatterns.length > 0
          ? 25
          : input.relevantFiles.length > 0
            ? 18
            : 0,
      details: `${input.advancedAnalysis.architecturePatterns.length} architecture pattern(s), ${input.relevantFiles.length} relevant file(s).`
    },
    {
      name: "impacted-files",
      passed: input.likelyFilesToModify.length > 0,
      score: input.likelyFilesToModify.length > 0 ? 25 : 0,
      details: `${input.likelyFilesToModify.length} likely file(s) to modify.`
    },
    {
      name: "validation-commands",
      passed: input.validationCommands.length > 0,
      score: input.validationCommands.length > 0 ? 20 : 0,
      details: `${input.validationCommands.length} validation command(s) found.`
    },
    {
      name: "assumptions",
      passed: input.assumptions.length <= 6,
      score: input.assumptions.length <= 6 ? 15 : 6,
      details: `${input.assumptions.length} assumption(s) recorded.`
    },
    {
      name: "advanced-analysis",
      passed:
        input.advancedAnalysis.routes.length > 0 ||
        input.advancedAnalysis.testRelationships.length > 0 ||
        input.advancedAnalysis.dependencyManifests.length > 0,
      score:
        input.advancedAnalysis.routes.length > 0 ||
        input.advancedAnalysis.testRelationships.length > 0 ||
        input.advancedAnalysis.dependencyManifests.length > 0
          ? 15
          : 5,
      details: `${input.advancedAnalysis.routes.length} route(s), ${input.advancedAnalysis.testRelationships.length} test relationship(s), ${input.advancedAnalysis.dependencyManifests.length} dependency manifest(s).`
    }
  ];
  const score = checks.reduce((total, check) => total + check.score, 0);
  const warnings = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.details}`);

  return {
    score,
    level: score >= 80 ? "low" : score >= 55 ? "medium" : "high",
    checks,
    warnings
  };
}

function createTestGaps(
  searchResults: SearchResult[],
  repo: RepoMap,
  relatedEndpoints: PlanEndpointReference[]
): string[] {
  const gaps: string[] = [];

  if (!searchResults.some((result) => result.isTestFile)) {
    gaps.push("No directly relevant test file was found in index search results.");
  }

  if (repo.commands.test.length === 0) {
    gaps.push("No test command was detected.");
  }

  for (const endpoint of relatedEndpoints) {
    if (!endpoint.testFile) {
      gaps.push(
        `Endpoint ${endpoint.method} ${endpoint.routePath} (${endpoint.filePath}) has no nearby test.`
      );
    }
  }

  return gaps;
}

// Pick the API endpoints most relevant to the request: those whose file is
// already a likely modification target, or whose route/handler shares words
// with the request. Each is paired with its nearest test (if one exists).
function selectRelatedEndpoints(
  request: string,
  routes: RouteApiEndpoint[],
  testRelationships: TestRelationship[],
  likelyFilesToModify: string[]
): PlanEndpointReference[] {
  const requestTerms = new Set(requestWords(request));
  const modifyFiles = new Set(likelyFilesToModify);
  const testByRoute = new Map<string, string>();
  const testByFile = new Map<string, string>();

  for (const relationship of testRelationships) {
    if (!relationship.testFile) {
      continue;
    }
    if (relationship.routePath) {
      testByRoute.set(relationship.routePath, relationship.testFile);
    }
    testByFile.set(relationship.sourceFile, relationship.testFile);
  }

  return routes
    .map((route) => {
      const routeTerms = requestWords(`${route.routePath} ${route.handler ?? ""}`);
      const overlap = routeTerms.filter((term) => requestTerms.has(term)).length;
      const score = overlap + (modifyFiles.has(route.filePath) ? 1 : 0);
      return { route, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ route }) => ({
      method: route.method,
      routePath: route.routePath,
      filePath: route.filePath,
      line: route.line,
      testFile: testByRoute.get(route.routePath) ?? testByFile.get(route.filePath)
    }));
}

function formatEndpoint(endpoint: PlanEndpointReference): string {
  const location = endpoint.line
    ? `${endpoint.filePath}:${endpoint.line}`
    : endpoint.filePath;
  const test = endpoint.testFile
    ? ` covered by \`${endpoint.testFile}\``
    : " (no test yet)";
  return `${endpoint.method} ${endpoint.routePath} (\`${location}\`)${test}`;
}

function requestWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

function inferLikelyFilesToModify(searchResults: SearchResult[]): string[] {
  const nonDocs = searchResults
    .filter((result) => !result.isDocFile && !result.isConfigFile)
    .map((result) => result.relativePath);

  return unique(nonDocs).slice(0, 8);
}

/**
 * Words that carry no meaning in a file name.
 *
 * A request is a sentence, and naming a class after the whole sentence
 * produces `AddRetryLogicToTheVisitsClientService.java` — a name no developer
 * would write, proposed with the confidence of a real one. Dropping the verb
 * and the grammar leaves the nouns the feature is actually about.
 */
const NAMING_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "into",
  "with",
  "and",
  "or",
  "add",
  "adds",
  "added",
  "create",
  "creates",
  "make",
  "update",
  "change",
  "support",
  "implement",
  "new",
  "some",
  "please",
  "logic",
  "feature"
]);

/** Longer than this and it is a sentence, not a name. */
const MAX_NAME_WORDS = 3;

/**
 * The meaningful words in a request, for naming a file after it.
 *
 * Falls back to the raw slug when stripping leaves nothing — a request made
 * entirely of stopwords is unusual, and an empty name would be worse than a
 * clumsy one.
 */
function nameWordsFromRequest(request: string): string[] {
  const words = slugFromRequest(request)
    .split("-")
    .filter((word) => word.length > 1 && !NAMING_STOPWORDS.has(word));

  const kept = words.length > 0 ? words : slugFromRequest(request).split("-");
  return kept.filter(Boolean).slice(0, MAX_NAME_WORDS);
}

/**
 * A folder to put a proposed new file of this type in.
 *
 * Grounded rather than guessed. `impactedModules` is ranked by search hits,
 * so its top entry is whatever matched the words of the request — which on a
 * real repository put a `.java` file under `src/test/java`, then under
 * `db/mysql`, then under `scripts/chaos`. None of those hold Java.
 *
 * So the folder has to already contain files of the same kind. The index
 * knows where those are, and preferring the highest-ranked module that
 * qualifies keeps the proposal near the code the request is about.
 */
function folderForExtension(
  repo: RepoMap,
  impactedModules: string[],
  searchResults: SearchResult[],
  extension: string,
  nameWords: string[]
): string | undefined {
  const looksLikeTests = (folder: string): boolean =>
    /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(folder);

  // Two sources of evidence, because one is not enough. Search results are
  // scoped to the request, so a repository can hold plenty of Java and return
  // none of it for a feature described in words none of those files use —
  // which is how this first proposed nothing at all for a polyglot repo.
  // Entry points are repo-wide and carry real paths, so they answer "where
  // does this language live" independently of what was asked.
  const evidence = [
    ...searchResults.map((result) => result.relativePath),
    ...(repo.entryPoints ?? []).map((entry) => entry.filePath)
  ];

  const folders = new Set(
    evidence
      .filter((file) => file.endsWith(extension))
      .map((file) => path.dirname(file))
      .filter((folder) => folder !== "." && !looksLikeTests(folder))
  );

  if (folders.size === 0) {
    return undefined;
  }

  // Among folders that qualify, prefer one the request actually names. Search
  // ranking alone put a change to the "customers service" in `genai-service`
  // simply because that module's files scored highest overall; a module whose
  // path carries a word from the request is the better guess, and is still
  // evidence rather than invention.
  const candidates = impactedModules.filter((folder) => folders.has(folder));
  const named = candidates.find((folder) =>
    nameWords.some((word) => folder.toLowerCase().includes(word))
  );

  return named ?? candidates[0] ?? [...folders][0];
}

function inferLikelyNewFiles(
  repo: RepoMap,
  request: string,
  impactedModules: string[],
  searchResults: SearchResult[]
): string[] {
  const words = nameWordsFromRequest(request);
  const slug = words.join("-");
  const frameworks = new Set(repo.frameworks.map((framework) => framework.name));
  const languages = new Set(repo.languages.map((language) => language.name));
  const files: string[] = [];

  // Proposed only where the repository already has somewhere to put it. A
  // suggestion with nowhere real to live is one the developer has to notice
  // and discard, which costs more than making no suggestion at all.
  const folderFor = (extension: string): string | undefined =>
    folderForExtension(repo, impactedModules, searchResults, extension, words);

  const reactFolder = frameworks.has("React") ? folderFor(".tsx") : undefined;
  if (reactFolder) {
    files.push(`${reactFolder}/${slug}.tsx`, `${reactFolder}/${slug}.test.tsx`);
  }

  const angularFolder = frameworks.has("Angular") ? folderFor(".ts") : undefined;
  if (angularFolder) {
    files.push(
      `${angularFolder}/${slug}.service.ts`,
      `${angularFolder}/${slug}.service.spec.ts`
    );
  }

  const pythonFolder = languages.has("Python") ? folderFor(".py") : undefined;
  if (pythonFolder) {
    files.push(
      `${pythonFolder}/${slug.replaceAll("-", "_")}.py`,
      `tests/test_${slug.replaceAll("-", "_")}.py`
    );
  }

  const javaFolder = languages.has("Java") ? folderFor(".java") : undefined;
  if (javaFolder) {
    files.push(`${javaFolder}/${pascalCase(slug)}Service.java`);
  }

  const goFolder = languages.has("Go") ? folderFor(".go") : undefined;
  if (goFolder) {
    files.push(`${goFolder}/${slug.replaceAll("-", "_")}.go`);
  }

  // No fallback path. Inventing `<some folder>/<the request>` was how a plan
  // proposed a file with neither a real name nor a real home; saying nothing
  // is the honest answer when the repository gives no evidence.
  return unique(files).slice(0, 8);
}

function inferImpactedModules(searchResults: SearchResult[], repo: RepoMap): string[] {
  const folders = searchResults
    .filter((result) => !result.isDocFile)
    .map((result) => path.dirname(result.relativePath))
    .filter((folder) => folder !== ".");

  return unique([
    ...folders,
    ...repo.projects.flatMap((project) => project.sourceFolders)
  ]).slice(0, 10);
}

function toRelevantFile(
  result: SearchResult,
  requestEntities: string[],
  citations: Map<string, GraphCitation[]>
): PlanFileReference {
  return {
    filePath: result.relativePath,
    score: result.score,
    reason: describeRelevance(result, requestEntities, citations)
  };
}

interface GraphCitation {
  phrase: string;
  otherFile: string;
}

const EDGE_CITATION_PHRASES: Record<
  SymbolEdgeKind,
  { outgoing: string; incoming: string }
> = {
  imports: { outgoing: "imports", incoming: "is imported by" },
  calls: { outgoing: "calls into", incoming: "is called by" },
  extends: { outgoing: "extends", incoming: "is extended by" },
  implements: { outgoing: "implements", incoming: "is implemented by" }
};

/**
 * File-level "why relevant" citations from the symbol/dependency graph
 * (see docs/CODEBASE_INTELLIGENCE_DESIGN.md section 4). Only edges where
 * both endpoints are already in this plan's candidate file set become
 * citations — a graph edge to some unrelated file elsewhere in the repo
 * doesn't answer "why does this matter to this plan".
 */
function buildGraphCitations(
  graph: SymbolGraph | undefined,
  candidateFiles: Set<string>
): Map<string, GraphCitation[]> {
  const citations = new Map<string, GraphCitation[]>();

  if (!graph) {
    return citations;
  }

  const fileById = new Map(graph.nodes.map((node) => [node.id, node.filePath]));
  const seenKeys = new Map<string, Set<string>>();

  const add = (file: string, citation: GraphCitation): void => {
    const key = `${citation.phrase}|${citation.otherFile}`;
    const seen = seenKeys.get(file) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    seenKeys.set(file, seen);

    const list = citations.get(file) ?? [];
    list.push(citation);
    citations.set(file, list);
  };

  for (const edge of graph.edges) {
    const fromFile = fileById.get(edge.from);
    const toFile = fileById.get(edge.to);

    if (!fromFile || !toFile || fromFile === toFile) continue;
    if (!candidateFiles.has(fromFile) || !candidateFiles.has(toFile)) continue;

    const phrase = EDGE_CITATION_PHRASES[edge.kind];
    add(fromFile, { phrase: phrase.outgoing, otherFile: toFile });
    add(toFile, { phrase: phrase.incoming, otherFile: fromFile });
  }

  return citations;
}

function describeRelevance(
  result: SearchResult,
  requestEntities: string[],
  citations: Map<string, GraphCitation[]>
): string {
  const parts: string[] = [];
  const matchedEntities = requestEntities.filter(
    (entity) =>
      result.relativePath.toLowerCase().includes(entity) ||
      result.symbols.some((symbol) => symbol.name.toLowerCase().includes(entity)) ||
      result.textPreview.toLowerCase().includes(entity)
  );

  if (matchedEntities.length > 0) {
    parts.push(`matches entity term(s) ${matchedEntities.join(", ")}`);
  } else if (result.matchedFields.length > 0) {
    parts.push(`matched ${result.matchedFields.join(", ")} in local index search`);
  }

  for (const citation of (citations.get(result.relativePath) ?? []).slice(0, 2)) {
    parts.push(`${citation.phrase} \`${citation.otherFile}\``);
  }

  if (result.signals.includes("recency")) {
    parts.push("recently/frequently changed");
  }

  return parts.length > 0 ? `${parts.join("; ")}.` : "Matched in local index search.";
}

function createPlanArtifactPaths(repoRoot: string, id: string): PlanArtifactPaths {
  const plansRoot = getArtifactDirectoryPath(repoRoot, "plans");

  return {
    timestampJsonPath: path.join(plansRoot, `${id}-plan.json`),
    timestampMarkdownPath: path.join(plansRoot, `${id}-plan.md`),
    latestJsonPath: path.join(plansRoot, "latest-plan.json"),
    latestMarkdownPath: path.join(plansRoot, "latest-plan.md")
  };
}

function createPlanDraftPaths(
  repoRoot: string,
  planId: string,
  revision: number
): PlanDraftArtifactPaths {
  const plansRoot = getArtifactDirectoryPath(repoRoot, "plans");
  const draftDir = path.join(plansRoot, "drafts", planId);

  return {
    draftJsonPath: path.join(draftDir, `rev-${revision}.json`),
    draftMarkdownPath: path.join(draftDir, `rev-${revision}.md`),
    latestJsonPath: path.join(plansRoot, "latest-plan.json"),
    latestMarkdownPath: path.join(plansRoot, "latest-plan.md")
  };
}

async function findLatestDraftPlanId(repoRoot: string): Promise<string | undefined> {
  const latestPath = path.join(
    getArtifactDirectoryPath(repoRoot, "plans"),
    "latest-plan.json"
  );
  const plan = await readOptionalJson<FeaturePlanArtifact>(latestPath);

  return plan?.id;
}

function createApprovedPlanPath(
  repoRoot: string,
  planId: string,
  revision: number
): string {
  const plansRoot = getArtifactDirectoryPath(repoRoot, "plans");

  return path.join(plansRoot, "approved", `${planId}-rev${revision}-plan.json`);
}

async function listDraftRevisionNumbers(
  repoRoot: string,
  planId: string
): Promise<number[]> {
  const draftDir = path.join(
    getArtifactDirectoryPath(repoRoot, "plans"),
    "drafts",
    planId
  );
  let entries: string[];

  try {
    entries = await readdir(draftDir);
  } catch {
    throw new Error(
      `No draft plan found for id "${planId}". Call generate_feature_plan first.`
    );
  }

  const revisionNumbers = entries
    .map((name) => /^rev-(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);

  if (revisionNumbers.length === 0) {
    throw new Error(`No draft revisions found for plan "${planId}".`);
  }

  return revisionNumbers;
}

async function loadLatestDraftRevision(
  repoRoot: string,
  planId: string
): Promise<FeaturePlanArtifact> {
  const revisionNumbers = await listDraftRevisionNumbers(repoRoot, planId);
  const latestRevision = revisionNumbers[revisionNumbers.length - 1];

  return readJsonFile<FeaturePlanArtifact>(
    createPlanDraftPaths(repoRoot, planId, latestRevision).draftJsonPath
  );
}

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}

function titleFromRequest(request: string): string {
  const trimmed = request.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function slugFromRequest(request: string): string {
  return request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function flattenStackSpecificPlan(plan: StackSpecificPlan): string[] {
  return [
    ...plan.react,
    ...plan.angular,
    ...plan.python,
    ...plan.java,
    ...plan.generic
  ];
}

function summarizePlanningContext(context: PlanningContext): PlanningContextSummary {
  return {
    workspaceRepoRoots: context.workspaceConfig?.repoRoots ?? [],
    customCommandCount: context.customCommands.length,
    customCommandNames: context.customCommands.map(
      (customCommand) => customCommand.command.name
    ),
    instructionFiles: context.instructionFiles
  };
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch {
    return undefined;
  }
}

async function findInstructionFiles(repoRoot: string): Promise<string[]> {
  const candidates = [
    ".github/copilot-instructions.md",
    "copilot-instructions.md",
    "AGENTS.md",
    ".copilot-architect/instructions/copilot-instructions.md",
    ".copilot-architect/instructions/AGENTS.md"
  ];
  const found: string[] = [];

  for (const relativePath of candidates) {
    if (await pathExists(path.join(repoRoot, relativePath))) {
      found.push(relativePath);
    }
  }

  return found;
}

function resolveRepoLocalPath(
  repoRoot: string,
  filePath: string | undefined
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return resolved;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isLikelyTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("test_")
  );
}

function pascalCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean);
}
