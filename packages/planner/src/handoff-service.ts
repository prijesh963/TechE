import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepoDiscoveryService } from "@copilot-architect/core";
import {
  GitCheckpointService,
  SafetyPolicyService,
  type GitCheckpointResult
} from "@copilot-architect/validator";
import {
  CURRENT_SCHEMA_VERSION,
  type FeaturePlan,
  type HandoffPrompt,
  type SafetyPolicy,
  type UniversalRepoMap,
  type ValidationCommand,
  getArtifactDirectoryPath,
  readJsonFile,
  writeJsonFile
} from "@copilot-architect/shared";

import type { PlanApproval } from "./models.js";

export interface HandoffGenerationOptions {
  startPath?: string;
  plan?: string;
  approved?: boolean;
  targetAgent?: HandoffPrompt["targetAgent"];
  copyToClipboard?: boolean;
}

export interface ClipboardResult {
  attempted: boolean;
  copied: boolean;
  message: string;
}

export interface HandoffGenerationResult {
  repoRoot: string;
  planPath: string;
  handoff: HandoffPrompt;
  repoMap: UniversalRepoMap;
  safetyPolicy: SafetyPolicy;
  gitCheckpoint: GitCheckpointResult;
  clipboard: ClipboardResult;
  jsonPath: string;
  markdownPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
}

export class HandoffService {
  async generate(
    options: HandoffGenerationOptions = {}
  ): Promise<HandoffGenerationResult> {
    if (options.approved !== true) {
      throw new Error("handoff generation requires --approve");
    }

    const startPath = path.resolve(options.startPath ?? process.cwd());
    const planPath = resolvePlanPath(startPath, options.plan);
    const plan = await readJsonFile<FeaturePlan & { approval?: PlanApproval }>(
      planPath
    );

    if (plan.status !== "approved" || !plan.approval) {
      throw new Error(
        `Plan ${plan.id} is at status "${plan.status}". Run approve_plan (or "cli plan approve") before generating a handoff.`
      );
    }

    const repoRoot = path.resolve(plan.repoRoot || startPath);
    const repoMap = (await new RepoDiscoveryService().analyze({ startPath: repoRoot }))
      .repoMap;
    const safetyPolicy = await new SafetyPolicyService().load(repoRoot);
    const gitCheckpoint = await new GitCheckpointService().createCheckpoint(repoRoot);
    const validationCommands = plan.validationPlan.commands;
    const safetyNotes = createSafetyNotes(safetyPolicy, gitCheckpoint);
    const id = timestampId();
    const targetAgent = options.targetAgent ?? "copilot";
    const promptMarkdown = renderHandoffMarkdown({
      plan,
      planPath,
      repoMap,
      safetyPolicy,
      safetyNotes,
      validationCommands,
      gitCheckpoint,
      targetAgent
    });
    const handoff: HandoffPrompt = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      id,
      planId: plan.id,
      targetAgent,
      approved: true,
      promptMarkdown,
      expectedFiles: collectExpectedFiles(plan),
      validationCommands,
      safetyNotes
    };
    const handoffDir = getArtifactDirectoryPath(repoRoot, "handoffs");
    const jsonPath = path.join(handoffDir, `${id}-handoff.json`);
    const markdownPath = path.join(handoffDir, `${id}-handoff.md`);
    const latestJsonPath = path.join(handoffDir, "latest-handoff.json");
    const latestMarkdownPath = path.join(handoffDir, "latest-handoff.md");

    await mkdir(handoffDir, { recursive: true });
    await writeJsonFile(jsonPath, handoff);
    await writeJsonFile(latestJsonPath, handoff);
    await writeFile(markdownPath, handoff.promptMarkdown, "utf8");
    await writeFile(latestMarkdownPath, handoff.promptMarkdown, "utf8");

    const clipboard =
      options.copyToClipboard === false
        ? {
            attempted: false,
            copied: false,
            message: "Clipboard copy skipped by option."
          }
        : await tryCopyToClipboard(handoff.promptMarkdown);

    return {
      repoRoot,
      planPath,
      handoff,
      repoMap,
      safetyPolicy,
      gitCheckpoint,
      clipboard,
      jsonPath,
      markdownPath,
      latestJsonPath,
      latestMarkdownPath
    };
  }
}

function resolvePlanPath(repoRoot: string, plan?: string): string {
  if (!plan || plan === "latest") {
    return path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.json");
  }

  return path.isAbsolute(plan) ? plan : path.resolve(repoRoot, plan);
}

function collectExpectedFiles(plan: FeaturePlan): string[] {
  return Array.from(
    new Set([
      ...plan.implementationSteps.flatMap((step) => step.files),
      ...plan.impactAnalysis.affectedFiles
    ])
  ).filter(Boolean);
}

function createSafetyNotes(
  safetyPolicy: SafetyPolicy,
  gitCheckpoint: GitCheckpointResult
): string[] {
  return [
    "Human approval was explicitly provided before this handoff was generated.",
    "Never directly edit target repository code from the handoff generator.",
    "Keep implementation changes inside the workspace root.",
    "Do not run dangerous commands blocked by the safety policy.",
    "Do not introduce new dependencies unless necessary and explicitly justified.",
    "Do not print or store secrets in handoff, validation, or review artifacts.",
    `Safety policy requires approval for handoff: ${safetyPolicy.requireApprovalForHandoff ? "yes" : "no"}.`,
    `Workspace boundary required: ${safetyPolicy.workspaceBoundaryRequired ? "yes" : "no"}.`,
    gitCheckpoint.created
      ? `Git checkpoint captured at ${gitCheckpoint.checkpointPath}.`
      : `Git checkpoint not created: ${gitCheckpoint.message}`
  ];
}

function renderHandoffMarkdown(input: {
  plan: FeaturePlan;
  planPath: string;
  repoMap: UniversalRepoMap;
  safetyPolicy: SafetyPolicy;
  safetyNotes: string[];
  validationCommands: ValidationCommand[];
  gitCheckpoint: GitCheckpointResult;
  targetAgent: HandoffPrompt["targetAgent"];
}): string {
  const {
    plan,
    planPath,
    repoMap,
    safetyPolicy,
    safetyNotes,
    validationCommands,
    gitCheckpoint,
    targetAgent
  } = input;

  return [
    "@FeatureImplementer",
    "",
    "Implement the approved plan below.",
    "",
    "Rules:",
    "1. Follow the plan exactly unless blocked.",
    "2. Keep changes minimal.",
    "3. Reuse existing patterns.",
    "4. Do not introduce new dependencies unless necessary.",
    "5. Update tests.",
    "6. Run validation commands.",
    "7. Summarize changed files.",
    "8. Stop and ask if risky architecture decisions are required.",
    "",
    "Target agent compatibility:",
    `- Requested target: ${targetAgent}.`,
    "- This handoff is suitable for GitHub Copilot custom agents, Copilot chat, Codex, Claude Code, and generic coding agents.",
    "- Prefer the installed @FeatureImplementer agent when available.",
    "",
    "Approved plan:",
    "",
    `Plan artifact: ${planPath}`,
    `Plan ID: ${plan.id}`,
    `Plan status: ${plan.status}`,
    `Task: ${plan.task}`,
    "",
    "Summary:",
    plan.summary,
    "",
    "Assumptions:",
    ...listLines(plan.assumptions),
    "",
    "Implementation steps:",
    ...plan.implementationSteps.flatMap((step, index) => [
      `${index + 1}. ${step.title}`,
      `   ${step.details}`,
      `   Files: ${step.files.join(", ") || "to be identified during implementation"}`
    ]),
    "",
    "Impact analysis:",
    `- ${plan.impactAnalysis.summary}`,
    ...plan.impactAnalysis.affectedProjects.map((project) => `- Project: ${project}`),
    ...plan.impactAnalysis.affectedFiles.map((file) => `- Expected file: ${file}`),
    "",
    "Validation commands:",
    "",
    ...commandLines(validationCommands),
    "",
    "Validation strategy:",
    plan.validationPlan.strategy,
    "",
    "Required validation evidence:",
    ...listLines(plan.validationPlan.requiredEvidence),
    "",
    "Safety rules:",
    "",
    ...listLines(safetyNotes),
    "",
    "Safety policy:",
    `- Policy: ${safetyPolicy.name} (${safetyPolicy.id})`,
    `- Blocked patterns: ${safetyPolicy.blockedPatterns.length}`,
    `- Secret redaction patterns: ${safetyPolicy.secretRedactionPatterns.length}`,
    "",
    "Repo context:",
    `- ${repoMap.summary.summary}`,
    `- Languages: ${repoMap.summary.primaryLanguages.join(", ") || "unknown"}`,
    `- Frameworks: ${repoMap.summary.primaryFrameworks.join(", ") || "unknown"}`,
    `- Repos: ${repoMap.summary.repoCount}`,
    `- Projects: ${repoMap.summary.projectCount}`,
    "",
    "Git checkpoint:",
    `- Created: ${gitCheckpoint.created ? "yes" : "no"}`,
    `- Message: ${gitCheckpoint.message}`,
    ...(gitCheckpoint.checkpointPath
      ? [`- Path: ${gitCheckpoint.checkpointPath}`]
      : []),
    ...(gitCheckpoint.head ? [`- HEAD: ${gitCheckpoint.head}`] : []),
    ...(gitCheckpoint.branch ? [`- Branch: ${gitCheckpoint.branch}`] : []),
    "",
    "Completion report required:",
    "- Changed files.",
    "- Tests added or updated.",
    "- Validation commands run and outcomes.",
    "- Deviations from plan, if any.",
    "- Follow-up risks or questions."
  ].join("\n");
}

function commandLines(commands: ValidationCommand[]): string[] {
  if (commands.length === 0) {
    return [
      "- No validation commands detected; explain what manual validation was used."
    ];
  }

  return commands.map((command) => {
    const cwd = command.cwd ? ` [cwd: ${command.cwd}]` : "";
    return `- ${command.name}${cwd}: \`${[command.command, ...command.args].join(" ")}\``;
  });
}

function listLines(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}

async function tryCopyToClipboard(text: string): Promise<ClipboardResult> {
  const candidates =
    process.platform === "darwin"
      ? [{ command: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ command: "clip", args: [] }]
        : [
            { command: "wl-copy", args: [] },
            { command: "xclip", args: ["-selection", "clipboard"] },
            { command: "xsel", args: ["--clipboard", "--input"] }
          ];
  const failures: string[] = [];

  for (const candidate of candidates) {
    const result = await runClipboardCommand(candidate.command, candidate.args, text);

    if (result.copied) {
      return result;
    }

    failures.push(result.message);
  }

  return {
    attempted: true,
    copied: false,
    message: `Clipboard copy unavailable: ${failures.join("; ")}`
  };
}

function runClipboardCommand(
  command: string,
  args: string[],
  text: string
): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        attempted: true,
        copied: false,
        message: `${command}: ${error.message}`
      });
    });
    child.on("close", (code) => {
      resolve({
        attempted: true,
        copied: code === 0,
        message:
          code === 0
            ? `Copied handoff prompt to clipboard with ${command}.`
            : `${command}: exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      });
    });
    child.stdin.end(text);
  });
}

function timestampId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}
