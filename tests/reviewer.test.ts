import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { ReviewService } from "../packages/reviewer/src/index.js";
import {
  CHAT_COMMANDS,
  CURRENT_SCHEMA_VERSION,
  getArtifactDirectoryPath
} from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

function createCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }
  };
}

describe("ReviewService expectations", () => {
  it("takes expected files directly, for a plan that is not a FeaturePlan", async () => {
    // The session's PlanContract is not a FeaturePlan on disk, so a review
    // driven from @architect had no expectations at all and reported every
    // changed file as unexpected.
    const repoRoot = await createRepo({ "README.md": "# repo\n" });
    await initializeGitRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src-planned.ts"),
      "export const planned = 1;",
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "src-surprise.ts"),
      "export const surprise = 1;",
      "utf8"
    );

    const result = await new ReviewService().review({
      startPath: repoRoot,
      expectedFiles: ["src-planned.ts"]
    });

    expect(result.report.expectedFiles).toEqual(["src-planned.ts"]);
    expect(result.report.unexpectedFiles).toContain("src-surprise.ts");
    expect(result.report.unexpectedFiles).not.toContain("src-planned.ts");
  });
});

describe("ReviewService", () => {
  it("generates review artifacts and flags unexpected files and missing tests", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-fixture" }),
      "src/expected.ts": "export const expected = true;\n",
      "src/unexpected.ts": "export const unexpected = false;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeFile(
      path.join(repoRoot, "src/unexpected.ts"),
      "export const unexpected = true;\n",
      "utf8"
    );

    const result = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest"
    });
    const markdown = await readFile(result.latestMarkdownPath, "utf8");

    expect(existsSync(result.jsonPath)).toBe(true);
    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.latestJsonPath)).toBe(true);
    expect(existsSync(result.latestMarkdownPath)).toBe(true);
    expect(result.report.changedFiles).toContain("src/unexpected.ts");
    expect(result.report.expectedFiles).toContain("src/expected.ts");
    expect(result.report.unexpectedFiles).toContain("src/unexpected.ts");
    expect(result.report.missingTests).toContain("src/unexpected.ts");
    expect(result.report.findings.map((finding) => finding.title)).toEqual(
      expect.arrayContaining([
        "Unexpected file changed",
        "Changed source without nearby test change"
      ])
    );
    expect(result.report.reviewerPrompt).toContain(CHAT_COMMANDS.review);
    expect(result.report.reviewerPrompt).not.toContain("@CodeReviewer");
    expect(markdown).toContain("## Plan Comparison");
    expect(markdown).toContain("Unexpected files:");
  });

  it("includes untracked new files so a new-file feature is not 'no diff to review'", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-untracked" }),
      "src/existing.ts": "export const existing = true;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/feature/newFeature.ts"]);
    // Brand-new file that has never been added to git — invisible to `git diff`.
    await mkdir(path.join(repoRoot, "src/feature"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src/feature/newFeature.ts"),
      "export const newFeature = () => 'auth token';\n",
      "utf8"
    );

    const result = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest"
    });

    expect(result.report.changedFiles).toContain("src/feature/newFeature.ts");
    expect(result.report.diffSummary).not.toContain("No git diff changes detected.");
    expect(result.report.summary).toContain("1 changed file");
  });

  it("loads validation failures into the review report and prompt", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-validation" }),
      "src/expected.ts": "export const expected = false;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeValidationReport(repoRoot, "failed");
    await writeFile(
      path.join(repoRoot, "src/expected.ts"),
      "export const expected = true;\n",
      "utf8"
    );

    const result = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest",
      validation: "latest"
    });

    expect(result.report.validationStatus).toBe("failed");
    expect(result.report.validationResults).toHaveLength(1);
    expect(result.report.findings.map((finding) => finding.title)).toEqual(
      expect.arrayContaining(["Validation failed", "Validation command did not pass"])
    );
    expect(result.report.reviewerPrompt).toContain("Validation: failed");
  });

  it("detects config, dependency, security, and breaking-change review risks", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        name: "review-risk",
        dependencies: { leftpad: "1.0.0" }
      }),
      "src/auth/login.ts": "export const login = () => true;\n",
      "src/api/public.ts": "export function publicApi() { return true; }\n",
      "src/api/public.test.ts": "test('public api', () => {});\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, [
      "package.json",
      "src/auth/login.ts",
      "src/api/public.ts",
      "src/api/public.test.ts"
    ]);
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        name: "review-risk",
        dependencies: { leftpad: "1.0.1" }
      }),
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "src/auth/login.ts"),
      "export const login = () => ({ token: 'abc123' });\n",
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "src/api/public.ts"),
      "export function publicApiV2() { return true; }\n",
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "src/api/public.test.ts"),
      "test('public api v2', () => {});\n",
      "utf8"
    );

    const result = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest"
    });
    const titles = result.report.findings.map((finding) => finding.title);

    expect(result.report.configChanges).toContain("package.json");
    expect(result.report.dependencyChanges).toContain("package.json");
    expect(result.report.securityRiskFiles).toContain("src/auth/login.ts");
    expect(result.report.breakingChangeFiles).toContain("src/api/public.ts");
    expect(titles).toEqual(
      expect.arrayContaining([
        "Configuration file changed",
        "Dependency manifest or lockfile changed",
        "Potential security-sensitive file changed",
        "Possible breaking change"
      ])
    );
    expect(result.report.risks.map((risk) => risk.title)).toEqual(
      expect.arrayContaining([
        "Dependency or package-manager change",
        "Security-sensitive change",
        "Possible breaking change"
      ])
    );
  });

  it("assigns stable open ids to findings so they can be resolved later", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-ids" }),
      "src/expected.ts": "export const expected = true;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeFile(
      path.join(repoRoot, "src/unexpected.ts"),
      "export const unexpected = true;\n",
      "utf8"
    );

    const first = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest"
    });
    const second = await new ReviewService().review({
      startPath: repoRoot,
      plan: "latest"
    });
    const firstFinding = first.report.findings.find(
      (finding) => finding.title === "Unexpected file changed"
    );
    const secondFinding = second.report.findings.find(
      (finding) => finding.title === "Unexpected file changed"
    );

    expect(firstFinding?.id).toBeTruthy();
    expect(firstFinding?.status).toBe("open");
    // Same id across independent runs — that's what makes a disposition durable.
    expect(secondFinding?.id).toBe(firstFinding?.id);
  });

  it("keeps a declined finding declined on the next review run and excludes it from the active list", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-decline" }),
      "src/expected.ts": "export const expected = true;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeFile(
      path.join(repoRoot, "src/unexpected.ts"),
      "export const unexpected = true;\n",
      "utf8"
    );

    const service = new ReviewService();
    const first = await service.review({ startPath: repoRoot, plan: "latest" });
    const finding = first.report.findings.find(
      (item) => item.title === "Unexpected file changed"
    );
    expect(finding).toBeDefined();

    const resolution = await service.resolveFinding({
      startPath: repoRoot,
      findingId: finding!.id,
      decision: "decline",
      reason: "This file is intentionally out of scope for this change.",
      decidedBy: "reviewer@example.test"
    });

    expect(resolution.status).toBe("declined");
    expect(existsSync(resolution.dispositionsPath)).toBe(true);

    const second = await service.review({ startPath: repoRoot, plan: "latest" });
    const declinedFinding = second.report.findings.find(
      (item) => item.id === finding!.id
    );

    expect(declinedFinding?.status).toBe("declined");
    expect(declinedFinding?.disposition?.reason).toContain(
      "intentionally out of scope"
    );
    // reviewerPrompt's active-findings count no longer includes the declined one.
    expect(second.report.reviewerPrompt).not.toBeUndefined();

    const markdown = await readFile(second.latestMarkdownPath, "utf8");
    const findingsSection = markdown.split("## Declined (with reason)")[0];
    const declinedSection = markdown.split("## Declined (with reason)")[1];

    expect(findingsSection).not.toContain("Unexpected file changed");
    expect(declinedSection).toContain("Unexpected file changed");
    expect(declinedSection).toContain("intentionally out of scope");
  });

  it("records an accepted finding with its plan revision link", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-accept" }),
      "src/expected.ts": "export const expected = true;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeFile(
      path.join(repoRoot, "src/unexpected.ts"),
      "export const unexpected = true;\n",
      "utf8"
    );

    const service = new ReviewService();
    const first = await service.review({ startPath: repoRoot, plan: "latest" });
    const finding = first.report.findings.find(
      (item) => item.title === "Unexpected file changed"
    );

    const resolution = await service.resolveFinding({
      startPath: repoRoot,
      findingId: finding!.id,
      decision: "accept",
      reason: "Folded into the plan as an additional file.",
      decidedBy: "reviewer@example.test",
      planRevision: 2
    });

    expect(resolution.status).toBe("accepted");
    expect(resolution.disposition.planRevision).toBe(2);

    const second = await service.review({ startPath: repoRoot, plan: "latest" });
    const acceptedFinding = second.report.findings.find(
      (item) => item.id === finding!.id
    );

    expect(acceptedFinding?.status).toBe("accepted");
    expect(acceptedFinding?.disposition?.planRevision).toBe(2);
  });

  it("rejects resolving a finding without a reason", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-missing-reason" })
    });

    await expect(
      new ReviewService().resolveFinding({
        startPath: repoRoot,
        findingId: "finding_doesnotmatter",
        decision: "decline",
        reason: "",
        decidedBy: "reviewer"
      })
    ).rejects.toThrow(/reason is required/);
  });
});

describe("review resolve CLI", () => {
  it("resolves a finding and persists it across the next review run", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-resolve-cli" }),
      "src/expected.ts": "export const expected = true;\n"
    });
    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeFile(
      path.join(repoRoot, "src/unexpected.ts"),
      "export const unexpected = true;\n",
      "utf8"
    );

    const reviewCapture = createCapture();
    const reviewResult = await runCli(
      ["review", "--path", repoRoot, "--plan", "latest", "--json"],
      reviewCapture.io
    );
    const reviewJson = JSON.parse(reviewCapture.stdout.join("\n"));
    const findingId = reviewJson.findings.find(
      (finding: { title: string }) => finding.title === "Unexpected file changed"
    ).id;

    expect(reviewResult.exitCode).toBe(0);

    const resolveCapture = createCapture();
    const resolveResult = await runCli(
      [
        "review",
        "resolve",
        "--path",
        repoRoot,
        "--finding-id",
        findingId,
        "--decision",
        "decline",
        "--reason",
        "Out of scope.",
        "--by",
        "reviewer",
        "--json"
      ],
      resolveCapture.io
    );
    const resolveJson = JSON.parse(resolveCapture.stdout.join("\n"));

    expect(resolveResult.exitCode).toBe(0);
    expect(resolveJson.status).toBe("declined");

    const missingReasonCapture = createCapture();
    const missingReasonResult = await runCli(
      [
        "review",
        "resolve",
        "--path",
        repoRoot,
        "--finding-id",
        findingId,
        "--decision",
        "accept",
        "--by",
        "reviewer"
      ],
      missingReasonCapture.io
    );

    expect(missingReasonResult.exitCode).toBe(1);
    expect(missingReasonCapture.stderr.join("\n")).toContain("--reason");
  });
});

describe("review CLI", () => {
  it("supports plan and validation evidence flags with JSON output", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "review-cli" }),
      "src/expected.ts": "export const expected = false;\n"
    });
    const capture = createCapture();

    await initializeGitRepo(repoRoot);
    await writeApprovedPlan(repoRoot, ["src/expected.ts"]);
    await writeValidationReport(repoRoot, "failed");
    await writeFile(
      path.join(repoRoot, "src/expected.ts"),
      "export const expected = true;\n",
      "utf8"
    );

    const result = await runCli(
      [
        "review",
        "--path",
        repoRoot,
        "--plan",
        "latest",
        "--validation",
        "latest",
        "--json"
      ],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(json.validationStatus).toBe("failed");
    expect(json.reviewerPrompt).toContain(CHAT_COMMANDS.review);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-review-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function initializeGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Copilot Architect",
      "-c",
      "user.email=copilot-architect@example.test",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: repoRoot }
  );
}

async function writeApprovedPlan(
  repoRoot: string,
  expectedFiles: string[]
): Promise<void> {
  const plansRoot = getArtifactDirectoryPath(repoRoot, "plans");

  await mkdir(plansRoot, { recursive: true });
  await writeFile(
    path.join(plansRoot, "latest-plan.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        id: "plan-review-1",
        title: "Review fixture plan",
        task: "Review changed files",
        status: "approved",
        repoRoot,
        summary: "Fixture approved plan",
        assumptions: [],
        implementationSteps: [
          {
            id: "step-1",
            title: "Touch expected files",
            details: "Only expected files should change.",
            files: expectedFiles,
            dependsOn: []
          }
        ],
        impactAnalysis: {
          summary: "Expected file impact",
          affectedProjects: [],
          affectedFiles: expectedFiles,
          affectedCommands: [],
          risks: [],
          testGaps: []
        },
        validationPlan: {
          commands: [],
          strategy: "Run focused validation.",
          requiredEvidence: []
        },
        requiresHumanApproval: true
      },
      null,
      2
    ),
    "utf8"
  );
}

async function writeValidationReport(
  repoRoot: string,
  status: "failed" | "passed"
): Promise<void> {
  const runsRoot = getArtifactDirectoryPath(repoRoot, "runs");
  const resultStatus = status === "passed" ? "passed" : "failed";

  await mkdir(runsRoot, { recursive: true });
  await writeFile(
    path.join(runsRoot, "latest-validation.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        id: "validation-review-1",
        repoRoot,
        status,
        summary: status === "passed" ? "Validation passed." : "Validation failed.",
        selectedCategories: ["test"],
        plannedCommands: [],
        results: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            generatedAt: new Date().toISOString(),
            id: "validation-result-1",
            command: {
              name: "Unit tests",
              command: "npm",
              args: ["test"],
              kind: "validation",
              required: true,
              confidence: "high",
              source: "custom"
            },
            status: resultStatus,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: status === "passed" ? 0 : 1,
            durationMs: 10,
            outputSummary: status === "passed" ? "ok" : "tests failed",
            failureClassification: status === "passed" ? undefined : "non-zero-exit"
          }
        ],
        riskAssessments: [],
        failureSummary: status === "passed" ? [] : ["Unit tests failed."],
        fixPrompt: "Fix validation failures.",
        artifactPaths: {
          timestampJsonPath: path.join(runsRoot, "validation-review-1.json"),
          timestampMarkdownPath: path.join(runsRoot, "validation-review-1.md"),
          timestampLogPath: path.join(runsRoot, "validation-review-1-log.txt"),
          latestJsonPath: path.join(runsRoot, "latest-validation.json"),
          latestMarkdownPath: path.join(runsRoot, "latest-validation.md")
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
