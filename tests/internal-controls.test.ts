import { access, mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDoctorReport, getDoctorText, runCli } from "../packages/cli/src/index.js";
import {
  ARTIFACT_DIRECTORY,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  writeJsonFile
} from "../packages/shared/src/index.js";
import {
  ArtifactCleanupService,
  AuditLogService,
  SafetyPolicyService
} from "../packages/validator/src/index.js";
import { describe, expect, it } from "vitest";

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

describe("Phase 20 internal team controls", () => {
  it("creates a local-first policy with approval gates, retention, and trust metadata", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-controls-policy-"));
    const service = new SafetyPolicyService();

    await service.init(repoRoot);
    const validation = await service.validate(repoRoot);

    expect(validation.ok).toBe(true);
    expect(validation.policy.telemetryEnabled).toBe(false);
    expect(validation.policy.localFirst).toBe(true);
    expect(validation.policy.requiredApprovalGates).toContain("handoff");
    expect(validation.policy.artifactRetention.enabled).toBe(true);
    expect(validation.policy.trustMetadata.localOnly).toBe(true);
  });

  it("cleans retained artifacts by policy while preserving latest aliases", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-controls-cleanup-"));
    const policyService = new SafetyPolicyService();
    await policyService.init(repoRoot);
    const policy = await policyService.load(repoRoot);
    policy.artifactRetention = {
      enabled: true,
      maxAgeDays: 1,
      maxRuns: 50,
      directories: ["plans"],
      dryRunDefault: true
    };
    await writeJsonFile(getArtifactFilePath(repoRoot, "policy"), policy);

    const plansDir = getArtifactDirectoryPath(repoRoot, "plans");
    await mkdir(plansDir, { recursive: true });
    const oldPlan = path.join(plansDir, "old-plan.json");
    const latestPlan = path.join(plansDir, "latest-plan.json");
    const freshPlan = path.join(plansDir, "fresh-plan.json");
    await writeFile(oldPlan, "{}", "utf8");
    await writeFile(latestPlan, "{}", "utf8");
    await writeFile(freshPlan, "{}", "utf8");
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(oldPlan, oldDate, oldDate);
    await utimes(latestPlan, oldDate, oldDate);

    const service = new ArtifactCleanupService();
    const dryRun = await service.cleanup({ startPath: repoRoot });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.candidates.map((candidate) => candidate.path)).toContain(oldPlan);
    expect(dryRun.candidates.map((candidate) => candidate.path)).not.toContain(
      latestPlan
    );
    await expect(access(oldPlan)).resolves.toBeUndefined();

    const applied = await service.cleanup({ startPath: repoRoot, dryRun: false });
    expect(applied.deleted.map((candidate) => candidate.path)).toContain(oldPlan);
    await expect(access(oldPlan)).rejects.toThrow();
    await expect(access(latestPlan)).resolves.toBeUndefined();
    await expect(access(freshPlan)).resolves.toBeUndefined();
  });

  it("redacts secrets in audit logs used by internal controls", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-controls-audit-"));
    await new SafetyPolicyService().init(repoRoot);
    await new AuditLogService().record(repoRoot, {
      action: "policy.validate",
      actor: "cli",
      summary: "TOKEN=super-secret-value",
      metadata: {
        header: "Authorization: Bearer super-secret-value"
      }
    });

    const auditText = await readFile(
      path.join(getArtifactDirectoryPath(repoRoot, "audit"), "audit.jsonl"),
      "utf8"
    );

    expect(auditText).toContain("[REDACTED]");
    expect(auditText).not.toContain("super-secret-value");
  });

  it("exposes useful doctor, status, policy, audit, and cleanup CLI controls", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-controls-cli-"));
    await writeFile(path.join(repoRoot, "package.json"), "{}", "utf8");
    const initCapture = createCapture();
    const statusCapture = createCapture();
    const cleanupCapture = createCapture();
    const policyCapture = createCapture();
    const auditCapture = createCapture();

    expect((await runCli(["init", "--path", repoRoot], initCapture.io)).exitCode).toBe(
      0
    );
    expect(
      (await runCli(["status", "--path", repoRoot, "--json"], statusCapture.io))
        .exitCode
    ).toBe(0);
    expect(
      (await runCli(["cleanup", "--path", repoRoot, "--dry-run"], cleanupCapture.io))
        .exitCode
    ).toBe(0);
    expect(
      (await runCli(["policy", "validate", "--path", repoRoot], policyCapture.io))
        .exitCode
    ).toBe(0);
    expect(
      (await runCli(["audit", "list", "--path", repoRoot], auditCapture.io)).exitCode
    ).toBe(0);

    const status = JSON.parse(statusCapture.stdout.join("\n"));
    expect(status.controls.telemetryEnabled).toBe(false);
    expect(status.controls.localFirst).toBe(true);
    expect(cleanupCapture.stdout.join("\n")).toContain("Mode: dry-run");
    expect(policyCapture.stdout.join("\n")).toContain("Blocked patterns:");
    expect(auditCapture.stdout.join("\n")).toContain("cleanup.run");
  });

  it("ships clone-friendly setup scripts and doctor guidance", async () => {
    const root = process.cwd();

    await expect(
      access(path.join(root, "scripts", "setup.sh"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "scripts", "setup.ps1"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "scripts", "check-env.sh"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "scripts", "check-env.ps1"))
    ).resolves.toBeUndefined();

    const doctorText = getDoctorText("v20.11.0");
    const report = getDoctorReport("v20.11.0");

    expect(doctorText).toContain("scripts/setup.sh");
    expect(doctorText).toContain("cleanup --dry-run");
    expect(report.status).toBe("ok");
    expect(ARTIFACT_DIRECTORY).toBe(".copilot-architect");
  });
});
