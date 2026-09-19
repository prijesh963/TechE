import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CHAT_COMMANDS,
  CURRENT_SCHEMA_VERSION,
  type FeaturePlan,
  type FindingDisposition,
  type ReviewFinding,
  type ReviewReport,
  type RiskItem,
  type ValidationResult,
  getArtifactDirectoryPath,
  readJsonFile,
  writeJsonFile
} from "@copilot-architect/shared";

const execFileAsync = promisify(execFile);

export interface ReviewServiceOptions {
  startPath?: string;
  plan?: string;
  validation?: string;
  /**
   * Repo-relative paths the change was expected to touch, supplied directly.
   *
   * Without this, expectations can only be read from a `FeaturePlan` on disk,
   * which the session's `PlanContract` is not — so a review driven from
   * `@architect` had no expectations at all and reported every changed file
   * as unexpected. Given here, the review works from either plan format.
   */
  expectedFiles?: string[];
}

export interface ResolveReviewFindingOptions {
  startPath?: string;
  findingId: string;
  decision: "accept" | "decline";
  /** Required for both decisions — this is the audit trail. */
  reason: string;
  decidedBy: string;
  /** Set when an accepted finding was folded into a new plan revision. */
  planRevision?: number;
}

export interface ResolveReviewFindingResult {
  repoRoot: string;
  findingId: string;
  status: "accepted" | "declined";
  disposition: FindingDisposition;
  dispositionsPath: string;
}

interface DispositionsFile {
  schemaVersion: string;
  entries: Record<
    string,
    { status: "accepted" | "declined"; disposition: FindingDisposition }
  >;
}

export interface ReviewServiceResult {
  repoRoot: string;
  report: ReviewReportArtifact;
  jsonPath: string;
  markdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
}

export interface ReviewReportArtifact extends ReviewReport {
  changedFiles: string[];
  expectedFiles: string[];
  unexpectedFiles: string[];
  configChanges: string[];
  dependencyChanges: string[];
  securityRiskFiles: string[];
  breakingChangeFiles: string[];
  validationStatus?: string;
  planPath?: string;
  validationPath?: string;
}

interface LoadedPlan {
  path: string;
  plan?: FeaturePlan;
}

interface ValidationReportLike {
  id?: string;
  status?: string;
  summary?: string;
  results?: ValidationResult[];
  failureSummary?: string[];
}

interface LoadedValidation {
  path: string;
  report?: ValidationReportLike;
}

export class ReviewService {
  async review(options: ReviewServiceOptions = {}): Promise<ReviewServiceResult> {
    const repoRoot = path.resolve(options.startPath ?? process.cwd());
    const loadedPlan = await tryReadPlan(repoRoot, options.plan);
    const loadedValidation = await tryReadValidation(repoRoot, options.validation);
    const changedFiles = await getChangedFiles(repoRoot);
    const diffSummary = await getDiffSummary(repoRoot);
    const diffText = await getDiffText(repoRoot);
    const expectedFiles =
      options.expectedFiles ?? getExpectedFiles(loadedPlan.plan, repoRoot);
    const unexpectedFiles = inferUnexpectedFiles(changedFiles, expectedFiles);
    const missingTests = inferMissingTests(changedFiles);
    const configChanges = changedFiles.filter(isConfigFile);
    const dependencyChanges = changedFiles.filter(isDependencyFile);
    const securityRiskFiles = inferSecurityRiskFiles(changedFiles);
    const securityDiffRisk = hasSecurityDiffRisk(diffText);
    const breakingChangeFiles = inferBreakingChangeFiles(changedFiles);
    const breakingDiffRisk = hasBreakingDiffRisk(diffText);
    const validationResults = loadedValidation.report?.results ?? [];
    const validationFailures = validationResults.filter(
      (result) => result.status !== "passed" && result.status !== "skipped"
    );
    const rawFindings = buildFindings({
      unexpectedFiles,
      missingTests,
      configChanges,
      dependencyChanges,
      securityRiskFiles,
      securityDiffRisk,
      breakingChangeFiles,
      breakingDiffRisk,
      validationFailures,
      validationReport: loadedValidation.report
    });
    const dispositions = await loadDispositions(repoRoot);
    const findings = applyDispositions(rawFindings, dispositions);
    const activeFindings = findings.filter((finding) => finding.status !== "declined");
    const risks = inferRisks({
      unexpectedFiles,
      missingTests,
      configChanges,
      dependencyChanges,
      securityRiskFiles,
      securityDiffRisk,
      breakingChangeFiles,
      breakingDiffRisk,
      validationFailures,
      validationReport: loadedValidation.report
    });
    const report: ReviewReportArtifact = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      id: timestampId(),
      planId: loadedPlan.plan?.id,
      repoRoot,
      summary: buildSummary(
        changedFiles,
        unexpectedFiles,
        missingTests,
        loadedValidation.report
      ),
      diffSummary,
      findings,
      missingTests,
      validationResults,
      risks,
      reviewerPrompt: buildReviewerPrompt({
        plan: loadedPlan.plan,
        planPath: loadedPlan.path,
        validationReport: loadedValidation.report,
        validationPath: loadedValidation.path,
        changedFiles,
        expectedFiles,
        unexpectedFiles,
        missingTests,
        findings: activeFindings
      }),
      changedFiles,
      expectedFiles,
      unexpectedFiles,
      configChanges,
      dependencyChanges,
      securityRiskFiles,
      breakingChangeFiles,
      validationStatus: loadedValidation.report?.status,
      planPath: loadedPlan.plan ? loadedPlan.path : undefined,
      validationPath: loadedValidation.report ? loadedValidation.path : undefined
    };
    const reviewDir = getArtifactDirectoryPath(repoRoot, "reviews");
    const jsonPath = path.join(reviewDir, `${report.id}-review.json`);
    const markdownPath = path.join(reviewDir, `${report.id}-review.md`);
    const latestJsonPath = path.join(reviewDir, "latest-review.json");
    const latestMarkdownPath = path.join(reviewDir, "latest-review.md");

    await mkdir(reviewDir, { recursive: true });
    await writeJsonFile(jsonPath, report);
    await writeJsonFile(latestJsonPath, report);
    await writeFile(markdownPath, renderReviewMarkdown(report), "utf8");
    await writeFile(latestMarkdownPath, renderReviewMarkdown(report), "utf8");

    return {
      repoRoot,
      report,
      jsonPath,
      markdownPath,
      latestJsonPath,
      latestMarkdownPath
    };
  }

  /**
   * Records a durable accept/decline decision on one finding, keyed by its
   * stable id. `dispositions.json` is the durable record; individual review
   * reports stay disposable snapshots re-hydrated from it on the next
   * `review` run. See docs/PLAN_LIFECYCLE_DESIGN.md section 3.
   */
  async resolveFinding(
    options: ResolveReviewFindingOptions
  ): Promise<ResolveReviewFindingResult> {
    const findingId = options.findingId.trim();
    const reason = options.reason.trim();
    const decidedBy = options.decidedBy.trim();

    if (!findingId) {
      throw new Error("findingId is required to resolve a review finding");
    }

    if (!reason) {
      throw new Error(
        `reason is required to ${options.decision} a review finding — it is the audit trail.`
      );
    }

    if (!decidedBy) {
      throw new Error("decidedBy is required to resolve a review finding");
    }

    const repoRoot = path.resolve(options.startPath ?? process.cwd());
    const dispositionsPath = getDispositionsPath(repoRoot);
    const dispositions = await loadDispositions(repoRoot);
    const status: "accepted" | "declined" =
      options.decision === "accept" ? "accepted" : "declined";
    const disposition: FindingDisposition = {
      decidedAt: new Date().toISOString(),
      decidedBy,
      reason,
      planRevision: options.planRevision
    };

    dispositions.entries[findingId] = { status, disposition };

    await mkdir(path.dirname(dispositionsPath), { recursive: true });
    await writeJsonFile(dispositionsPath, dispositions);

    return { repoRoot, findingId, status, disposition, dispositionsPath };
  }
}

async function getChangedFiles(repoRoot: string): Promise<string[]> {
  const headDiff = await getGitOutput(repoRoot, ["diff", "--name-only", "HEAD", "--"]);
  const untracked = await getUntrackedFiles(repoRoot);

  const raw =
    headDiff !== undefined
      ? uniqueLines([headDiff, untracked.join("\n")].join("\n"))
      : await (async () => {
          const [unstagedDiff, stagedDiff] = await Promise.all([
            getGitOutput(repoRoot, ["diff", "--name-only", "--"]),
            getGitOutput(repoRoot, ["diff", "--cached", "--name-only", "--"])
          ]);
          return uniqueLines(
            [unstagedDiff ?? "", stagedDiff ?? "", untracked.join("\n")].join("\n")
          );
        })();

  // Drop Copilot Architect's own generated artifacts — reviewing plan/validation
  // JSON as if it were source code is pure noise.
  return raw.filter((filePath) => !isArtifactPath(filePath));
}

function isArtifactPath(filePath: string): boolean {
  return /(^|\/)\.copilot-architect\//.test(filePath);
}

async function getDiffSummary(repoRoot: string): Promise<string> {
  const headSummary = await getGitOutput(repoRoot, ["diff", "--stat", "HEAD", "--"]);
  const untracked = await getUntrackedFiles(repoRoot);
  const untrackedSummary =
    untracked.length > 0
      ? `${untracked.length} new (untracked) file(s):\n${untracked
          .map((file) => ` ${file}`)
          .join("\n")}`
      : "";

  if (headSummary !== undefined) {
    const combined = [headSummary.trim(), untrackedSummary].filter(Boolean).join("\n");
    return combined || "No git diff changes detected.";
  }

  const [unstagedSummary, stagedSummary] = await Promise.all([
    getGitOutput(repoRoot, ["diff", "--stat", "--"]),
    getGitOutput(repoRoot, ["diff", "--cached", "--stat", "--"])
  ]);
  const summary = [unstagedSummary, stagedSummary, untrackedSummary]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .trim();

  return summary || "Git diff summary is unavailable.";
}

async function getDiffText(repoRoot: string): Promise<string> {
  const headDiff = await getGitOutput(repoRoot, ["diff", "--unified=0", "HEAD", "--"]);
  const untrackedDiff = await getUntrackedDiffText(repoRoot);

  if (headDiff !== undefined) {
    return [headDiff, untrackedDiff].filter(Boolean).join("\n");
  }

  const [unstagedDiff, stagedDiff] = await Promise.all([
    getGitOutput(repoRoot, ["diff", "--unified=0", "--"]),
    getGitOutput(repoRoot, ["diff", "--cached", "--unified=0", "--"])
  ]);

  return [unstagedDiff ?? "", stagedDiff ?? "", untrackedDiff]
    .filter(Boolean)
    .join("\n");
}

/**
 * List untracked (newly created, unstaged) files. `git diff` never reports
 * these, so a feature implemented entirely as new files would otherwise produce
 * an empty review — the "No git diff changes detected" symptom. Listing them
 * explicitly lets new files be reviewed like any other change.
 */
async function getUntrackedFiles(repoRoot: string): Promise<string[]> {
  const output = await getGitOutput(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard"
  ]);

  return output
    ? output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((filePath) => !isArtifactPath(filePath))
    : [];
}

/**
 * Synthesize an added-lines diff for untracked files so the security and
 * breaking-change heuristics (which scan `+` lines) also cover brand-new files.
 */
async function getUntrackedDiffText(repoRoot: string): Promise<string> {
  const files = await getUntrackedFiles(repoRoot);
  const parts: string[] = [];

  for (const file of files.slice(0, 50)) {
    try {
      const content = await readFile(path.join(repoRoot, file), "utf8");
      const added = content
        .split(/\r?\n/)
        .map((line) => `+${line}`)
        .join("\n");
      parts.push(`diff --git a/${file} b/${file}\n+++ b/${file}\n${added}`);
    } catch {
      // Binary or unreadable file — skip.
    }
  }

  return parts.join("\n");
}

async function getGitOutput(
  repoRoot: string,
  args: string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function tryReadPlan(repoRoot: string, plan?: string): Promise<LoadedPlan> {
  const planPath =
    !plan || plan === "latest"
      ? path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.json")
      : path.isAbsolute(plan)
        ? plan
        : path.resolve(repoRoot, plan);

  try {
    return { path: planPath, plan: await readJsonFile<FeaturePlan>(planPath) };
  } catch {
    return { path: planPath };
  }
}

async function tryReadValidation(
  repoRoot: string,
  validation?: string
): Promise<LoadedValidation> {
  const validationPath =
    !validation || validation === "latest"
      ? path.join(getArtifactDirectoryPath(repoRoot, "runs"), "latest-validation.json")
      : path.isAbsolute(validation)
        ? validation
        : path.resolve(repoRoot, validation);

  try {
    return {
      path: validationPath,
      report: await readJsonFile<ValidationReportLike>(validationPath)
    };
  } catch {
    return { path: validationPath };
  }
}

function inferMissingTests(changedFiles: string[]): string[] {
  const testFiles = changedFiles.filter(isTestFile);

  return changedFiles
    .filter((filePath) => isSourceFile(filePath) && !isTestFile(filePath))
    .filter((filePath) => !hasRelatedTestChange(filePath, testFiles));
}

function inferRisks(context: {
  unexpectedFiles: string[];
  missingTests: string[];
  configChanges: string[];
  dependencyChanges: string[];
  securityRiskFiles: string[];
  securityDiffRisk: boolean;
  breakingChangeFiles: string[];
  breakingDiffRisk: boolean;
  validationFailures: ValidationResult[];
  validationReport?: ValidationReportLike;
}): RiskItem[] {
  const risks: RiskItem[] = [];

  if (context.unexpectedFiles.length > 0) {
    risks.push({
      severity: "medium",
      title: "Unexpected files changed",
      details: `${context.unexpectedFiles.length} changed file(s) were not listed by the approved plan.`,
      mitigation:
        "Confirm these files are intentionally in scope or update the approved plan."
    });
  }

  if (context.missingTests.length > 0) {
    risks.push({
      severity: "medium",
      title: "Potential missing test coverage",
      details: `${context.missingTests.length} changed source file(s) do not have an obvious related test diff.`,
      mitigation: "Add or update focused tests before handoff."
    });
  }

  if (
    context.validationFailures.length > 0 ||
    isFailedValidation(context.validationReport)
  ) {
    risks.push({
      severity: "high",
      title: "Validation did not pass",
      details: `Validation status is ${context.validationReport?.status ?? "unknown"} with ${context.validationFailures.length} failing or blocked result(s).`,
      mitigation: "Resolve validation failures and rerun validation before approval."
    });
  }

  if (context.dependencyChanges.length > 0) {
    risks.push({
      severity: "medium",
      title: "Dependency or package-manager change",
      details: `${context.dependencyChanges.length} dependency manifest or lockfile change(s) may affect install/build/test behavior.`,
      mitigation: "Run install/build/test validation before review sign-off."
    });
  }

  if (context.configChanges.length > 0) {
    risks.push({
      severity: "medium",
      title: "Configuration change",
      details: `${context.configChanges.length} config file change(s) may affect toolchain or runtime behavior.`,
      mitigation: "Check impacted build, lint, test, and deployment workflows."
    });
  }

  if (context.securityRiskFiles.length > 0 || context.securityDiffRisk) {
    risks.push({
      severity: "high",
      title: "Security-sensitive change",
      details:
        "The diff touches security-sensitive paths or introduces secret/authentication/command-execution signals.",
      mitigation: "Request focused security review and verify no secrets are present."
    });
  }

  if (context.breakingChangeFiles.length > 0 || context.breakingDiffRisk) {
    risks.push({
      severity: "high",
      title: "Possible breaking change",
      details:
        "The diff touches public API, schema, migration, route, or contract areas or removes exported/public symbols.",
      mitigation:
        "Confirm compatibility expectations and update migration or release notes if needed."
    });
  }

  return risks;
}

function buildReviewerPrompt(context: {
  plan: FeaturePlan | undefined;
  planPath: string;
  validationReport: ValidationReportLike | undefined;
  validationPath: string;
  changedFiles: string[];
  expectedFiles: string[];
  unexpectedFiles: string[];
  missingTests: string[];
  findings: ReviewFinding[];
}): string {
  return [
    CHAT_COMMANDS.review,
    "",
    "Review the git diff against the approved plan and validation evidence.",
    context.plan
      ? `Approved plan: ${context.plan.title} (${context.plan.id})`
      : `Approved plan: not available at ${context.planPath}`,
    context.validationReport
      ? `Validation: ${context.validationReport.status ?? "unknown"} (${context.validationReport.id ?? context.validationPath})`
      : `Validation: not available at ${context.validationPath}`,
    `Changed files: ${context.changedFiles.length}`,
    `Expected files: ${context.expectedFiles.length}`,
    `Unexpected files: ${context.unexpectedFiles.length}`,
    `Potential missing tests: ${context.missingTests.length}`,
    `Findings to inspect: ${context.findings.length}`,
    "",
    "Prioritize correctness, safety, missing tests, behavioral regressions, and any changes outside the approved plan.",
    "Call out validation failures and decide whether they block approval.",
    "Declined findings are already excluded above — do not re-raise them. For each open finding, either accept it (fold into a plan revision via revise_feature_plan) or decline it with a reason via resolve_review_finding."
  ].join("\n");
}

function renderReviewMarkdown(report: ReviewReportArtifact): string {
  return [
    `# Review Report ${report.id}`,
    "",
    report.summary,
    "",
    "## Diff Summary",
    "",
    "```text",
    report.diffSummary,
    "```",
    "",
    "## Changed Files",
    "",
    renderList(report.changedFiles),
    "",
    "## Plan Comparison",
    "",
    `Plan: ${report.planId ?? "not available"}`,
    `Plan path: ${report.planPath ?? "not loaded"}`,
    "",
    "Expected files:",
    renderList(report.expectedFiles),
    "",
    "Unexpected files:",
    renderList(report.unexpectedFiles),
    "",
    "## Validation Evidence",
    "",
    `Validation status: ${report.validationStatus ?? "not available"}`,
    `Validation path: ${report.validationPath ?? "not loaded"}`,
    "",
    report.validationResults
      .map((result) => `- ${result.status}: ${result.command.name}`)
      .join("\n") || "- No validation results loaded.",
    "",
    "## Findings",
    "",
    report.findings
      .filter((finding) => finding.status !== "declined")
      .map((finding) => renderFindingLine(finding))
      .join("\n") || "- No findings.",
    "",
    "## Declined (with reason)",
    "",
    report.findings
      .filter((finding) => finding.status === "declined")
      .map((finding) => renderFindingLine(finding))
      .join("\n") || "- No declined findings.",
    "",
    "## Missing Tests",
    "",
    renderList(report.missingTests),
    "",
    "## Risks",
    "",
    report.risks
      .map((risk) => `- ${risk.severity}: ${risk.title} - ${risk.details}`)
      .join("\n") || "- No risks detected.",
    "",
    "## Reviewer Prompt",
    "",
    "```markdown",
    report.reviewerPrompt ?? "",
    "```"
  ].join("\n");
}

function buildSummary(
  changedFiles: string[],
  unexpectedFiles: string[],
  missingTests: string[],
  validationReport?: ValidationReportLike
): string {
  const base =
    changedFiles.length > 0
      ? `Review prepared for ${changedFiles.length} changed file(s).`
      : "Review prepared with no git diff changes detected.";
  const validationSummary = validationReport
    ? ` Validation status: ${validationReport.status ?? "unknown"}.`
    : " No validation report was loaded.";

  return `${base} Unexpected files: ${unexpectedFiles.length}. Missing tests: ${missingTests.length}.${validationSummary}`;
}

type RawFinding = Omit<ReviewFinding, "id" | "status" | "disposition">;

function buildFindings(context: {
  unexpectedFiles: string[];
  missingTests: string[];
  configChanges: string[];
  dependencyChanges: string[];
  securityRiskFiles: string[];
  securityDiffRisk: boolean;
  breakingChangeFiles: string[];
  breakingDiffRisk: boolean;
  validationFailures: ValidationResult[];
  validationReport?: ValidationReportLike;
}): ReviewFinding[] {
  const findings: RawFinding[] = [];

  findings.push(
    ...context.unexpectedFiles.map((filePath) => ({
      severity: "warning" as const,
      title: "Unexpected file changed",
      filePath,
      details:
        "This changed file is not listed in the approved plan's expected or affected files."
    }))
  );

  findings.push(
    ...context.missingTests.map((filePath) => ({
      severity: "warning" as const,
      title: "Changed source without nearby test change",
      filePath,
      details:
        "This source file changed, but the current diff does not include an obvious related test file update."
    }))
  );

  findings.push(
    ...context.configChanges.map((filePath) => ({
      severity: "warning" as const,
      title: "Configuration file changed",
      filePath,
      details:
        "Configuration changes can alter build, lint, test, deployment, or runtime behavior."
    }))
  );

  findings.push(
    ...context.dependencyChanges.map((filePath) => ({
      severity: "warning" as const,
      title: "Dependency manifest or lockfile changed",
      filePath,
      details:
        "Dependency changes should be validated with install/build/test evidence and reviewed for supply-chain impact."
    }))
  );

  findings.push(
    ...context.securityRiskFiles.map((filePath) => ({
      severity: "error" as const,
      title: "Potential security-sensitive file changed",
      filePath,
      details:
        "The path suggests authentication, authorization, secrets, credentials, sessions, or security policy behavior changed."
    }))
  );

  if (context.securityDiffRisk) {
    findings.push({
      severity: "error",
      title: "Potential secret or unsafe API change",
      details:
        "The diff contains secret/authentication/authorization keywords or command-execution patterns that require focused review."
    });
  }

  findings.push(
    ...context.breakingChangeFiles.map((filePath) => ({
      severity: "warning" as const,
      title: "Possible breaking change",
      filePath,
      details:
        "The path suggests public API, schema, route, migration, or contract behavior may have changed."
    }))
  );

  if (context.breakingDiffRisk) {
    findings.push({
      severity: "warning",
      title: "Possible exported or public contract removal",
      details:
        "The diff appears to remove exported/public API surface or includes an explicit breaking-change signal."
    });
  }

  if (isFailedValidation(context.validationReport)) {
    findings.push({
      severity: "error",
      title: "Validation failed",
      details: [
        `Validation status is ${context.validationReport?.status ?? "unknown"}.`,
        ...(context.validationReport?.failureSummary ?? [])
      ].join(" ")
    });
  }

  findings.push(
    ...context.validationFailures.map((result) => ({
      severity: "error" as const,
      title: "Validation command did not pass",
      details: `${result.command.name} finished with status ${result.status}${result.failureClassification ? ` (${result.failureClassification})` : ""}. ${result.outputSummary}`
    }))
  );

  return findings.map((finding) => ({
    ...finding,
    id: computeFindingId(finding),
    status: "open" as const
  }));
}

/**
 * A stable id across runs, deliberately excluding `line`/`details` so a
 * finding survives unrelated edits that shift line numbers. `title` doubles
 * as the finding's rule/category — each branch above uses a fixed title.
 */
function computeFindingId(finding: RawFinding): string {
  const key = `${finding.severity}|${finding.title}|${finding.filePath ?? ""}`;
  return `finding_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function getDispositionsPath(repoRoot: string): string {
  return path.join(getArtifactDirectoryPath(repoRoot, "reviews"), "dispositions.json");
}

async function loadDispositions(repoRoot: string): Promise<DispositionsFile> {
  try {
    return await readJsonFile<DispositionsFile>(getDispositionsPath(repoRoot));
  } catch {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, entries: {} };
  }
}

/**
 * Re-hydrates freshly-built findings with any durable disposition on record,
 * so a declined finding stays declined and an accepted one keeps its
 * plan-revision link, without ever being rebuilt from scratch.
 */
function applyDispositions(
  findings: ReviewFinding[],
  dispositions: DispositionsFile
): ReviewFinding[] {
  return findings.map((finding) => {
    const entry = dispositions.entries[finding.id];

    if (!entry) {
      return finding;
    }

    return { ...finding, status: entry.status, disposition: entry.disposition };
  });
}

function getExpectedFiles(plan: FeaturePlan | undefined, repoRoot: string): string[] {
  if (!plan) {
    return [];
  }

  const extendedPlan = plan as FeaturePlan & {
    likelyNewFiles?: string[];
    relevantFiles?: Array<string | { filePath?: string }>;
  };
  const relevantFiles =
    extendedPlan.relevantFiles
      ?.map((file) => (typeof file === "string" ? file : file.filePath))
      .filter((filePath): filePath is string => Boolean(filePath)) ?? [];

  return uniqueValues([
    ...plan.implementationSteps.flatMap((step) => step.files),
    ...plan.impactAnalysis.affectedFiles,
    ...(extendedPlan.likelyNewFiles ?? []),
    ...relevantFiles
  ]).map((filePath) => normalizeRelativePath(filePath, repoRoot));
}

function inferUnexpectedFiles(
  changedFiles: string[],
  expectedFiles: string[]
): string[] {
  if (expectedFiles.length === 0) {
    return [];
  }

  return changedFiles.filter((filePath) => !isExpectedChange(filePath, expectedFiles));
}

function isExpectedChange(filePath: string, expectedFiles: string[]): boolean {
  const normalized = normalizeRelativePath(filePath);

  return expectedFiles.some((expectedFile) => {
    const expected = normalizeRelativePath(expectedFile);
    return (
      normalized === expected ||
      normalized.startsWith(`${expected.replace(/\/$/, "")}/`) ||
      (expected.endsWith("/") && normalized.startsWith(expected))
    );
  });
}

function isSourceFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|py|java|go|rs|php|rb|c|cc|cpp|h|hpp)$/i.test(filePath);
}

function isTestFile(filePath: string): boolean {
  return /(\btest\b|\bspec\b|__tests__|\.test\.|\.spec\.)/i.test(filePath);
}

function hasRelatedTestChange(sourceFile: string, testFiles: string[]): boolean {
  const sourceBaseName = stripSourceExtension(path.basename(sourceFile)).toLowerCase();
  const sourceDirectory = normalizeRelativePath(path.dirname(sourceFile));

  return testFiles.some((testFile) => {
    const testBaseName = stripTestExtension(path.basename(testFile)).toLowerCase();
    const testDirectory = normalizeRelativePath(path.dirname(testFile));

    return (
      testBaseName.includes(sourceBaseName) ||
      sourceBaseName.includes(testBaseName) ||
      testDirectory === sourceDirectory ||
      testDirectory.startsWith(`${sourceDirectory}/`)
    );
  });
}

function inferSecurityRiskFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((filePath) =>
    /(^|\/)(auth|security|secrets?|credentials?|sessions?|permissions?|polic(y|ies)|login|oauth|jwt|tokens?)(\/|\.|-|_)/i.test(
      `${filePath}/`
    )
  );
}

function inferBreakingChangeFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((filePath) =>
    /(^|\/)(api|routes?|controllers?|schemas?|migrations?|contracts?|public|proto|openapi|graphql|types?)(\/|\.|-|_)/i.test(
      `${filePath}/`
    )
  );
}

function hasSecurityDiffRisk(diffText: string): boolean {
  return [
    /^\+.*(?:password|passwd|secret|token|api[_-]?key|authorization|private key|credential)\s*[:=]/im,
    /^\+.*(?:eval\(|dangerouslySetInnerHTML|innerHTML\s*=|child_process|exec\(|spawn\(|subprocess|os\.system|Runtime\.getRuntime)/im
  ].some((pattern) => pattern.test(diffText));
}

function hasBreakingDiffRisk(diffText: string): boolean {
  return [
    /^-.*\b(?:export|public)\s+(?:class|interface|type|function|const|enum)\b/im,
    /^-.*\b(?:public|protected)\s+[^\s(]+\s+\w+\s*\(/im,
    /^[+-].*\bBREAKING(?:\s+CHANGE)?\b/im
  ].some((pattern) => pattern.test(diffText));
}

function isConfigFile(filePath: string): boolean {
  return [
    /(^|\/)(tsconfig|jsconfig)(\.[^/]+)?\.json$/i,
    /(^|\/)(vite|webpack|rollup|babel|eslint|prettier|jest|vitest|playwright|cypress|angular|nx|turbo|next|nuxt|svelte)\.config\.[cm]?[jt]s$/i,
    /(^|\/)(angular|nx|turbo|lerna|docker-compose)\.json$/i,
    /(^|\/)(Dockerfile|Makefile|\.npmrc|\.yarnrc|\.env(?:\..*)?|gradle\.properties|settings\.gradle|pom\.xml|build\.gradle|package\.json)$/i,
    /(^|\/)\.github\/workflows\//i
  ].some((pattern) => pattern.test(filePath));
}

function isDependencyFile(filePath: string): boolean {
  return [
    /(^|\/)package\.json$/i,
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
    /(^|\/)(requirements(?:-[^/]+)?\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock)$/i,
    /(^|\/)(pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.lockfile)$/i,
    /(^|\/)(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|composer\.json|composer\.lock)$/i
  ].some((pattern) => pattern.test(filePath));
}

function isFailedValidation(validationReport?: ValidationReportLike): boolean {
  return Boolean(
    validationReport?.status &&
    validationReport.status !== "passed" &&
    validationReport.status !== "skipped" &&
    validationReport.status !== "not-run"
  );
}

function stripSourceExtension(fileName: string): string {
  return fileName.replace(
    /\.(test|spec)?\.?(ts|tsx|js|jsx|py|java|go|rs|php|rb|c|cc|cpp|h|hpp)$/i,
    ""
  );
}

function stripTestExtension(fileName: string): string {
  return fileName.replace(
    /(\.test|\.spec)?\.(ts|tsx|js|jsx|py|java|go|rs|php|rb|c|cc|cpp|h|hpp)$/i,
    ""
  );
}

function normalizeRelativePath(filePath: string, repoRoot?: string): string {
  const relativePath =
    repoRoot && path.isAbsolute(filePath)
      ? path.relative(repoRoot, filePath)
      : filePath;

  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None.";
}

function renderFindingLine(finding: ReviewFinding): string {
  const location = finding.filePath ? ` (${finding.filePath})` : "";
  const disposition = finding.disposition
    ? ` [${finding.status} by ${finding.disposition.decidedBy}: ${finding.disposition.reason}]`
    : "";
  return `- \`${finding.id}\` ${finding.severity}: ${finding.title}${location} - ${finding.details}${disposition}`;
}

function uniqueLines(value: string): string[] {
  return uniqueValues(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeRelativePath(line))
  );
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function timestampId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}
