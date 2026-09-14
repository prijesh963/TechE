import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  AuditLogService,
  CommandRiskAssessmentService,
  GitCheckpointService,
  PathBoundaryService,
  SafetyPolicyService,
  SecretRedactionService
} from "../packages/validator/src/index.js";
import { getArtifactFilePath } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

describe("Safety policy and audit services", () => {
  it("initializes and validates the default safety policy", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-policy-"));
    const service = new SafetyPolicyService();
    const init = await service.init(repoRoot);
    const validation = await service.validate(repoRoot);

    expect(init.created).toBe(true);
    expect(validation.ok).toBe(true);
    expect(validation.policy.blockedPatterns.length).toBeGreaterThan(0);
    expect(validation.policy.requireApprovalForHandoff).toBe(true);
  });

  it("reports invalid policy regex patterns", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-policy-bad-"));
    await mkdir(path.join(repoRoot, ".copilot-architect"), { recursive: true });
    await writeFile(
      getArtifactFilePath(repoRoot, "policy"),
      JSON.stringify({
        schemaVersion: "0.1.0",
        generatedAt: new Date().toISOString(),
        id: "bad",
        name: "Bad",
        defaultAllow: true,
        blockedPatterns: ["["],
        allowedPatterns: [],
        secretRedactionPatterns: [],
        requireApprovalForHandoff: true,
        workspaceBoundaryRequired: true
      }),
      "utf8"
    );

    const validation = await new SafetyPolicyService().validate(repoRoot);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("Invalid regular expression");
  });

  it("redacts secrets and records audit entries", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-audit-"));
    const redaction = new SecretRedactionService().redact(
      "TOKEN=abc Bearer secret ghp_123456"
    );
    const audit = new AuditLogService();
    const entry = await audit.record(repoRoot, {
      action: "test.action",
      actor: "cli",
      summary: "TOKEN=abc",
      metadata: { token: "Bearer secret" }
    });
    const listed = await audit.list(repoRoot);
    const auditText = await readFile(listed.auditPath, "utf8");

    expect(redaction.text).toContain("TOKEN=[REDACTED]");
    expect(redaction.text).toContain("Bearer [REDACTED]");
    expect(redaction.text).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(entry.redactionsApplied.length).toBeGreaterThan(0);
    expect(listed.entries).toHaveLength(1);
    expect(auditText).not.toContain("Bearer secret");
  });

  it("redacts expanded secret patterns including AWS and Stripe keys", () => {
    const service = new SecretRedactionService();

    // AWS access key ID
    const awsKey = service.redact("AKIAIOSFODNN7EXAMPLE is the access key");
    expect(awsKey.text).not.toContain("AKIAIOSFODNN7EXAMPLE");

    // Stripe secret key — built programmatically so the literal doesn't trigger source scanners
    const stripeVal = ["sk", "live", "51ABCDEFghijklmnopqrstuvwx"].join("_");
    const stripeKey = service.redact(stripeVal);
    expect(stripeKey.text).not.toContain("sk_live_");

    // JWT token
    const jwt = service.redact(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    );
    expect(jwt.text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");

    // PEM private key marker
    const pem = service.redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...");
    expect(pem.text).not.toContain("BEGIN RSA PRIVATE KEY");

    // Database connection string
    const connStr = service.redact("postgres://user:p4ssw0rd@db.example.com:5432/prod");
    expect(connStr.text).not.toContain("p4ssw0rd");

    // Slack token — built programmatically so the literal doesn't trigger source scanners
    const slackVal =
      "token=" + ["xox" + "b", "1234567890", "abcdefghijklmnopqrstuvwx"].join("-");
    const slackToken = service.redact(slackVal);
    expect(slackToken.text).not.toContain("xoxb-");
  });

  it("allows modern toolchain executables beyond the original safe set", () => {
    const service = new CommandRiskAssessmentService();
    const repoRoot = "/workspace";
    const policy = {
      blockedPatterns: [],
      allowedPatterns: [],
      workspaceBoundaryRequired: false
    } as unknown as Parameters<typeof service.assess>[2];

    const bunResult = service.assess(
      repoRoot,
      {
        kind: "test",
        name: "Bun test",
        command: "bun",
        args: ["test"],
        confidence: "high",
        source: "package.json scripts"
      },
      policy
    );
    expect(bunResult.allowed).toBe(true);

    const cargoResult = service.assess(
      repoRoot,
      {
        kind: "test",
        name: "Cargo test",
        command: "cargo",
        args: ["test"],
        confidence: "high",
        source: "package.json scripts"
      },
      policy
    );
    expect(cargoResult.allowed).toBe(true);

    const goResult = service.assess(
      repoRoot,
      {
        kind: "test",
        name: "Go test",
        command: "go",
        args: ["test", "./..."],
        confidence: "high",
        source: "package.json scripts"
      },
      policy
    );
    expect(goResult.allowed).toBe(true);

    const python3Result = service.assess(
      repoRoot,
      {
        kind: "test",
        name: "Python3 test",
        command: "python3",
        args: ["-m", "pytest"],
        confidence: "high",
        source: "package.json scripts"
      },
      policy
    );
    expect(python3Result.allowed).toBe(true);
  });

  it("does not let an allowlist entry waive a hard block or boundary violation", () => {
    const service = new CommandRiskAssessmentService();
    const repoRoot = "/workspace";
    const policy = {
      blockedPatterns: [String.raw`\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)`],
      // Even a permissive allowlist must not re-enable a destructive command.
      allowedPatterns: [".*"],
      workspaceBoundaryRequired: true
    } as unknown as Parameters<typeof service.assess>[2];

    const destructive = service.assess(
      repoRoot,
      {
        kind: "validation",
        name: "danger",
        command: "rm",
        args: ["-rf", "node_modules"],
        confidence: "high",
        source: "commands.json"
      },
      policy
    );

    expect(destructive.allowed).toBe(false);
    expect(destructive.riskLevel).toBe("blocked");
    expect(destructive.matchedRules).toContain("rm-rf");
  });

  it("flags git push -f as a soft git-history-warning concern", () => {
    const service = new CommandRiskAssessmentService();
    const repoRoot = "/workspace";
    const policy = {
      blockedPatterns: [],
      allowedPatterns: [],
      workspaceBoundaryRequired: false
    } as unknown as Parameters<typeof service.assess>[2];

    for (const args of [
      ["-f", "origin", "main"],
      ["--force", "origin"],
      ["--force-with-lease"]
    ]) {
      const result = service.assess(
        repoRoot,
        {
          kind: "validation",
          name: "force push",
          command: "git",
          args: ["push", ...args],
          confidence: "high",
          source: "commands.json"
        },
        policy
      );
      expect(result.allowed).toBe(false);
      expect(result.matchedRules).toContain("git-history-warning");
    }
  });

  it("waives a soft unsupported-command concern when an allowlist matches", () => {
    const service = new CommandRiskAssessmentService();
    const repoRoot = "/workspace";
    const allowPolicy = {
      blockedPatterns: [],
      allowedPatterns: [String.raw`^acme-build\b`],
      workspaceBoundaryRequired: false
    } as unknown as Parameters<typeof service.assess>[2];
    const denyPolicy = {
      blockedPatterns: [],
      allowedPatterns: [],
      workspaceBoundaryRequired: false
    } as unknown as Parameters<typeof service.assess>[2];
    const custom = {
      kind: "validation" as const,
      name: "custom build",
      command: "acme-build",
      args: ["--ci"],
      confidence: "high" as const,
      source: "commands.json"
    };

    // Without an allowlist entry, an unverified custom executable needs approval.
    const denied = service.assess(repoRoot, custom, denyPolicy);
    expect(denied.allowed).toBe(false);
    expect(denied.matchedRules).toContain("custom-command-unverified");

    // With an explicit allowlist entry, the soft concern is waived.
    const allowed = service.assess(repoRoot, custom, allowPolicy);
    expect(allowed.allowed).toBe(true);
    expect(allowed.matchedRules).toHaveLength(0);
  });

  it("checks workspace path boundaries and command risk", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-boundary-"));
    const boundary = new PathBoundaryService();
    const policy = await new SafetyPolicyService().load(repoRoot);
    const assessment = new CommandRiskAssessmentService().assess(
      repoRoot,
      {
        kind: "validation",
        name: "danger",
        command: "rm",
        args: ["-rf", "tmp"],
        cwd: "../outside",
        confidence: "high",
        source: "commands.json",
        required: true
      },
      policy
    );

    expect(boundary.checkPath(repoRoot, "src").allowed).toBe(true);
    expect(boundary.checkPath(repoRoot, "../outside").allowed).toBe(false);
    expect(assessment.allowed).toBe(false);
    expect(assessment.matchedRules).toContain("workspace-boundary");
  });

  it("captures a git checkpoint when git is available", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-git-"));
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# checkpoint\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
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

    const checkpoint = await new GitCheckpointService().createCheckpoint(repoRoot);

    expect(checkpoint.gitAvailable).toBe(true);
    expect(checkpoint.created).toBe(true);
    expect(checkpoint.head).toMatch(/[a-f0-9]{40}/);
    expect(checkpoint.rollbackGuide).toContain("Rollback guide");
  }, 60_000);
});

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
