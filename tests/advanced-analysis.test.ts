import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { AdvancedAnalysisService } from "../packages/core/src/index.js";
import { FeaturePlanningService } from "../packages/planner/src/index.js";
import { getArtifactDirectoryPath } from "../packages/shared/src/index.js";

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

describe("Phase 21 advanced intelligence", () => {
  it("detects React architecture, routes, dependency manifests, and component tests", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest run" },
        dependencies: {
          react: "^18.2.0",
          "react-router-dom": "^6.22.0"
        }
      }),
      "src/App.tsx":
        "import { Route } from 'react-router-dom'; export function App() { return <Route path=\"/invoices\" element={<InvoicePage />} />; }",
      "src/InvoicePage.tsx": "export function InvoicePage() { return null; }",
      "src/InvoicePage.test.tsx": "test('invoice page', () => {})"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "React app"
    );
    expect(analysis.dependencyManifests).toContainEqual(
      expect.objectContaining({ filePath: "package.json", ecosystem: "javascript" })
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({ kind: "react", routePath: "/invoices" })
    );
    expect(analysis.testRelationships).toContainEqual(
      expect.objectContaining({
        kind: "component",
        sourceFile: "src/InvoicePage.tsx",
        testFile: "src/InvoicePage.test.tsx"
      })
    );
    expect(analysis.riskScores.map((risk) => risk.category)).toEqual(
      expect.arrayContaining(["security", "missing-test", "dependency"])
    );
  });

  it("detects Angular routes and service/component test relationships", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "ng build", test: "ng test" },
        dependencies: { "@angular/core": "^17.0.0", "@angular/router": "^17.0.0" },
        devDependencies: { "@angular/cli": "^17.0.0" }
      }),
      "angular.json": JSON.stringify({
        projects: {
          app: { projectType: "application", root: "", sourceRoot: "src" }
        }
      }),
      "src/app/app-routing.module.ts":
        "const routes = [{ path: 'invoices', component: InvoiceComponent }];",
      "src/app/invoice.component.ts": "export class InvoiceComponent {}",
      "src/app/invoice.component.spec.ts": "describe('invoice', () => {})",
      "src/app/invoice.service.ts": "export class InvoiceService {}",
      "src/app/invoice.service.spec.ts": "describe('service', () => {})"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Angular app"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({ kind: "angular", routePath: "/invoices" })
    );
    expect(analysis.testRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFile: "src/app/invoice.component.ts",
          testFile: "src/app/invoice.component.spec.ts"
        }),
        expect.objectContaining({
          sourceFile: "src/app/invoice.service.ts",
          testFile: "src/app/invoice.service.spec.ts"
        })
      ])
    );
  });

  it("detects Python service API routes and route tests", async () => {
    const repoRoot = await createRepo({
      "pyproject.toml": "[project]\nname = 'api'\ndependencies = ['fastapi']",
      "requirements.txt": "fastapi\npytest\n",
      "app/main.py":
        "from fastapi import FastAPI\napp = FastAPI()\n@app.post('/invoices/{invoice_id}/approve')\ndef approve_invoice(invoice_id: str): return {'ok': True}",
      "tests/test_invoice_routes.py": "def test_approve_invoice(): assert '/invoices' "
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Python service"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        kind: "fastapi",
        method: "POST",
        routePath: "/invoices/{invoice_id}/approve"
      })
    );
    expect(analysis.dependencyManifests.map((manifest) => manifest.filePath)).toEqual(
      expect.arrayContaining(["pyproject.toml", "requirements.txt"])
    );
    expect(analysis.testRelationships).toContainEqual(
      expect.objectContaining({
        kind: "api-route",
        routePath: "/invoices/{invoice_id}/approve",
        testFile: "tests/test_invoice_routes.py"
      })
    );
  });

  it("detects Java Spring services, controller routes, and dependency manifests", async () => {
    const repoRoot = await createRepo({
      "pom.xml":
        "<project><artifactId>spring-boot-starter-web</artifactId><artifactId>junit-jupiter</artifactId></project>",
      "src/main/java/com/acme/InvoiceController.java": [
        "import org.springframework.web.bind.annotation.*;",
        "@RestController",
        '@RequestMapping("/invoices")',
        "public class InvoiceController {",
        '@PostMapping("/{id}/approve")',
        "void approve() {}",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/InvoiceControllerTests.java":
        "class InvoiceControllerTests { void approveInvoice() {} }"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.architecturePatterns.map((pattern) => pattern.name)).toContain(
      "Java Spring service"
    );
    expect(analysis.routes).toContainEqual(
      expect.objectContaining({
        kind: "spring",
        method: "POST",
        routePath: "/invoices/{id}/approve"
      })
    );
    expect(analysis.dependencyManifests).toContainEqual(
      expect.objectContaining({ filePath: "pom.xml", ecosystem: "java" })
    );
  });

  it("adds advanced analysis, risk scores, and plan quality to plans", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest run" },
        dependencies: { react: "^18.2.0", "react-router-dom": "^6.22.0" }
      }),
      "src/App.tsx":
        "import { Route } from 'react-router-dom'; export function App() { return <Route path=\"/invoices\" element={<InvoicePage />} />; }",
      "src/InvoicePage.tsx": "export function InvoicePage() { return null; }",
      "src/InvoicePage.test.tsx": "test('invoice page', () => {})"
    });

    const result = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    const latestMarkdown = await readFile(result.latestMarkdownPath, "utf8");

    expect(result.plan.advancedAnalysis.routes.length).toBeGreaterThan(0);
    expect(result.plan.riskScores.length).toBeGreaterThanOrEqual(5);
    expect(result.plan.planQuality.score).toBeGreaterThan(0);
    expect(result.plan.impactAnalysis.risks.map((risk) => risk.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("missing-test risk score")])
    );
    expect(latestMarkdown).toContain("## Advanced Architecture Signals");
    expect(latestMarkdown).toContain("## Risk Scores");
    expect(latestMarkdown).toContain("## Plan Quality");
    expect(
      existsSync(
        path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.json")
      )
    ).toBe(true);
  });

  it("reports repo readiness through the diagnostics CLI", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        dependencies: { express: "^4.18.0" }
      }),
      "src/server.ts":
        "import express from 'express'; const app = express(); app.get('/health', handler);"
    });
    const capture = createCapture();

    const result = await runCli(
      ["diagnostics", "--path", repoRoot, "--json"],
      capture.io
    );
    const report = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(report.status).toBe("warning");
    expect(
      report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)
    ).toEqual(
      expect.arrayContaining([
        "MISSING_REPO_MAP",
        "MISSING_BUILD_SCRIPT",
        "MISSING_TESTS",
        "STALE_INDEX"
      ])
    );
    expect(report.advancedAnalysis.routes).toContainEqual(
      expect.objectContaining({ kind: "express", routePath: "/health" })
    );
  });

  it("returns no git activity when the repo has no .git directory", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "no-git" }),
      "src/index.ts": "export const value = 1;"
    });

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });

    expect(analysis.gitActivity).toEqual([]);
  });

  it("ranks git activity by commit frequency and surfaces recency", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "git-activity" }),
      "src/hot.ts": "export const hot = 1;",
      "src/cold.ts": "export const cold = 1;"
    });
    await initializeGitRepo(repoRoot);
    // Two extra commits touching src/hot.ts, none touching src/cold.ts again.
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        path.join(repoRoot, "src/hot.ts"),
        `export const hot = ${index + 2};`,
        "utf8"
      );
      await commitAll(repoRoot, `update hot ${index}`);
    }

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });
    const hot = analysis.gitActivity.find(
      (activity) => activity.filePath === "src/hot.ts"
    );
    const cold = analysis.gitActivity.find(
      (activity) => activity.filePath === "src/cold.ts"
    );

    expect(hot?.commitCount).toBe(3);
    expect(cold?.commitCount).toBe(1);
    expect(hot?.lastChangedDaysAgo).toBe(0);
    expect(analysis.gitActivity[0]?.filePath).toBe("src/hot.ts");
  });

  it("flags an untested hotspot in the missing-test risk score's reasons", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "hotspot-risk" }),
      "src/payment-service.ts": "export const process = () => true;"
    });
    await initializeGitRepo(repoRoot);
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        path.join(repoRoot, "src/payment-service.ts"),
        `export const process = () => ${index + 2};`,
        "utf8"
      );
      await commitAll(repoRoot, `touch payment-service ${index}`);
    }

    const analysis = await new AdvancedAnalysisService().analyze({
      startPath: repoRoot
    });
    const missingTestRisk = analysis.riskScores.find(
      (risk) => risk.category === "missing-test"
    );

    expect(missingTestRisk?.score).toBe(90);
    expect(missingTestRisk?.reasons.join(" ")).toContain("src/payment-service.ts");
    expect(missingTestRisk?.reasons.join(" ")).toContain("untested hotspots");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-advanced-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function initializeGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await commitAll(repoRoot, "initial");
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
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
      message
    ],
    { cwd: repoRoot }
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
