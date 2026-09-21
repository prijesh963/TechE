import type { JsonObject, JsonValue } from "./json.js";

export type ConfidenceLevel = "low" | "medium" | "high";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type ValidationStatus =
  "not-run" | "passed" | "failed" | "blocked" | "timed-out" | "skipped";

export type PlanStatus = "draft" | "approved" | "in-progress" | "completed";

export type Severity = "info" | "warning" | "error";

export interface SchemaBacked {
  schemaVersion: string;
}

export interface TrustMetadata extends SchemaBacked {
  generatedAt: string;
  generatedBy: string;
  policyId: string;
  localOnly: boolean;
  telemetryEnabled: boolean;
  artifactKind?: string;
  source?: string;
}

export interface GeneratedArtifact extends SchemaBacked {
  generatedAt: string;
  trust?: TrustMetadata;
}

export interface RepoContext extends GeneratedArtifact {
  repoRoot: string;
  displayName: string;
  relativePath?: string;
  vcs: "git" | "none" | "unknown";
  artifactRoot: string;
  projects: ProjectMap[];
  languages: LanguageInfo[];
  frameworks: FrameworkInfo[];
  packageManagers: PackageManagerInfo[];
  adapters: string[];
  diagnostics: DiagnosticMessage[];
}

export interface WorkspaceContext extends GeneratedArtifact {
  workspaceRoot: string;
  artifactRoot: string;
  repos: RepoContext[];
  config?: WorkspaceConfig;
}

export interface UniversalRepoMap extends GeneratedArtifact {
  workspaceRoot: string;
  repos: RepoMap[];
  summary: ArchitectureSummary;
}

export interface RepoMap extends GeneratedArtifact {
  repoRoot: string;
  displayName: string;
  projects: ProjectMap[];
  languages: LanguageInfo[];
  frameworks: FrameworkInfo[];
  packageManagers: PackageManagerInfo[];
  commands: RepoCommandSet;
  entryPoints: EntryPoint[];
  featurePatterns: FeaturePattern[];
  documentationFiles: string[];
  architecturalPatterns: string[];
  /** Datastores, message brokers, micro-frontend and microservice platforms. */
  integrations: IntegrationInfo[];
  diagnostics: DiagnosticMessage[];
}

export interface ProjectMap {
  id: string;
  name: string;
  rootPath: string;
  sourceFolders: string[];
  testFolders: string[];
  configFiles: string[];
  languages: LanguageInfo[];
  frameworks: FrameworkInfo[];
  packageManagers: PackageManagerInfo[];
  entryPoints: EntryPoint[];
  architecturalPatterns: string[];
}

export interface LanguageInfo {
  name: string;
  fileExtensions: string[];
  confidence: ConfidenceLevel;
  source: string;
}

export interface FrameworkInfo {
  name: string;
  version?: string;
  ecosystem: string;
  confidence: ConfidenceLevel;
  evidence: string[];
}

/**
 * External systems and architectural styles a repo integrates with, detected
 * independently of its language and framework. Kept as a separate axis on
 * purpose: "Java + Oracle + Kafka" is not a special case to hard-code, it is
 * the Java adapter plus two integrations, so arbitrary combinations compose
 * without adding a detector per combination.
 */
export type IntegrationCategory =
  | "datastore"
  | "messaging"
  | "micro-frontend"
  | "microservice"
  | "orchestration"
  | "monorepo-tooling"
  | "test-automation";

export interface IntegrationInfo {
  /** e.g. "Oracle", "MongoDB", "Kafka", "IBM MQ", "Module Federation". */
  name: string;
  category: IntegrationCategory;
  /** Which stack the evidence came from: "java", "node", "python", or "any". */
  ecosystem: string;
  confidence: ConfidenceLevel;
  /** File paths the signal was found in, most specific first. */
  evidence: string[];
}

export interface PackageManagerInfo {
  name: string;
  lockfile?: string;
  manifest?: string;
  confidence: ConfidenceLevel;
}

export interface RepoCommandSet {
  build: BuildCommand[];
  test: TestCommand[];
  lint: LintCommand[];
  format: FormatCommand[];
  validation: ValidationCommand[];
}

export interface DetectedCommand {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  description?: string;
  confidence: ConfidenceLevel;
  source: string;
}

export interface BuildCommand extends DetectedCommand {
  kind: "build";
}

export interface TestCommand extends DetectedCommand {
  kind: "test";
}

export interface LintCommand extends DetectedCommand {
  kind: "lint";
}

export interface FormatCommand extends DetectedCommand {
  kind: "format";
}

export interface ValidationCommand extends DetectedCommand {
  kind: "validation";
  timeoutMs?: number;
  retryCount?: number;
  required: boolean;
  risk?: CommandRiskAssessment;
}

export interface CodeSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  containerName?: string;
}

export interface EntryPoint {
  name: string;
  kind: "application" | "library" | "test" | "script" | "service" | "unknown";
  filePath: string;
  command?: string;
  confidence: ConfidenceLevel;
}

export interface FeaturePattern {
  id: string;
  name: string;
  summary: string;
  files: string[];
  symbols: CodeSymbol[];
  tags: string[];
  confidence: ConfidenceLevel;
}

export interface ImpactAnalysis {
  summary: string;
  affectedProjects: string[];
  affectedFiles: string[];
  affectedCommands: string[];
  risks: RiskItem[];
  testGaps: string[];
}

export interface AdvancedAnalysis extends GeneratedArtifact {
  repoRoot: string;
  summary: string;
  architecturePatterns: AdvancedArchitecturePattern[];
  dependencyManifests: DependencyManifest[];
  routes: RouteApiEndpoint[];
  testRelationships: TestRelationship[];
  riskScores: AdvancedRiskScore[];
  diagnostics: RepoReadinessDiagnostic[];
  /** Recency/frequency signal from git history. Empty when the repo has no
   *  `.git` directory, git is unavailable, or the history is empty. */
  gitActivity: FileChangeActivity[];
  /** A call site or message producer in one registered repo that matches a
   *  route or consumer detected in a different one — only meaningful in a
   *  multi-repo workspace, always empty for a single repo. */
  interlinks: CrossRepoInterlink[];
}

/**
 * A connection between two registered repos inferred from matching evidence
 * on each side, with no runtime confirmation — a path/method collision for
 * `"http-route"`, a broker/channel-name collision for `"messaging"`. Both can
 * miss a real connection built dynamically (a variable base URL, a topic
 * name from a constant) and can both surface a coincidental match between
 * two repos that do not actually talk to each other.
 *
 * Field meaning depends on `kind`:
 * - `"http-route"`: a caller in one repo (an HTTP client call, an OpenFeign
 *   client method) whose literal path matches a route exposed by another —
 *   `method` is the HTTP method, `path` is the route path. Confidence
 *   reflects HTTP-method agreement.
 * - `"messaging"`: a producer in one repo publishing to a topic/queue a
 *   consumer in another listens on — `method` is the broker
 *   (`"kafka"`/`"rabbitmq"`/`"jms"`), `path` is the channel name. Confidence
 *   is always `"high"`: unlike HTTP there is no second discriminator like a
 *   verb to lower it against.
 */
export interface CrossRepoInterlink {
  kind: "http-route" | "messaging";
  method: string;
  path: string;
  fromRepo: string;
  fromFile: string;
  fromLine?: number;
  toRepo: string;
  toFile: string;
  toLine?: number;
  confidence: ConfidenceLevel;
}

export interface FileChangeActivity {
  filePath: string;
  /** Commits touching this file within the lookback window. */
  commitCount: number;
  /** ISO timestamp of the most recent commit touching it. */
  lastChangedAt: string;
  lastChangedDaysAgo: number;
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface AdvancedArchitecturePattern {
  name:
    | "React app"
    | "Angular app"
    | "Node API"
    | "Python service"
    | "Java Spring service"
    | "monorepo"
    | "library/package"
    | "CLI app";
  confidence: ConfidenceLevel;
  evidence: string[];
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface DependencyManifest {
  filePath: string;
  ecosystem: "javascript" | "python" | "java";
  packageManager?: string;
  changed: boolean;
  evidence: string[];
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface RouteApiEndpoint {
  kind:
    | "express"
    | "fastapi"
    | "flask"
    | "django"
    | "spring"
    | "angular"
    | "react"
    | "next";
  method: string;
  routePath: string;
  filePath: string;
  line?: number;
  handler?: string;
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface TestRelationship {
  kind: "component" | "service" | "api-route";
  sourceFile: string;
  testFile?: string;
  routePath?: string;
  confidence: ConfidenceLevel;
  reason: string;
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface AdvancedRiskScore {
  category:
    "security" | "data-migration" | "dependency" | "multi-repo-impact" | "missing-test";
  level: Exclude<RiskLevel, "blocked">;
  score: number;
  reasons: string[];
  mitigation?: string;
  /** Which registered repo this came from, in a multi-repo workspace. */
  repoName?: string;
}

export interface PlanQualityScore {
  score: number;
  level: Exclude<RiskLevel, "blocked">;
  checks: PlanQualityCheck[];
  warnings: string[];
}

export interface PlanQualityCheck {
  name:
    | "context"
    | "impacted-files"
    | "validation-commands"
    | "assumptions"
    | "advanced-analysis";
  passed: boolean;
  score: number;
  details: string;
}

export interface RepoReadinessDiagnostic {
  code:
    | "MISSING_PACKAGE_MANAGER"
    | "MISSING_BUILD_SCRIPT"
    | "MISSING_TESTS"
    | "MISSING_REPO_MAP"
    | "STALE_INDEX"
    | "READY";
  severity: Severity;
  message: string;
  recommendation?: string;
  filePath?: string;
  /** Which registered repo this came from, in a multi-repo workspace. Absent
   *  for workspace-wide diagnostics (`MISSING_REPO_MAP`, `STALE_INDEX`). */
  repoName?: string;
}

export interface FeaturePlan extends GeneratedArtifact {
  id: string;
  title: string;
  task: string;
  status: PlanStatus;
  repoRoot: string;
  summary: string;
  assumptions: string[];
  implementationSteps: PlanStep[];
  impactAnalysis: ImpactAnalysis;
  validationPlan: ValidationPlan;
  requiresHumanApproval: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  details: string;
  files: string[];
  dependsOn: string[];
}

export interface ValidationPlan extends SchemaBacked {
  commands: ValidationCommand[];
  strategy: string;
  requiredEvidence: string[];
}

export interface ValidationResult extends GeneratedArtifact {
  id: string;
  command: ValidationCommand;
  status: ValidationStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  outputSummary: string;
  logPath?: string;
  failureClassification?: string;
}

export interface ReviewReport extends GeneratedArtifact {
  id: string;
  planId?: string;
  repoRoot: string;
  summary: string;
  diffSummary: string;
  findings: ReviewFinding[];
  missingTests: string[];
  validationResults: ValidationResult[];
  risks: RiskItem[];
  reviewerPrompt?: string;
}

export interface ReviewFinding {
  /** Stable across runs: a hash of severity + title + filePath, excluding line/details. */
  id: string;
  severity: Severity;
  title: string;
  filePath?: string;
  line?: number;
  details: string;
  status: "open" | "accepted" | "declined" | "resolved";
  disposition?: FindingDisposition;
}

export interface FindingDisposition {
  decidedAt: string;
  decidedBy: string;
  /** Required for both accept and decline — this is the audit trail. */
  reason: string;
  /** Set when accepted and folded into a new plan revision. */
  planRevision?: number;
}

export interface SafetyPolicy extends GeneratedArtifact {
  id: string;
  name: string;
  defaultAllow: boolean;
  blockedPatterns: string[];
  allowedPatterns: string[];
  secretRedactionPatterns: string[];
  requireApprovalForHandoff: boolean;
  workspaceBoundaryRequired: boolean;
  requiredApprovalGates: RequiredApprovalGate[];
  telemetryEnabled: boolean;
  localFirst: boolean;
  artifactRetention: ArtifactRetentionPolicy;
  trustMetadata: TrustMetadata;
}

export type RequiredApprovalGate =
  "planning" | "handoff" | "validation-risk" | "agent-install" | "policy-change";

export interface ArtifactRetentionPolicy {
  enabled: boolean;
  maxAgeDays: number;
  maxRuns: number;
  directories: string[];
  dryRunDefault: boolean;
}

export interface CommandRiskAssessment extends GeneratedArtifact {
  command: string;
  allowed: boolean;
  riskLevel: RiskLevel;
  reasons: string[];
  matchedRules: string[];
  requiresHumanApproval: boolean;
}

export interface AuditLogEntry extends SchemaBacked {
  id: string;
  timestamp: string;
  action: string;
  actor: "user" | "cli" | "mcp" | "agent" | "system";
  target?: string;
  summary: string;
  metadata: JsonObject;
  redactionsApplied: string[];
}

export interface HandoffPrompt extends GeneratedArtifact {
  id: string;
  planId: string;
  targetAgent: "copilot" | "codex" | "claude-code" | "generic";
  approved: boolean;
  promptMarkdown: string;
  expectedFiles: string[];
  validationCommands: ValidationCommand[];
  safetyNotes: string[];
}

export interface AgentTemplate extends GeneratedArtifact {
  id: string;
  name: string;
  description: string;
  target: "copilot" | "codex" | "claude-code" | "generic";
  instructionsMarkdown: string;
  tools: string[];
  metadata: JsonObject;
}

export interface AgentInstallResult extends GeneratedArtifact {
  agentId: string;
  status: "installed" | "updated" | "skipped" | "failed";
  installPath?: string;
  backupPath?: string;
  messages: string[];
}

export interface InstructionGenerationResult extends GeneratedArtifact {
  target: "copilot-instructions" | "agents-md" | "skill";
  status: "generated" | "updated" | "skipped" | "failed";
  outputPath?: string;
  backupPath?: string;
  messages: string[];
}

export interface McpToolResult extends SchemaBacked {
  toolName: string;
  ok: boolean;
  data?: JsonValue;
  error?: string;
  diagnostics: DiagnosticMessage[];
}

export interface WorkspaceConfig extends SchemaBacked {
  workspaceName?: string;
  workspaceRoot: string;
  repos?: WorkspaceRepoConfig[];
  repoRoots: string[];
  artifactRoot: string;
  customCommandsPath?: string;
  policyPath?: string;
}

export interface WorkspaceRepoConfig {
  name: string;
  path: string;
  role?: string;
}

export interface CustomCommandConfig extends SchemaBacked {
  commands: ValidationCommand[];
  defaults: {
    timeoutMs: number;
    retryCount: number;
  };
}

export interface EnterprisePolicy extends SchemaBacked {
  enabled: boolean;
  policyName: string;
  requiredApprovals: string[];
  blockedFilePatterns: string[];
  allowedArtifactRoots: string[];
  notes: string[];
}

export interface DiagnosticReport extends GeneratedArtifact {
  id: string;
  status: "ok" | "warning" | "error";
  summary: string;
  environment: {
    nodeVersion: string;
    packageManager: "npm" | "pnpm" | "yarn" | "unknown";
    platform: string;
  };
  checks: DiagnosticCheck[];
  artifactRoot: string;
}

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DiagnosticMessage {
  severity: Severity;
  code: string;
  message: string;
  filePath?: string;
}

export interface RiskItem {
  severity: RiskLevel;
  title: string;
  details: string;
  mitigation?: string;
}

export interface ArchitectureSummary {
  summary: string;
  primaryLanguages: string[];
  primaryFrameworks: string[];
  projectCount: number;
  repoCount: number;
}
