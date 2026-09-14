import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepoDiscoveryService } from "@copilot-architect/core";
import {
  CURRENT_SCHEMA_VERSION,
  type CommandRiskAssessment,
  type DetectedCommand,
  type RepoMap,
  type UniversalRepoMap,
  type ValidationCommand,
  type ValidationResult,
  type ValidationStatus,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  readJsonFile,
  writeJsonFile
} from "@copilot-architect/shared";

import { CommandConfigService } from "./command-config-service.js";
import { AuditLogService } from "./audit-log-service.js";
import { CommandRiskAssessmentService } from "./command-risk-assessment-service.js";
import {
  COMMAND_CONFIG_CATEGORIES,
  type CommandConfigCategory,
  type ParsedCustomCommand,
  type ValidationCommandCandidate,
  type ValidationOutputEvent,
  type ValidationReportArtifact,
  type ValidationRunArtifactPaths,
  type ValidationRunResult,
  type ValidationServiceOptions
} from "./models.js";
import { SafetyPolicyService } from "./safety-policy-service.js";
import { SecretRedactionService } from "./secret-redaction-service.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SUMMARY_CHARS = 600;

export class ValidationService {
  constructor(
    private readonly safetyPolicyService = new SafetyPolicyService(),
    private readonly commandRiskAssessmentService = new CommandRiskAssessmentService(),
    private readonly secretRedactionService = new SecretRedactionService(),
    private readonly auditLogService = new AuditLogService()
  ) {}

  async validate(options: ValidationServiceOptions = {}): Promise<ValidationRunResult> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = await ensureRepoMap(startPath, options.strictRoot);
    const repo = repoMap.repos[0];

    if (!repo) {
      throw new Error("Repo map does not contain any repositories");
    }

    const repoRoot = repoMap.workspaceRoot;
    const selectedCategories = normalizeCategories(options.categories);
    const safetyPolicy = await this.safetyPolicyService.load(repoRoot);
    const customConfig = await new CommandConfigService().load({
      startPath: repoRoot,
      allowMissing: true
    });
    const plannedCommands = buildValidationPlan(
      repo,
      customConfig.commands,
      selectedCategories,
      options.timeoutMs
    );
    const id = timestampId();
    const artifactPaths = createValidationArtifactPaths(repoRoot, id);
    const logLines: string[] = [];
    const results: ValidationResult[] = [];
    const riskAssessments: CommandRiskAssessment[] = [];

    await mkdir(getArtifactDirectoryPath(repoRoot, "runs"), { recursive: true });

    for (const candidate of plannedCommands) {
      const assessment = this.commandRiskAssessmentService.assess(
        repoRoot,
        candidate.command,
        safetyPolicy
      );
      riskAssessments.push(assessment);

      if (!assessment.allowed) {
        const result = createBlockedResult(candidate.command, assessment);
        results.push(result);
        appendSystemLog(
          logLines,
          candidate.command.name,
          assessment.reasons.join("; "),
          this.secretRedactionService
        );
        continue;
      }

      const result = await runCommandCandidate(
        repoRoot,
        candidate,
        logLines,
        this.secretRedactionService,
        options.onOutput
      );
      results.push(result);
    }

    const status = summarizeStatus(results);
    const failureSummary = summarizeFailures(results, riskAssessments);
    const fixPrompt = generateFixPrompt(repoRoot, results, failureSummary);
    const report: ValidationReportArtifact = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      id,
      repoRoot,
      status,
      summary: createReportSummary(status, results),
      selectedCategories,
      plannedCommands,
      results,
      riskAssessments,
      failureSummary,
      fixPrompt,
      artifactPaths
    };
    const markdown = renderValidationMarkdown(report);
    const logText = `${logLines.join("\n")}\n`;

    await writeJsonFile(artifactPaths.timestampJsonPath, report);
    await writeJsonFile(artifactPaths.latestJsonPath, report);
    await writeTextFile(artifactPaths.timestampMarkdownPath, markdown);
    await writeTextFile(artifactPaths.latestMarkdownPath, markdown);
    await writeTextFile(artifactPaths.timestampLogPath, logText);
    await this.auditLogService.record(repoRoot, {
      action: "validation.run",
      actor: "cli",
      target: artifactPaths.timestampJsonPath,
      summary: report.summary,
      metadata: {
        status: report.status,
        commandCount: report.results.length,
        selectedCategories: report.selectedCategories
      }
    });

    return {
      repoRoot,
      report,
      markdown,
      logText
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

function normalizeCategories(
  categories: CommandConfigCategory[] | undefined
): CommandConfigCategory[] {
  return categories && categories.length > 0
    ? uniqueCategories(categories)
    : [...COMMAND_CONFIG_CATEGORIES];
}

function buildValidationPlan(
  repo: RepoMap,
  customCommands: ParsedCustomCommand[],
  selectedCategories: CommandConfigCategory[],
  timeoutMs: number | undefined
): ValidationCommandCandidate[] {
  const selected = new Set(selectedCategories);
  const customCandidates = customCommands
    .filter((customCommand) => selected.has(customCommand.category))
    .map((customCommand) => ({
      category: customCommand.category,
      source: "custom" as const,
      command: applyDefaultTimeout(customCommand.command, timeoutMs)
    }));
  const overrideKeys = new Set(
    customCommands
      .filter(
        (customCommand) =>
          selected.has(customCommand.category) && customCommand.overrideDetected
      )
      .flatMap((customCommand) => commandKeys(customCommand.command))
  );
  const detectedCandidates = selectedCategories.flatMap((category) =>
    detectedCommandsForCategory(repo, category)
      .map((command, index) => ({
        category,
        source: "detected" as const,
        command: applyDefaultTimeout(
          detectedToValidationCommand(command, category, index),
          timeoutMs
        )
      }))
      .filter(
        (candidate) =>
          !commandKeys(candidate.command).some((key) => overrideKeys.has(key))
      )
  );

  return uniqueCandidates([...customCandidates, ...detectedCandidates]);
}

function detectedCommandsForCategory(
  repo: RepoMap,
  category: CommandConfigCategory
): DetectedCommand[] {
  if (category === "build") {
    return repo.commands.build;
  }

  if (category === "test") {
    return repo.commands.test;
  }

  if (category === "lint") {
    return repo.commands.lint;
  }

  if (category === "format") {
    return repo.commands.format;
  }

  return repo.commands.validation;
}

function detectedToValidationCommand(
  command: DetectedCommand,
  category: CommandConfigCategory,
  index: number
): ValidationCommand {
  return {
    kind: "validation",
    name: command.name || `${category}-${index + 1}`,
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    description: command.description,
    confidence: command.confidence,
    source: command.source,
    required: index < 3
  };
}

function applyDefaultTimeout(
  command: ValidationCommand,
  timeoutMs: number | undefined
): ValidationCommand {
  return {
    ...command,
    timeoutMs: command.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryCount: command.retryCount ?? 0
  };
}

async function runCommandCandidate(
  repoRoot: string,
  candidate: ValidationCommandCandidate,
  logLines: string[],
  redactionService: SecretRedactionService,
  onOutput: ((event: ValidationOutputEvent) => void) | undefined
): Promise<ValidationResult> {
  const command = candidate.command;
  const maxAttempts = Math.max(1, (command.retryCount ?? 0) + 1);
  let lastResult: ValidationResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runCommandAttempt(
      repoRoot,
      candidate,
      attempt,
      logLines,
      redactionService,
      onOutput
    );
    lastResult = result;

    if (result.status === "passed") {
      return result;
    }

    if (result.status === "timed-out") {
      break;
    }
  }

  return lastResult ?? createSkippedResult(command, "Command was not attempted.");
}

function runCommandAttempt(
  repoRoot: string,
  candidate: ValidationCommandCandidate,
  attempt: number,
  logLines: string[],
  redactionService: SecretRedactionService,
  onOutput: ((event: ValidationOutputEvent) => void) | undefined
): Promise<ValidationResult> {
  const command = candidate.command;
  const startedAt = new Date();
  const output: string[] = [];
  const cwd = command.cwd ? path.resolve(repoRoot, command.cwd) : repoRoot;

  appendSystemLog(
    logLines,
    command.name,
    `starting attempt ${attempt}: ${commandTextFor(command)}`,
    redactionService
  );

  return new Promise((resolve) => {
    // On Windows, npm/npx/yarn/pnpm are .cmd batch files that cannot be spawned with
    // shell:false (throws EINVAL). Invoke them via cmd.exe /c to preserve exit codes.
    // All other commands (node, python, git, etc.) are real executables — keep shell:false
    // to avoid cmd.exe quoting issues with -e arguments and semicolons.
    const [executable, spawnArgs] = resolveSpawnTarget(command.command, command.args);
    const child = spawn(executable, spawnArgs, {
      cwd,
      shell: false,
      env: process.env
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, command.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = redactionService.redact(chunk.toString("utf8")).text;
      output.push(text);
      appendStreamLog(logLines, command.name, "stdout", text, redactionService);
      onOutput?.({ commandName: command.name, stream: "stdout", text });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = redactionService.redact(chunk.toString("utf8")).text;
      output.push(text);
      appendStreamLog(logLines, command.name, "stderr", text, redactionService);
      onOutput?.({ commandName: command.name, stream: "stderr", text });
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      const completedAt = new Date();
      const text = redactionService.redact(error.message).text;
      output.push(text);
      appendStreamLog(logLines, command.name, "stderr", text, redactionService);
      resolve(
        createRunResult(command, {
          status: "failed",
          startedAt,
          completedAt,
          exitCode: undefined,
          outputSummary: summarizeOutput(output, redactionService),
          failureClassification: "spawn-error"
        })
      );
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const completedAt = new Date();
      const status: ValidationStatus = timedOut
        ? "timed-out"
        : exitCode === 0
          ? "passed"
          : "failed";

      resolve(
        createRunResult(command, {
          status,
          startedAt,
          completedAt,
          exitCode: exitCode ?? undefined,
          outputSummary: summarizeOutput(output, redactionService),
          failureClassification:
            status === "timed-out"
              ? "timeout"
              : status === "failed"
                ? "non-zero-exit"
                : undefined
        })
      );
    });
  });
}

function createRunResult(
  command: ValidationCommand,
  input: {
    status: ValidationStatus;
    startedAt: Date;
    completedAt: Date;
    exitCode?: number;
    outputSummary: string;
    failureClassification?: string;
  }
): ValidationResult {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: input.completedAt.toISOString(),
    id: `${slug(command.name)}-${input.startedAt.getTime()}`,
    command,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    exitCode: input.exitCode,
    durationMs: input.completedAt.getTime() - input.startedAt.getTime(),
    outputSummary: input.outputSummary,
    failureClassification: input.failureClassification
  };
}

function createBlockedResult(
  command: ValidationCommand,
  assessment: CommandRiskAssessment
): ValidationResult {
  const now = new Date().toISOString();

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: now,
    id: `${slug(command.name)}-blocked`,
    command,
    status: "blocked",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    outputSummary: assessment.reasons.join(" "),
    failureClassification: "blocked-by-safety"
  };
}

function createSkippedResult(
  command: ValidationCommand,
  reason: string
): ValidationResult {
  const now = new Date().toISOString();

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: now,
    id: `${slug(command.name)}-skipped`,
    command,
    status: "skipped",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    outputSummary: reason,
    failureClassification: "not-attempted"
  };
}

function summarizeStatus(results: ValidationResult[]): ValidationStatus {
  if (results.length === 0) {
    return "skipped";
  }

  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "timed-out")) {
    return "timed-out";
  }

  if (results.some((result) => result.status === "blocked")) {
    return "blocked";
  }

  if (results.every((result) => result.status === "passed")) {
    return "passed";
  }

  return "skipped";
}

function summarizeFailures(
  results: ValidationResult[],
  assessments: CommandRiskAssessment[]
): string[] {
  const failures = results
    .filter((result) => result.status !== "passed" && result.status !== "skipped")
    .map((result) => {
      const commandText = commandTextFor(result.command);
      return `${result.command.name} (${commandText}) ${result.status}: ${result.outputSummary || result.failureClassification || "no output summary"}`;
    });
  const blocked = assessments
    .filter((assessment) => !assessment.allowed)
    .map(
      (assessment) => `Blocked ${assessment.command}: ${assessment.reasons.join("; ")}`
    );

  return uniqueStrings([...failures, ...blocked]);
}

function generateFixPrompt(
  repoRoot: string,
  results: ValidationResult[],
  failureSummary: string[]
): string {
  if (failureSummary.length === 0) {
    return "Validation passed. No fix prompt is needed.";
  }

  return [
    "Review the validation failures below and propose the smallest safe fix.",
    `Repository: ${repoRoot}`,
    "",
    "Failures:",
    ...failureSummary.map((failure) => `- ${failure}`),
    "",
    "Use the saved validation logs for details. Do not run blocked commands unless a human updates the safety policy."
  ].join("\n");
}

function createReportSummary(
  status: ValidationStatus,
  results: ValidationResult[]
): string {
  const counts = new Map<ValidationStatus, number>();

  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }

  return `Validation ${status}: ${results.length} command(s), ${counts.get("passed") ?? 0} passed, ${counts.get("failed") ?? 0} failed, ${counts.get("blocked") ?? 0} blocked, ${counts.get("timed-out") ?? 0} timed out.`;
}

function renderValidationMarkdown(report: ValidationReportArtifact): string {
  return [
    "# Validation Report",
    "",
    `**Status:** ${report.status}`,
    `**Summary:** ${report.summary}`,
    `**Generated:** ${report.generatedAt}`,
    "",
    "## Commands",
    ...report.results.map(
      (result) =>
        `- ${result.status}: ${result.command.name} - \`${commandTextFor(result.command)}\``
    ),
    "",
    "## Failures",
    ...(report.failureSummary.length > 0
      ? report.failureSummary.map((failure) => `- ${failure}`)
      : ["- None."]),
    "",
    "## Fix Prompt",
    report.fixPrompt,
    ""
  ].join("\n");
}

function createValidationArtifactPaths(
  repoRoot: string,
  id: string
): ValidationRunArtifactPaths {
  const runsRoot = getArtifactDirectoryPath(repoRoot, "runs");

  return {
    timestampJsonPath: path.join(runsRoot, `${id}-validation.json`),
    timestampMarkdownPath: path.join(runsRoot, `${id}-validation.md`),
    timestampLogPath: path.join(runsRoot, `${id}-logs.txt`),
    latestJsonPath: path.join(runsRoot, "latest-validation.json"),
    latestMarkdownPath: path.join(runsRoot, "latest-validation.md")
  };
}

function appendSystemLog(
  logLines: string[],
  commandName: string,
  text: string,
  redactionService: SecretRedactionService
): void {
  logLines.push(
    `[${new Date().toISOString()}] [${commandName}] [system] ${redactionService.redact(text).text}`
  );
}

function appendStreamLog(
  logLines: string[],
  commandName: string,
  stream: "stdout" | "stderr",
  text: string,
  redactionService: SecretRedactionService
): void {
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    logLines.push(
      `[${new Date().toISOString()}] [${commandName}] [${stream}] ${redactionService.redact(line).text}`
    );
  }
}

function summarizeOutput(
  chunks: string[],
  redactionService: SecretRedactionService
): string {
  const text = redactionService.redact(chunks.join("")).text;

  if (!text.trim()) {
    return "";
  }

  return text.trim().slice(-MAX_OUTPUT_SUMMARY_CHARS);
}

function commandTextFor(command: ValidationCommand): string {
  return [command.command, ...command.args].join(" ");
}

function commandKeys(command: ValidationCommand): string[] {
  return [
    `name:${command.name}`,
    `command:${[command.command, ...command.args].join(" ")}`
  ];
}

function uniqueCandidates(
  candidates: ValidationCommandCandidate[]
): ValidationCommandCandidate[] {
  const seen = new Set<string>();
  const result: ValidationCommandCandidate[] = [];

  for (const candidate of candidates) {
    const key = commandTextFor(candidate.command);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(candidate);
    }
  }

  return result;
}

function uniqueCategories(
  categories: CommandConfigCategory[]
): CommandConfigCategory[] {
  return categories.filter((category, index) => categories.indexOf(category) === index);
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}

// On Windows, npm/npx/yarn/pnpm are .cmd batch files and cannot be spawned directly
// with shell:false (EINVAL). Route them through cmd.exe /c to preserve exit codes.
// node/python/git/etc. are real executables — run them directly so -e args and
// semicolons are not reinterpreted by cmd.exe.
function resolveSpawnTarget(cmd: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32") return [cmd, args];
  const npmLike = new Set(["npm", "npx", "yarn", "pnpm"]);
  const base = path.basename(cmd, ".cmd").toLowerCase();
  if (npmLike.has(base)) return ["cmd.exe", ["/c", cmd, ...args]];
  return [cmd, args];
}
