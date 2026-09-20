import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { SymbolGraphService } from "../packages/graph/src/index.js";
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

  it("classifies request intent/entities and cites graph edges in relevantFiles reasons", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoices/InvoiceApprovalController.ts":
        "import { InvoiceApprovalService } from './InvoiceApprovalService';\n" +
        "export class InvoiceApprovalController {\n" +
        "  private service = new InvoiceApprovalService();\n" +
        "  approveInvoice() { return this.service.approveInvoice(); }\n" +
        "}\n",
      "src/invoices/InvoiceApprovalService.ts":
        "export class InvoiceApprovalService {\n" +
        "  approveInvoice() { return true; }\n" +
        "}\n"
    });

    // Without a graph.json yet, reasons fall back to entity/signal-only.
    const withoutGraph = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      request: "Why is invoice approval failing?"
    });

    expect(withoutGraph.plan.requestIntent).toBe("debugging");
    expect(withoutGraph.plan.requestEntities).toEqual(["invoice", "approval"]);
    const controllerBefore = withoutGraph.plan.relevantFiles.find(
      (file) => file.filePath === "src/invoices/InvoiceApprovalController.ts"
    );
    expect(controllerBefore?.reason).toContain("invoice");
    expect(controllerBefore?.reason).not.toContain("imports `src/invoices");

    await new SymbolGraphService().build({ startPath: repoRoot });

    const withGraph = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      request: "Why is invoice approval failing?"
    });

    const controllerAfter = withGraph.plan.relevantFiles.find(
      (file) => file.filePath === "src/invoices/InvoiceApprovalController.ts"
    );
    const serviceAfter = withGraph.plan.relevantFiles.find(
      (file) => file.filePath === "src/invoices/InvoiceApprovalService.ts"
    );

    expect(controllerAfter?.reason).toContain(
      "imports `src/invoices/InvoiceApprovalService.ts`"
    );
    expect(serviceAfter?.reason).toContain(
      "is imported by `src/invoices/InvoiceApprovalController.ts`"
    );
  });

  it("composes integration guidance for an arbitrary stack combination", async () => {
    const repoRoot = await createRepo({
      "pom.xml":
        "<project><dependencies>" +
        "<dependency><artifactId>ojdbc11</artifactId></dependency>" +
        "<dependency><artifactId>spring-kafka</artifactId></dependency>" +
        "<dependency><groupId>com.ibm.mq</groupId><artifactId>mq-jms-spring-boot-starter</artifactId></dependency>" +
        "</dependencies></project>",
      "src/main/java/com/acme/OrderService.java":
        "package com.acme;\npublic class OrderService { public void publish() {} }\n"
    });

    const { plan } = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      strictRoot: true,
      request: "Publish order status downstream"
    });
    const guidance = plan.stackSpecificPlan.integrations.join("\n");

    // Each detected integration contributes independently — there is no
    // "java + oracle + kafka + mq" branch to add.
    expect(guidance).toContain("Oracle");
    expect(guidance).toContain("Kafka");
    expect(guidance).toContain("IBM MQ");
    // Category baselines cover anything without a name-specific entry.
    expect(guidance).toContain("Datastore change");
    expect(guidance).toContain("Messaging change");
    expect(guidance).toContain("Detected integrations to account for");
  });

  it("surfaces orchestration and monorepo-tooling guidance too", async () => {
    const repoRoot = await createRepo({
      "nx.json": "{}",
      "docker-compose.yml": "services:\n  api: {}\n",
      "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/index.ts": "export const add = (a: number, b: number) => a + b;"
    });

    const { plan } = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      strictRoot: true,
      request: "Add a subtract helper"
    });
    const guidance = plan.stackSpecificPlan.integrations.join("\n");

    expect(guidance).toContain("Kubernetes");
    expect(guidance).toContain("Docker Compose");
    expect(guidance).toContain("Nx");
    // Kubernetes and Docker Compose have their own lines; Nx relies on the
    // category baseline, same precedent as Web Components under
    // micro-frontend — not every detected name needs its own entry.
    expect(guidance).toContain("Deployment topology");
    expect(guidance).toContain("Monorepo build graph");
  });

  it("surfaces test-automation guidance for Playwright and Cucumber", async () => {
    const repoRoot = await createRepo({
      "playwright.config.ts": "export default {}",
      "features/login.feature": "Feature: Login\n  Scenario: ok\n",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/index.ts": "export const add = (a: number, b: number) => a + b;"
    });

    const { plan } = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      strictRoot: true,
      request: "Add a subtract helper"
    });
    const guidance = plan.stackSpecificPlan.integrations.join("\n");

    expect(guidance).toContain("Playwright");
    expect(guidance).toContain("Cucumber");
    expect(guidance).toContain("Test automation");
  });

  it("leaves integration guidance empty when the repo has none", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/index.ts": "export const add = (a: number, b: number) => a + b;"
    });

    const { plan } = await new FeaturePlanningService().createPlanPreview({
      startPath: repoRoot,
      strictRoot: true,
      request: "Add a subtract helper"
    });

    expect(plan.stackSpecificPlan.integrations).toEqual([]);
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

  it("approves a specific revision, freezes it, and promotes it to latest", async () => {
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

    expect(initial.plan.status).toBe("draft");
    expect(initial.plan.approval).toBeUndefined();

    const approved = await service.approvePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      revision: 1,
      approvedBy: "reviewer@example.test",
      note: "Looks good."
    });

    expect(approved.plan.status).toBe("approved");
    expect(approved.plan.approval).toMatchObject({
      approvedBy: "reviewer@example.test",
      revision: 1,
      note: "Looks good."
    });

    const latestJson = JSON.parse(
      await readFile(approved.latestJsonPath, "utf8")
    ) as FeaturePlanArtifact;
    expect(latestJson.status).toBe("approved");

    const frozenPath = path.join(
      getArtifactDirectoryPath(repoRoot, "plans"),
      "approved",
      `${initial.plan.id}-rev1-plan.json`
    );
    expect(existsSync(frozenPath)).toBe(true);
    const frozen = JSON.parse(
      await readFile(frozenPath, "utf8")
    ) as FeaturePlanArtifact;
    expect(frozen.approval?.approvedBy).toBe("reviewer@example.test");
  });

  it("resets status to draft when a revision is made after approval", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "revise-after-approve" })
    });
    const service = new FeaturePlanningService();
    const initial = await service.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    await service.approvePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      revision: 1,
      approvedBy: "reviewer"
    });

    const revised = await service.revisePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      feedback: "Also add an audit trail entry.",
      source: "code-review"
    });

    expect(revised.plan.revision).toBe(2);
    expect(revised.plan.status).toBe("draft");
    expect(revised.plan.approval).toBeUndefined();
  });

  it("rejects approving a revision that does not exist", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "approve-missing-revision" })
    });
    const service = new FeaturePlanningService();
    const initial = await service.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    await expect(
      service.approvePlan({
        startPath: repoRoot,
        planId: initial.plan.id,
        revision: 5,
        approvedBy: "reviewer"
      })
    ).rejects.toThrow(/Revision 5 not found/);
  });

  it("lists revisions with status and approval state via listRevisions", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "list-revisions" })
    });
    const service = new FeaturePlanningService();
    const initial = await service.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    await service.revisePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      feedback: "Cover rejection path too."
    });
    await service.approvePlan({
      startPath: repoRoot,
      planId: initial.plan.id,
      revision: 1,
      approvedBy: "reviewer"
    });

    const revisions = await service.listRevisions({
      startPath: repoRoot,
      planId: initial.plan.id
    });

    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ revision: 1, status: "approved" });
    expect(revisions[0].approval?.approvedBy).toBe("reviewer");
    expect(revisions[1]).toMatchObject({ revision: 2, status: "draft" });
    expect(revisions[1].approval).toBeUndefined();
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

  it("supports plan approve, plan revisions, and plan show CLI subcommands", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const capture = () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      return {
        stdout,
        stderr,
        io: {
          stdout: (m: string) => stdout.push(m),
          stderr: (m: string) => stderr.push(m)
        }
      };
    };

    const planCapture = capture();
    await runCli(
      ["plan", "Add invoice approval workflow", "--path", repoRoot],
      planCapture.io
    );

    const revisionsBefore = capture();
    const revisionsBeforeResult = await runCli(
      ["plan", "revisions", "--path", repoRoot, "--json"],
      revisionsBefore.io
    );
    const revisionsBeforeJson = JSON.parse(revisionsBefore.stdout.join("\n"));

    expect(revisionsBeforeResult.exitCode).toBe(0);
    expect(revisionsBeforeJson).toHaveLength(1);
    expect(revisionsBeforeJson[0]).toMatchObject({ revision: 1, status: "draft" });

    const approveMissingRevision = capture();
    const approveMissingResult = await runCli(
      ["plan", "approve", "--path", repoRoot, "--by", "reviewer"],
      approveMissingRevision.io
    );
    expect(approveMissingResult.exitCode).toBe(1);
    expect(approveMissingRevision.stderr.join("\n")).toContain("--revision");

    const approveCapture = capture();
    const approveResult = await runCli(
      [
        "plan",
        "approve",
        "--path",
        repoRoot,
        "--revision",
        "1",
        "--by",
        "reviewer@example.test",
        "--note",
        "LGTM",
        "--json"
      ],
      approveCapture.io
    );
    const approvedJson = JSON.parse(
      approveCapture.stdout.join("\n")
    ) as FeaturePlanArtifact;

    expect(approveResult.exitCode).toBe(0);
    expect(approvedJson.status).toBe("approved");
    expect(approvedJson.approval).toMatchObject({
      approvedBy: "reviewer@example.test",
      revision: 1,
      note: "LGTM"
    });

    const showCapture = capture();
    const showResult = await runCli(
      ["plan", "show", "--path", repoRoot, "--revision", "1", "--json"],
      showCapture.io
    );
    const shownJson = JSON.parse(showCapture.stdout.join("\n")) as FeaturePlanArtifact;

    expect(showResult.exitCode).toBe(0);
    expect(shownJson.status).toBe("approved");
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

describe("proposed new files", () => {
  it("names a file after the feature, not after the sentence", async () => {
    // "Add retry logic to the visits client" produced
    // AddRetryLogicToTheVisitsClientService.java — a name no developer would
    // write, proposed with the confidence of a real one.
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-newfiles-"));
    await mkdir(path.join(repoRoot, "src/main/java/com/acme/visits"), {
      recursive: true
    });
    await writeFile(path.join(repoRoot, "pom.xml"), "<project/>\n", "utf8");
    await writeFile(
      path.join(repoRoot, "src/main/java/com/acme/visits/VisitsClient.java"),
      "package com.acme.visits;\npublic class VisitsClient { public void call() {} }\n",
      "utf8"
    );

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add retry logic to the visits client"
    });

    const proposed = result.plan.likelyNewFiles.join("\n");
    expect(proposed).not.toContain("AddRetryLogicToThe");
    for (const file of result.plan.likelyNewFiles) {
      expect(path.basename(file).length).toBeLessThan(45);
    }

    await rm(repoRoot, { recursive: true, force: true });
  });

  it("puts a proposed source file where that language actually lives", async () => {
    // Ranked search hits put a .java file under src/test/java, then db/mysql,
    // then scripts/chaos. None of those hold Java.
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-newfiles-dir-"));
    await mkdir(path.join(repoRoot, "src/main/java/com/acme/billing"), {
      recursive: true
    });
    await mkdir(path.join(repoRoot, "src/main/resources/db/mysql"), {
      recursive: true
    });
    await writeFile(path.join(repoRoot, "pom.xml"), "<project/>\n", "utf8");
    await writeFile(
      path.join(repoRoot, "src/main/java/com/acme/billing/InvoiceService.java"),
      "package com.acme.billing;\npublic class InvoiceService { public void post() {} }\n",
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "src/main/resources/db/mysql/schema.sql"),
      "-- invoice tables\nCREATE TABLE invoice (id INT);\n",
      "utf8"
    );

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval to billing"
    });

    for (const file of result.plan.likelyNewFiles.filter((f) => f.endsWith(".java"))) {
      expect(file).toContain("src/main/java");
      expect(file).not.toContain("db/mysql");
      expect(file).not.toContain("src/test");
    }

    await rm(repoRoot, { recursive: true, force: true });
  });

  it("proposes nothing rather than somewhere invented", async () => {
    // A suggestion with nowhere real to live is one the developer has to
    // notice and discard, which costs more than making no suggestion.
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-newfiles-none-"));
    await writeFile(path.join(repoRoot, "README.md"), "# notes only\n", "utf8");

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Support bulk invoice export"
    });

    expect(result.plan.likelyNewFiles).toEqual([]);

    await rm(repoRoot, { recursive: true, force: true });
  });
});
