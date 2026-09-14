import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AdvancedAnalysisService, RepoDiscoveryService } from "@copilot-architect/core";
import { IndexingService, type SearchResult } from "@copilot-architect/indexer";
import {
  CURRENT_SCHEMA_VERSION,
  type AdvancedAnalysis,
  type AdvancedRiskScore,
  type DetectedCommand,
  type FeaturePlan,
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
  PlanArtifactPaths,
  PlanDraftArtifactPaths,
  PlanEndpointReference,
  PlanFileReference,
  PlanningContextSummary,
  PlanRevisionEntry,
  PlanRevisionOptions,
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
    const searchResponse = await indexer.findSimilarFeatures({
      startPath: repoRoot,
      strictRoot: options.strictRoot,
      query: request,
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
    const plan = buildPlan(
      request,
      repoMap,
      repo,
      searchResponse.results,
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
  repoMap: UniversalRepoMap,
  repo: RepoMap,
  searchResults: SearchResult[],
  planningContext: PlanningContext,
  advancedAnalysis: AdvancedAnalysis
): FeaturePlanArtifact {
  const id = timestampId();
  const title = titleFromRequest(request);
  const relevantFiles = searchResults.slice(0, 8).map(toRelevantFile);
  const similarFeatureCandidates = searchResults
    .filter((result) => !result.isConfigFile)
    .slice(0, 6)
    .map((result) => ({
      filePath: result.relativePath,
      score: result.score,
      reason: `Matched ${result.matchedFields.join(", ")} for the feature request.`
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
  const likelyNewFiles = inferLikelyNewFiles(repo, request, impactedModules);
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
    generic: [
      "Follow nearby naming, folder, and test conventions.",
      "Prefer extending existing modules over creating new architecture.",
      "Keep implementation handoff blocked until this plan is approved."
    ]
  };
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

function inferLikelyNewFiles(
  repo: RepoMap,
  request: string,
  impactedModules: string[]
): string[] {
  const slug = slugFromRequest(request);
  const baseFolder = impactedModules[0] ?? repo.projects[0]?.sourceFolders[0] ?? "src";
  const frameworks = new Set(repo.frameworks.map((framework) => framework.name));
  const languages = new Set(repo.languages.map((language) => language.name));
  const files: string[] = [];

  if (frameworks.has("React")) {
    files.push(`${baseFolder}/${slug}.tsx`, `${baseFolder}/${slug}.test.tsx`);
  }

  if (frameworks.has("Angular")) {
    files.push(
      `${baseFolder}/${slug}.service.ts`,
      `${baseFolder}/${slug}.service.spec.ts`
    );
  }

  if (languages.has("Python")) {
    files.push(
      `${baseFolder}/${slug}.py`,
      `tests/test_${slug.replaceAll("-", "_")}.py`
    );
  }

  if (languages.has("Java")) {
    files.push(`${baseFolder}/${pascalCase(slug)}Service.java`);
  }

  if (files.length === 0) {
    files.push(`${baseFolder}/${slug}`);
  }

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

function toRelevantFile(result: SearchResult): PlanFileReference {
  return {
    filePath: result.relativePath,
    score: result.score,
    reason: `Matched ${result.matchedFields.join(", ")} in local index search.`
  };
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

async function loadLatestDraftRevision(
  repoRoot: string,
  planId: string
): Promise<FeaturePlanArtifact> {
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
    .sort((left, right) => right - left);
  const latestRevision = revisionNumbers[0];

  if (latestRevision === undefined) {
    throw new Error(`No draft revisions found for plan "${planId}".`);
  }

  return readJsonFile<FeaturePlanArtifact>(
    path.join(draftDir, `rev-${latestRevision}.json`)
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
