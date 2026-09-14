import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { FeaturePlanningService } from "../packages/planner/src/index.js";
import type { FeaturePlanArtifact } from "../packages/planner/src/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  getArtifactDirectoryPath
} from "../packages/shared/src/index.js";

describe("FeaturePlanningService", () => {
  it("generates JSON and Markdown plan artifacts using repo map and index", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: {
          build: "vite build",
          test: "vitest run",
          lint: "eslint ."
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0"
        }
      }),
      "src/invoices/InvoiceApproval.tsx":
        "export function InvoiceApproval() { return 'invoice approval'; }",
      "src/hooks/useInvoiceApproval.ts":
        "export function useInvoiceApproval() { return true; }",
      "src/invoices/InvoiceApproval.test.tsx": "test('invoice approval', () => {})",
      "README.md": "# Invoice approval"
    });

    const before = await readFile(
      path.join(repoRoot, "src/invoices/InvoiceApproval.tsx"),
      "utf8"
    );
    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    const after = await readFile(
      path.join(repoRoot, "src/invoices/InvoiceApproval.tsx"),
      "utf8"
    );
    const latestJson = JSON.parse(
      await readFile(result.latestJsonPath, "utf8")
    ) as FeaturePlanArtifact;
    const markdown = await readFile(result.latestMarkdownPath, "utf8");

    expect(before).toBe(after);
    expect(existsSync(result.jsonPath)).toBe(true);
    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.latestJsonPath)).toBe(true);
    expect(existsSync(result.latestMarkdownPath)).toBe(true);
    expect(result.plan.relevantFiles.map((file) => file.filePath)).toEqual(
      expect.arrayContaining([
        "src/invoices/InvoiceApproval.tsx",
        "src/hooks/useInvoiceApproval.ts"
      ])
    );
    expect(result.plan.repoArchitectureSummary).toContain("Detected");
    expect(result.plan.impactedFrameworks).toContain("React");
    expect(result.plan.stackSpecificPlan.react.length).toBeGreaterThan(0);
    expect(result.plan.assumptions.length).toBeGreaterThan(0);
    expect(result.plan.openQuestions.length).toBeGreaterThan(0);
    expect(result.plan.validationPlan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm", args: ["test"] }),
        expect.objectContaining({ command: "npm", args: ["run", "build"] })
      ])
    );
    expect(result.plan.requiresHumanApproval).toBe(true);
    expect(result.plan.humanApprovalCheckpoint).toContain("human approval");
    expect(latestJson.id).toBe(result.plan.id);
    expect(markdown).toContain("## Planning Context");
    expect(markdown).toContain("## Human Approval Checkpoint");
    expect(markdown).toContain("## Stack-Specific Plan");
  });

  it("revises a draft plan in place without losing prior revisions", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" },
        dependencies: { react: "^18.2.0" }
      }),
      "src/invoices/InvoiceApproval.tsx":
        "export function InvoiceApproval() { return 'invoice approval'; }"
    });
    const service = new FeaturePlanningService();
    const initial = await service.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(initial.plan.revision).toBe(1);
    expect(initial.plan.revisions).toHaveLength(1);
    expect(initial.plan.revisions[0].source).toBe("initial");

    const revised = await service.revisePlan({
      startPath: repoRoot,
      feedback: "Also cover the rejection path, not just approval.",
      sections: {
        openQuestions: ["What happens when an approver rejects the invoice?"]
      }
    });

    expect(revised.plan.id).toBe(initial.plan.id);
    expect(revised.plan.revision).toBe(2);
    expect(revised.plan.supersedes).toBe(`${initial.plan.id}-rev1`);
    expect(revised.plan.revisions).toHaveLength(2);
    expect(revised.plan.revisions[1]).toMatchObject({
      revision: 2,
      source: "human-feedback",
      feedback: "Also cover the rejection path, not just approval.",
      changedSections: ["openQuestions"]
    });
    expect(revised.plan.openQuestions).toEqual([
      "What happens when an approver rejects the invoice?"
    ]);
    // Fields not covered by `sections` survive from the previous revision.
    expect(revised.plan.impactedFrameworks).toContain("React");

    const latestJson = JSON.parse(
      await readFile(revised.latestJsonPath, "utf8")
    ) as FeaturePlanArtifact;
    expect(latestJson.revision).toBe(2);

    const draftDir = path.join(
      getArtifactDirectoryPath(repoRoot, "plans"),
      "drafts",
      initial.plan.id
    );
    expect(existsSync(path.join(draftDir, "rev-1.json"))).toBe(true);
    expect(existsSync(path.join(draftDir, "rev-2.json"))).toBe(true);

    const secondRevision = await service.revisePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      feedback: "Findings from code review: add an audit log entry.",
      source: "code-review",
      reviewFindingIds: ["finding-1"]
    });

    expect(secondRevision.plan.revision).toBe(3);
    expect(secondRevision.plan.revisions[2]).toMatchObject({
      revision: 3,
      source: "code-review",
      reviewFindingIds: ["finding-1"]
    });
  });

  it("rejects revising a plan when no draft exists", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "no-plan-yet" })
    });

    await expect(
      new FeaturePlanningService().revisePlan({
        startPath: repoRoot,
        feedback: "This should fail, there is no plan yet."
      })
    ).rejects.toThrow(/No draft plan found/);
  });

  it("uses optional workspace config, custom commands, and instruction files", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: {
          test: "vitest run",
          "custom:validate": "node scripts/custom-validate.js"
        }
      }),
      "src/invoices/workflow.ts": "export const workflow = 'invoice approval';"
    });
    const artifactRoot = path.join(repoRoot, ".copilot-architect");

    await mkdir(path.join(repoRoot, ".github"), { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      path.join(repoRoot, ".github/copilot-instructions.md"),
      "Use repo-local patterns for handoffs.",
      "utf8"
    );
    await writeFile(
      path.join(artifactRoot, "commands.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        defaults: { timeoutMs: 120_000, retryCount: 0, required: false },
        test: [
          {
            name: "custom:validate",
            workingDirectory: ".",
            command: "npm run custom:validate",
            required: true,
            overrideDetected: true
          }
        ]
      }),
      "utf8"
    );
    await writeFile(
      path.join(artifactRoot, "workspace.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceRoot: repoRoot,
        repoRoots: [repoRoot, path.join(repoRoot, "packages/api")],
        artifactRoot,
        customCommandsPath: ".copilot-architect/commands.json"
      }),
      "utf8"
    );

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(result.plan.planningContext.customCommandCount).toBe(1);
    expect(result.plan.planningContext.customCommandNames).toContain("custom:validate");
    expect(result.plan.planningContext.instructionFiles).toContain(
      ".github/copilot-instructions.md"
    );
    expect(result.plan.planningContext.workspaceRepoRoots).toEqual(
      expect.arrayContaining([repoRoot, path.join(repoRoot, "packages/api")])
    );
    expect(result.plan.validationPlan.commands).toContainEqual(
      expect.objectContaining({
        name: "custom:validate",
        command: "npm",
        args: ["run", "custom:validate"]
      })
    );
    expect(result.markdown).toContain("custom:validate");
    expect(result.plan.openQuestions).toContain(
      "Which workspace repo owns the primary implementation?"
    );
  });

  it("includes Angular, Python, and Java stack-specific planning when detected", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        workspaces: ["packages/*"],
        scripts: { test: "npm test --workspaces" }
      }),
      "packages/web/package.json": JSON.stringify({
        dependencies: { "@angular/core": "^17.0.0" },
        devDependencies: { "@angular/cli": "^17.0.0" }
      }),
      "packages/web/angular.json": JSON.stringify({
        projects: {
          web: { projectType: "application", root: "", sourceRoot: "src" }
        }
      }),
      "packages/web/src/app/app.component.ts": "export class AppComponent {}",
      "packages/api/pyproject.toml": "[tool.poetry]\nfastapi = '*'\npytest = '*'",
      "packages/api/app/main.py": "from fastapi import FastAPI",
      "packages/service/pom.xml":
        "<project><artifactId>spring-boot-starter-web</artifactId><artifactId>junit-jupiter</artifactId></project>",
      "packages/service/src/main/java/com/acme/Application.java":
        "SpringApplication.run();"
    });

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add account approval workflow"
    });

    expect(result.plan.stackSpecificPlan.angular.length).toBeGreaterThan(0);
    expect(result.plan.stackSpecificPlan.python.length).toBeGreaterThan(0);
    expect(result.plan.stackSpecificPlan.java.length).toBeGreaterThan(0);
    expect(result.plan.impactedLanguages).toEqual(
      expect.arrayContaining(["TypeScript", "Python", "Java"])
    );
    expect(result.plan.likelyNewFiles.length).toBeGreaterThan(0);
  });

  it("cites matching API endpoints with file location and their tests", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" },
        dependencies: { express: "^4.18.0" }
      }),
      "src/routes/invoices.ts":
        "import { Router } from 'express';\nconst router = Router();\nrouter.post('/invoices/approve', approveInvoice);\nexport function approveInvoice() { return 'approved'; }\n",
      "src/routes/invoices.test.ts": "test('approve invoice route', () => {})"
    });

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approve workflow"
    });

    const endpoint = result.plan.relatedEndpoints.find((candidate) =>
      candidate.routePath.includes("/invoices/approve")
    );

    expect(endpoint).toBeDefined();
    expect(endpoint?.filePath).toBe("src/routes/invoices.ts");
    expect(endpoint?.line).toBeGreaterThan(0);
    expect(endpoint?.testFile).toBe("src/routes/invoices.test.ts");

    const integrationStep = result.plan.implementationSteps.find(
      (step) => step.id === "step-3"
    );
    expect(integrationStep?.details).toContain("/invoices/approve");
    expect(integrationStep?.files).toContain("src/routes/invoices.ts");
    expect(result.markdown).toContain("## Endpoints To Touch");
  });

  it("supports CLI plan and --json output", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" },
        dependencies: { react: "^18.2.0" }
      }),
      "src/InvoiceApproval.tsx":
        "export function InvoiceApproval() { return 'invoice approval'; }"
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const textResult = await runCli(
      ["plan", "Add invoice approval workflow", "--path", repoRoot],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );
    const jsonStdout: string[] = [];
    const jsonResult = await runCli(
      ["plan", "Add invoice approval workflow", "--json", "--path", repoRoot],
      {
        stdout: (message) => jsonStdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );
    const plan = JSON.parse(jsonStdout.join("\n")) as FeaturePlanArtifact;

    expect(textResult.exitCode).toBe(0);
    expect(jsonResult.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Plan JSON:");
    expect(plan.task).toBe("Add invoice approval workflow");
    expect(plan.relevantFiles.map((file) => file.filePath)).toContain(
      "src/InvoiceApproval.tsx"
    );
    expect(
      existsSync(
        path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.md")
      )
    ).toBe(true);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-architect-plan-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
