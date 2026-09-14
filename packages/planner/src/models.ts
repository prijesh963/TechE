import type {
  AdvancedAnalysis,
  AdvancedRiskScore,
  DetectedCommand,
  FeaturePlan,
  PlanQualityScore,
  PlanStatus,
  RepoReadinessDiagnostic,
  ValidationCommand
} from "@copilot-architect/shared";
import type { WorkspaceRepoDescriptor } from "@copilot-architect/core";
import type { QueryIntentLabel } from "@copilot-architect/intent";

import type { SearchResult, WorkspaceSearchResult } from "@copilot-architect/indexer";

export interface FeaturePlanningOptions {
  request: string;
  startPath?: string;
  strictRoot?: boolean;
  searchLimit?: number;
}

export interface FeaturePlanningResult {
  repoRoot: string;
  plan: FeaturePlanArtifact;
  markdown: string;
  jsonPath: string;
  markdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  searchResults: SearchResult[];
}

export interface FeaturePlanPreviewResult {
  repoRoot: string;
  plan: FeaturePlanArtifact;
  markdown: string;
  searchResults: SearchResult[];
}

export interface FeaturePlanArtifact extends FeaturePlan {
  requestInterpretation: string;
  /** Classified via @copilot-architect/intent's classifyIntent(request). */
  requestIntent: QueryIntentLabel;
  /** Extracted via @copilot-architect/intent's extractEntities(request); also
   *  what refined the search query behind relevantFiles/similarFeatureCandidates. */
  requestEntities: string[];
  repoArchitectureSummary: string;
  planningContext: PlanningContextSummary;
  relevantFiles: PlanFileReference[];
  similarFeatureCandidates: PlanFileReference[];
  impactedLanguages: string[];
  impactedFrameworks: string[];
  impactedModules: string[];
  likelyFilesToModify: string[];
  likelyNewFiles: string[];
  frontendImpact: string[];
  backendImpact: string[];
  dataConfigImpact: string[];
  securityConsiderations: string[];
  performanceConsiderations: string[];
  testStrategy: string[];
  openQuestions: string[];
  humanApprovalCheckpoint: string;
  stackSpecificPlan: StackSpecificPlan;
  advancedAnalysis: AdvancedAnalysis;
  riskScores: AdvancedRiskScore[];
  planQuality: PlanQualityScore;
  readinessDiagnostics: RepoReadinessDiagnostic[];
  relatedEndpoints: PlanEndpointReference[];
  multiRepo?: WorkspacePlanSummary;
  /** 1 for the initial save; incremented by every `revise_feature_plan` call. */
  revision: number;
  /** Artifact id of the revision this one replaces. Absent on revision 1. */
  supersedes?: string;
  /** Full history of revisions, oldest first, including the initial save. */
  revisions: PlanRevisionEntry[];
  /** Present only once `approve_plan` has stamped this exact revision. */
  approval?: PlanApproval;
}

export interface PlanApproval {
  approvedAt: string;
  approvedBy: string;
  revision: number;
  note?: string;
}

export interface PlanApprovalOptions {
  startPath?: string;
  strictRoot?: boolean;
  /** Defaults to the id of the latest saved plan. */
  planId?: string;
  /** Required — approval is always per-revision, never "whatever is newest". */
  revision: number;
  approvedBy: string;
  note?: string;
}

export interface PlanRevisionSummary {
  revision: number;
  status: PlanStatus;
  at: string;
  source: PlanRevisionEntry["source"];
  approval?: PlanApproval;
}

export interface PlanRevisionEntry {
  revision: number;
  at: string;
  source: "initial" | "human-feedback" | "code-review";
  /** Verbatim feedback text — never summarised, so it survives re-reading later. */
  feedback: string;
  changedSections: string[];
  reviewFindingIds?: string[];
}

/**
 * Shallow, partial overrides accepted by `revisePlan`. Restricted to the
 * plan's editable content — identity/schema/status fields are never
 * settable through a revision.
 */
export type PlanSectionOverrides = Partial<
  Pick<
    FeaturePlanArtifact,
    | "title"
    | "summary"
    | "requestInterpretation"
    | "assumptions"
    | "implementationSteps"
    | "impactAnalysis"
    | "validationPlan"
    | "likelyFilesToModify"
    | "likelyNewFiles"
    | "frontendImpact"
    | "backendImpact"
    | "dataConfigImpact"
    | "securityConsiderations"
    | "performanceConsiderations"
    | "testStrategy"
    | "openQuestions"
    | "stackSpecificPlan"
    | "relatedEndpoints"
  >
>;

export interface PlanRevisionOptions {
  startPath?: string;
  strictRoot?: boolean;
  /** Defaults to the id of the latest saved plan. */
  planId?: string;
  feedback: string;
  sections?: PlanSectionOverrides;
  source?: "human-feedback" | "code-review";
  reviewFindingIds?: string[];
}

export interface PlanDraftArtifactPaths {
  draftJsonPath: string;
  draftMarkdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
}

export interface PlanEndpointReference {
  method: string;
  routePath: string;
  filePath: string;
  line?: number;
  testFile?: string;
}

export interface PlanFileReference {
  filePath: string;
  reason: string;
  score?: number;
}

export interface StackSpecificPlan {
  react: string[];
  angular: string[];
  python: string[];
  java: string[];
  /**
   * Guidance derived from detected integrations (datastores, brokers,
   * micro-frontend and microservice platforms). Composed per detection rather
   * than per stack combination, so "Java + Oracle + Kafka" produces Java,
   * Oracle and Kafka guidance without a combination-specific branch.
   */
  integrations: string[];
  generic: string[];
}

export interface PlanningContextSummary {
  workspaceRepoRoots: string[];
  customCommandCount: number;
  customCommandNames: string[];
  instructionFiles: string[];
}

export interface PlanArtifactPaths {
  timestampJsonPath: string;
  timestampMarkdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
}

export interface ValidationCommandCandidate {
  command: ValidationCommand;
  label: string;
}

export type WorkspacePlanningOptions = FeaturePlanningOptions;

export interface WorkspaceImpactResult {
  request: string;
  workspaceName?: string;
  workspaceRoot: string;
  repos: WorkspaceRepoDescriptor[];
  impactedRepos: WorkspaceImpactedRepo[];
  perRepoValidationPlans: WorkspaceRepoValidationPlan[];
}

export interface WorkspaceImpactedRepo {
  name: string;
  role?: string;
  repoRoot: string;
  resultCount: number;
  topScore: number;
  topFiles: string[];
}

export interface WorkspaceRepoValidationPlan {
  repoName: string;
  repoRole?: string;
  repoRoot: string;
  commands: DetectedCommand[];
  strategy: string;
}

export interface WorkspacePlanSummary extends WorkspaceImpactResult {
  searchResults: WorkspaceSearchResult[];
}

export interface WorkspacePlanningResult extends FeaturePlanningResult {
  multiRepo: WorkspacePlanSummary;
}

export interface WorkspacePlanPreviewResult extends FeaturePlanPreviewResult {
  multiRepo: WorkspacePlanSummary;
}
