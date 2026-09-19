import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepoDiscoveryService } from "@copilot-architect/core";
import {
  CHAT_COMMANDS,
  CURRENT_SCHEMA_VERSION,
  type InstructionGenerationResult,
  type RepoMap,
  type UniversalRepoMap,
  createTrustMetadata,
  getArtifactDirectoryPath,
  writeJsonFile
} from "@copilot-architect/shared";

export interface InstructionServiceOptions {
  startPath?: string;
  outputPath?: string;
}

export interface InstructionPreviewResult {
  repoRoot: string;
  outputPath: string;
  markdown: string;
  skills: SkillPreviewResult[];
  prompts: PromptPreviewResult[];
  repoMap: UniversalRepoMap;
}

export interface SkillPreviewResult {
  id: string;
  outputPath: string;
  markdown: string;
}

export interface SkillGenerationResult extends SkillPreviewResult {
  status: "generated" | "updated";
  backupPath?: string;
}

export interface PromptPreviewResult {
  id: string;
  outputPath: string;
  markdown: string;
}

export interface PromptGenerationResult extends PromptPreviewResult {
  status: "generated" | "updated";
  backupPath?: string;
}

export interface InstructionGenerationSummary extends InstructionGenerationResult {
  skills: SkillGenerationResult[];
  prompts: PromptGenerationResult[];
  preservedUserContent: boolean;
}

export interface InstructionValidationFileResult {
  filePath: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface InstructionValidationResult {
  ok: boolean;
  checkedPath: string;
  skillsPath: string;
  promptsPath: string;
  files: InstructionValidationFileResult[];
  messages: string[];
}

interface SkillDefinition {
  id: string;
  directoryName: string;
  title: string;
  description: string;
  whenToUse: string[];
  workflow: string[];
  artifacts: string[];
}

interface PromptDefinition {
  id: string;
  fileName: string;
  name: string;
  description: string;
  agent: string;
  argumentHint: string;
  body: string[];
}

const generatedStart = "<!-- copilot-architect:generated:start -->";
const generatedEnd = "<!-- copilot-architect:generated:end -->";

const requiredInstructionHeadings = [
  "## Repo Architecture Summary",
  "## Detected Languages",
  "## Frameworks",
  "## Package Managers",
  "## Build Commands",
  "## Test Commands",
  "## Lint And Format Commands",
  "## Coding Conventions",
  "## Safety Rules",
  "## Trust Metadata",
  "## Planning Workflow",
  "## Approval Workflow",
  "## Validation Workflow",
  "## Review Workflow"
];

const skillDefinitions: SkillDefinition[] = [
  {
    id: "feature-planning",
    directoryName: "feature-planning",
    title: "Feature Planning",
    description:
      "Create repo-aware implementation plans from high-level feature requests.",
    whenToUse: [
      "Use when a user asks for a feature plan or implementation approach.",
      "Use before creating an implementation handoff."
    ],
    workflow: [
      "Read `.copilot-architect/repo-map.json` and `.copilot-architect/index/` first.",
      "Search for similar files and feature patterns.",
      "Produce impacted files, risks, validation commands, and open questions.",
      "Stop for human approval before implementation."
    ],
    artifacts: [
      ".copilot-architect/plans/latest-plan.md",
      ".copilot-architect/plans/latest-plan.json"
    ]
  },
  {
    id: "repo-analysis",
    directoryName: "repo-analysis",
    title: "Repo Analysis",
    description:
      "Use Copilot Architect repo maps and indexes to understand repository structure.",
    whenToUse: [
      "Use when orienting to an unfamiliar repository.",
      "Use when explaining languages, frameworks, commands, or architecture."
    ],
    workflow: [
      "Run or read repo analysis before making claims.",
      "Prefer detected adapters and repo-map data over assumptions.",
      "Call out unknown or generic fallback areas explicitly."
    ],
    artifacts: [
      ".copilot-architect/repo-map.json",
      ".copilot-architect/workspace.json",
      ".copilot-architect/index/"
    ]
  },
  {
    id: "validation",
    directoryName: "validation",
    title: "Validation",
    description: "Run and interpret safe build, test, lint, and format validation.",
    whenToUse: [
      "Use after implementation changes.",
      "Use when build, test, lint, or format evidence is needed."
    ],
    workflow: [
      "Use detected and custom commands from `.copilot-architect/commands.json`.",
      "Respect policy checks before executing commands.",
      "Summarize passed, failed, blocked, and timed-out commands.",
      "Preserve log evidence under `.copilot-architect/runs/`."
    ],
    artifacts: [
      ".copilot-architect/commands.json",
      ".copilot-architect/policy.json",
      ".copilot-architect/runs/latest-validation.json"
    ]
  },
  {
    id: "code-review",
    directoryName: "code-review",
    title: "Code Review",
    description:
      "Review diffs against approved plans, validation evidence, and safety expectations.",
    whenToUse: [
      "Use after implementation and validation.",
      "Use when a user asks for review findings or release risk."
    ],
    workflow: [
      "Compare git diff to the latest approved plan and handoff.",
      "Prioritize correctness, missing tests, validation failures, security, and performance risks.",
      "Produce actionable findings with file paths where possible."
    ],
    artifacts: [
      ".copilot-architect/plans/latest-plan.json",
      ".copilot-architect/handoffs/latest-handoff.md",
      ".copilot-architect/reviews/latest-review.md"
    ]
  },
  {
    id: "debugging",
    directoryName: "debugging",
    title: "Debugging",
    description: "Analyze validation failures and propose minimal fixes.",
    whenToUse: [
      "Use when a validation command fails or times out.",
      "Use when the user asks for a fix prompt based on logs."
    ],
    workflow: [
      "Start from the latest validation report and redacted logs.",
      "Classify the failure before proposing changes.",
      "Suggest the smallest likely fix and the command to rerun."
    ],
    artifacts: [
      ".copilot-architect/runs/latest-validation.json",
      ".copilot-architect/runs/",
      ".copilot-architect/diagnostics/"
    ]
  }
];

const promptDefinitions: PromptDefinition[] = [
  {
    id: "copilot-architect-plan",
    fileName: "copilot-architect-plan.prompt.md",
    name: "copilot-architect-plan",
    description: "Plan a feature with Copilot Architect repo intelligence.",
    agent: "architect",
    argumentHint: "feature request",
    body: [
      `${CHAT_COMMANDS.plan} Add ${"${input:feature:feature request}"} based on this repo.`,
      "Use Copilot Architect repo map, index, MCP tools, and latest generated plan.",
      "Do not modify code yet. First create a detailed implementation plan.",
      "Include impacted files, similar feature patterns, risks, tests, validation commands, and open questions."
    ]
  },
  {
    id: "copilot-architect-implement",
    fileName: "copilot-architect-implement.prompt.md",
    name: "copilot-architect-implement",
    description: "Implement an approved Copilot Architect plan.",
    agent: "architect",
    argumentHint: "optional implementation notes",
    body: [
      `${CHAT_COMMANDS.implement} Implement the approved plan from .copilot-architect/plans/latest-plan.md.`,
      "Use .copilot-architect/handoffs/latest-handoff.md when it exists.",
      "Keep changes scoped to the approved plan, update or add focused tests, run validation commands, and summarize changed files.",
      "Do not expand scope without human approval."
    ]
  },
  {
    id: "copilot-architect-review",
    fileName: "copilot-architect-review.prompt.md",
    name: "copilot-architect-review",
    description: "Review implementation against plan and validation evidence.",
    agent: "architect",
    argumentHint: "optional review focus",
    body: [
      `${CHAT_COMMANDS.review} Review the git diff against the approved plan and latest validation report.`,
      "Prioritize bugs, missing tests, behavioral regressions, validation failures, security risks, and unexpected scope.",
      "Use .copilot-architect/reviews/latest-review.md when available and produce actionable findings."
    ]
  },
  {
    id: "copilot-architect-debug",
    fileName: "copilot-architect-debug.prompt.md",
    name: "copilot-architect-debug",
    description: "Debug failed validation evidence from Copilot Architect.",
    agent: "architect",
    argumentHint: "failing command or symptom",
    body: [
      `${CHAT_COMMANDS.review} Validation failed.`,
      "Use .copilot-architect/runs/latest-validation.json and related logs to classify the failure.",
      "Propose the smallest safe fix, identify files to inspect, and name the validation command to rerun.",
      "Do not mask failures by deleting tests or loosening validation without approval."
    ]
  }
];

export class InstructionService {
  async preview(
    options: InstructionServiceOptions = {}
  ): Promise<InstructionPreviewResult> {
    const repoRoot = resolveStartPath(options.startPath);
    const outputPath = resolveOutputPath(repoRoot, options.outputPath);
    const repoMap = await ensureRepoMap(repoRoot);
    const existing = await tryReadText(outputPath);
    const preserved = extractUserAuthoredContent(existing);
    const generated = renderInstructions(repoMap);

    return {
      repoRoot,
      outputPath,
      markdown: wrapGenerated(generated, preserved),
      skills: skillDefinitions.map((definition) => ({
        id: definition.id,
        outputPath: resolveSkillPath(repoRoot, definition),
        markdown: renderSkill(definition, repoMap)
      })),
      prompts: promptDefinitions.map((definition) => ({
        id: definition.id,
        outputPath: resolvePromptPath(repoRoot, definition),
        markdown: renderPrompt(definition, repoMap)
      })),
      repoMap
    };
  }

  async generate(
    options: InstructionServiceOptions = {}
  ): Promise<InstructionGenerationSummary> {
    const preview = await this.preview(options);
    const resultPath = path.join(
      getArtifactDirectoryPath(preview.repoRoot, "diagnostics"),
      "instruction-generation-result.json"
    );
    const backupPath = await backupIfExists(preview.outputPath);
    const skills: SkillGenerationResult[] = [];
    const prompts: PromptGenerationResult[] = [];

    await mkdir(path.dirname(preview.outputPath), { recursive: true });
    await writeFile(preview.outputPath, preview.markdown, "utf8");

    for (const skill of preview.skills) {
      const skillBackupPath = await backupIfExists(skill.outputPath);
      await mkdir(path.dirname(skill.outputPath), { recursive: true });
      await writeFile(skill.outputPath, skill.markdown, "utf8");
      skills.push({
        ...skill,
        status: skillBackupPath ? "updated" : "generated",
        backupPath: skillBackupPath
      });
    }

    for (const prompt of preview.prompts) {
      const promptBackupPath = await backupIfExists(prompt.outputPath);
      await mkdir(path.dirname(prompt.outputPath), { recursive: true });
      await writeFile(prompt.outputPath, prompt.markdown, "utf8");
      prompts.push({
        ...prompt,
        status: promptBackupPath ? "updated" : "generated",
        backupPath: promptBackupPath
      });
    }

    const result: InstructionGenerationSummary = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      trust: createTrustMetadata({
        artifactKind: "copilot-instructions",
        source: preview.outputPath
      }),
      target: "copilot-instructions",
      status: backupPath ? "updated" : "generated",
      outputPath: preview.outputPath,
      backupPath,
      skills,
      prompts,
      preservedUserContent: preview.markdown.includes("## Preserved User Notes"),
      messages: [
        "Generated repo-aware Copilot instructions.",
        `Generated ${skills.length} skill file(s).`,
        `Generated ${prompts.length} Copilot Chat prompt file(s).`,
        backupPath
          ? "Existing instructions were backed up before overwrite."
          : "No existing instructions needed backup."
      ]
    };

    await writeJsonFile(resultPath, result);

    return result;
  }

  async validate(
    options: InstructionServiceOptions = {}
  ): Promise<InstructionValidationResult> {
    const repoRoot = resolveStartPath(options.startPath);
    const checkedPath = resolveOutputPath(repoRoot, options.outputPath);
    const skillsPath = path.join(repoRoot, ".github", "skills");
    const promptsPath = path.join(repoRoot, ".github", "prompts");
    const files = [
      await validateInstructionFile(checkedPath),
      ...(await Promise.all(
        skillDefinitions.map((definition) =>
          validateSkillFile(resolveSkillPath(repoRoot, definition))
        )
      )),
      ...(await Promise.all(
        promptDefinitions.map((definition) =>
          validatePromptFile(resolvePromptPath(repoRoot, definition))
        )
      ))
    ];

    return {
      ok: files.every((file) => file.ok),
      checkedPath,
      skillsPath,
      promptsPath,
      files,
      messages: [
        `Checked instructions file, ${skillDefinitions.length} skill file(s), and ${promptDefinitions.length} prompt file(s).`,
        `${files.filter((file) => file.ok).length} valid, ${files.filter((file) => !file.ok).length} invalid.`
      ]
    };
  }
}

async function ensureRepoMap(startPath: string): Promise<UniversalRepoMap> {
  return (await new RepoDiscoveryService().analyze({ startPath })).repoMap;
}

function renderInstructions(repoMap: UniversalRepoMap): string {
  const repo = repoMap.repos[0];
  const generatedAt = new Date().toISOString();
  const trust = createTrustMetadata({
    artifactKind: "copilot-instructions",
    source: ".github/copilot-instructions.md"
  });

  return [
    "# Copilot Instructions",
    "",
    `Generated by Copilot Architect at ${generatedAt}.`,
    `Source repo-map schema: ${repoMap.schemaVersion}.`,
    `Source repo-map generated at: ${repoMap.generatedAt}.`,
    "",
    "## Repo Architecture Summary",
    "",
    repoMap.summary.summary,
    `Repos: ${repoMap.summary.repoCount}. Projects: ${repoMap.summary.projectCount}.`,
    "",
    "## Detected Languages",
    "",
    listOrFallback(repoMap.summary.primaryLanguages),
    "",
    "## Frameworks",
    "",
    listOrFallback(repoMap.summary.primaryFrameworks),
    "",
    "## Package Managers",
    "",
    listOrFallback(
      unique(
        repoMap.repos.flatMap((entry) => entry.packageManagers.map((item) => item.name))
      )
    ),
    "",
    "## Build Commands",
    "",
    commandList(repo, "build"),
    "",
    "## Test Commands",
    "",
    commandList(repo, "test"),
    "",
    "## Lint And Format Commands",
    "",
    [
      commandList(repo, "lint", "No lint commands detected."),
      commandList(repo, "format", "No format commands detected.")
    ].join("\n"),
    "",
    "## Coding Conventions",
    "",
    codingConventions(repo),
    "",
    "## Safety Rules",
    "",
    [
      "- Treat analysis as read-only unless explicitly asked to write artifacts.",
      "- Do not run dangerous commands such as `rm -rf`, `git reset --hard`, or `git clean -fdx`.",
      "- Never write outside the repository or workspace root.",
      "- Never print secrets; rely on redacted validation logs.",
      "- Store Copilot Architect evidence under `.copilot-architect/`."
    ].join("\n"),
    "",
    "## Trust Metadata",
    "",
    [
      `- Generated by: ${trust.generatedBy}`,
      `- Policy: ${trust.policyId}`,
      `- Local only: ${trust.localOnly ? "yes" : "no"}`,
      `- Telemetry enabled: ${trust.telemetryEnabled ? "yes" : "no"}`
    ].join("\n"),
    "",
    "## Planning Workflow",
    "",
    [
      "- Analyze the repo and workspace before implementation.",
      "- Search for similar features and existing patterns.",
      "- Generate a plan under `.copilot-architect/plans/`.",
      "- Include impacted files, risks, tests, and validation commands."
    ].join("\n"),
    "",
    "## Approval Workflow",
    "",
    [
      "- Stop after planning and request human approval.",
      "- Generate implementation handoff only after approval.",
      `- Use \`${CHAT_COMMANDS.implement}\` only with an approved plan.`
    ].join("\n"),
    "",
    "## Validation Workflow",
    "",
    [
      "- Run focused tests for changed modules first.",
      "- Run detected build/test/lint/format commands when available.",
      "- Save validation evidence under `.copilot-architect/runs/`.",
      "- Classify failures before proposing fixes."
    ].join("\n"),
    "",
    "## Review Workflow",
    "",
    [
      "- Compare git diff to the approved plan and handoff.",
      "- Flag unexpected changes, missing tests, validation failures, security risks, and performance risks.",
      "- Save review evidence under `.copilot-architect/reviews/`."
    ].join("\n")
  ].join("\n");
}

function renderSkill(definition: SkillDefinition, repoMap: UniversalRepoMap): string {
  const trust = createTrustMetadata({
    artifactKind: "copilot-skill",
    source: `.github/skills/${definition.directoryName}/SKILL.md`
  });

  return [
    `# ${definition.title}`,
    "",
    definition.description,
    "",
    `Generated by Copilot Architect from repo-map schema ${repoMap.schemaVersion}.`,
    "",
    "## When To Use",
    "",
    ...definition.whenToUse.map((item) => `- ${item}`),
    "",
    "## Workflow",
    "",
    ...definition.workflow.map((item) => `- ${item}`),
    "",
    "## Repo Context",
    "",
    `- ${repoMap.summary.summary}`,
    `- Languages: ${repoMap.summary.primaryLanguages.join(", ") || "unknown"}`,
    `- Frameworks: ${repoMap.summary.primaryFrameworks.join(", ") || "unknown"}`,
    "",
    "## Artifacts",
    "",
    ...definition.artifacts.map((artifact) => `- \`${artifact}\``),
    "",
    "## Safety",
    "",
    "- Keep writes inside the workspace root.",
    "- Do not expose secrets.",
    "- Respect `.copilot-architect/policy.json`.",
    "",
    "## Trust Metadata",
    "",
    `- Generated by: ${trust.generatedBy}`,
    `- Policy: ${trust.policyId}`,
    `- Local only: ${trust.localOnly ? "yes" : "no"}`,
    `- Telemetry enabled: ${trust.telemetryEnabled ? "yes" : "no"}`
  ].join("\n");
}

function renderPrompt(definition: PromptDefinition, repoMap: UniversalRepoMap): string {
  return [
    "---",
    `name: ${definition.name}`,
    `description: ${JSON.stringify(definition.description)}`,
    `agent: ${definition.agent}`,
    `argument-hint: ${JSON.stringify(definition.argumentHint)}`,
    "tools:",
    "  - copilotArchitect/*",
    "---",
    "",
    ...definition.body,
    "",
    "Use these local artifacts when available:",
    "",
    "- `.copilot-architect/repo-map.json`",
    "- `.copilot-architect/index/`",
    "- `.copilot-architect/plans/latest-plan.md`",
    "- `.copilot-architect/handoffs/latest-handoff.md`",
    "- `.copilot-architect/runs/latest-validation.json`",
    "- `.copilot-architect/reviews/latest-review.md`",
    "",
    `Repo context: ${repoMap.summary.summary}`,
    "",
    "Copilot Architect provides local repo context and MCP tools; it does not modify Copilot internals."
  ].join("\n");
}

function wrapGenerated(
  generated: string,
  preservedUserContent: string | undefined
): string {
  const generatedBlock = [generatedStart, generated, generatedEnd].join("\n");

  if (!preservedUserContent) {
    return `${generatedBlock}\n`;
  }

  return [
    generatedBlock,
    "",
    "## Preserved User Notes",
    "",
    "The content below existed outside the Copilot Architect generated block and was preserved during regeneration.",
    "",
    preservedUserContent.trim(),
    ""
  ].join("\n");
}

function extractUserAuthoredContent(existing: string | undefined): string | undefined {
  if (!existing?.trim()) {
    return undefined;
  }

  const start = existing.indexOf(generatedStart);
  const end = existing.indexOf(generatedEnd);

  if (start === -1 || end === -1 || end < start) {
    return existing.trim();
  }

  const before = existing.slice(0, start).trim();
  const after = existing.slice(end + generatedEnd.length).trim();
  const preserved = [before, after].filter(Boolean).join("\n\n").trim();

  return preserved || undefined;
}

async function validateInstructionFile(
  filePath: string
): Promise<InstructionValidationFileResult> {
  const text = await tryReadText(filePath);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!text) {
    return {
      filePath,
      ok: false,
      errors: ["Instruction file is missing."],
      warnings
    };
  }

  for (const heading of requiredInstructionHeadings) {
    if (!text.includes(heading)) {
      errors.push(`Missing required section ${heading}.`);
    }
  }

  for (const required of [
    "Generated by Copilot Architect",
    "Source repo-map schema",
    ".copilot-architect/",
    "Telemetry enabled: no"
  ]) {
    if (!text.includes(required)) {
      errors.push(`Missing required content: ${required}.`);
    }
  }

  if (!text.includes(generatedStart) || !text.includes(generatedEnd)) {
    warnings.push("Generated block markers are missing.");
  }

  return {
    filePath,
    ok: errors.length === 0,
    errors,
    warnings
  };
}

async function validateSkillFile(
  filePath: string
): Promise<InstructionValidationFileResult> {
  const text = await tryReadText(filePath);
  const errors: string[] = [];

  if (!text) {
    return {
      filePath,
      ok: false,
      errors: ["Skill file is missing."],
      warnings: []
    };
  }

  for (const heading of [
    "## When To Use",
    "## Workflow",
    "## Artifacts",
    "## Safety",
    "## Trust Metadata"
  ]) {
    if (!text.includes(heading)) {
      errors.push(`Missing required section ${heading}.`);
    }
  }

  if (!text.includes(".copilot-architect/")) {
    errors.push("Missing references to .copilot-architect artifacts.");
  }

  return {
    filePath,
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

async function validatePromptFile(
  filePath: string
): Promise<InstructionValidationFileResult> {
  const text = await tryReadText(filePath);
  const errors: string[] = [];

  if (!text) {
    return {
      filePath,
      ok: false,
      errors: ["Prompt file is missing."],
      warnings: []
    };
  }

  for (const required of [
    "name:",
    "description:",
    "agent:",
    "tools:",
    "copilotArchitect/*",
    ".copilot-architect/",
    "does not modify Copilot internals"
  ]) {
    if (!text.includes(required)) {
      errors.push(`Missing required content: ${required}.`);
    }
  }

  if (!path.basename(filePath).endsWith(".prompt.md")) {
    errors.push("Prompt file should use the .prompt.md suffix.");
  }

  return {
    filePath,
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

async function backupIfExists(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath);
  } catch {
    return undefined;
  }

  const backupPath = `${filePath}.${timestampId()}.bak`;
  const content = await readFile(filePath, "utf8");
  await writeFile(backupPath, content, "utf8");
  return backupPath;
}

async function tryReadText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveOutputPath(repoRoot: string, outputPath?: string): string {
  if (outputPath) {
    return path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(repoRoot, outputPath);
  }

  return path.join(repoRoot, ".github", "copilot-instructions.md");
}

function resolveSkillPath(repoRoot: string, definition: SkillDefinition): string {
  return path.join(repoRoot, ".github", "skills", definition.directoryName, "SKILL.md");
}

function resolvePromptPath(repoRoot: string, definition: PromptDefinition): string {
  return path.join(repoRoot, ".github", "prompts", definition.fileName);
}

function resolveStartPath(startPath?: string): string {
  return path.resolve(startPath ?? process.cwd());
}

function commandList(
  repo: RepoMap | undefined,
  key: "build" | "test" | "lint" | "format",
  fallback = `No ${key} commands detected.`
): string {
  const commands = repo?.commands[key] ?? [];

  if (commands.length === 0) {
    return `- ${fallback}`;
  }

  return commands
    .map((command) => {
      const cwd = command.cwd ? ` [cwd: ${command.cwd}]` : "";
      return `- ${command.name}${cwd}: \`${[command.command, ...command.args].join(" ")}\``;
    })
    .join("\n");
}

function codingConventions(repo: RepoMap | undefined): string {
  const patterns = repo?.architecturalPatterns ?? [];
  const configFiles = unique(
    repo?.projects.flatMap((project) => project.configFiles) ?? []
  );
  const lines = [
    ...patterns.map((pattern) => `- Follow detected pattern: ${pattern}.`),
    ...configFiles.slice(0, 8).map((file) => `- Respect config file \`${file}\`.`)
  ];

  if (lines.length === 0) {
    lines.push("- Follow nearby code style, naming, imports, and test patterns.");
  }

  return lines.join("\n");
}

function listOrFallback(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- unknown";
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items)).sort((left, right) => left.localeCompare(right));
}

function timestampId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}
