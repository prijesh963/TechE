import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { WorkspaceService } from "../packages/core/src/index.js";
import { IndexingService } from "../packages/indexer/src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../packages/shared/src/index.js";

describe("multi-repo workspace support", () => {
  it("loads example workspace config and generates a workspace-level repo-map", async () => {
    const fixture = await createWorkspaceFixture();
    await writeWorkspaceConfig(fixture.workspaceRoot, [
      { name: "customer-api", path: "../customer-api", role: "backend" },
      { name: "customer-web", path: "../customer-web", role: "frontend" },
      {
        name: "billing-service",
        path: "../billing-service",
        role: "downstream service"
      }
    ]);

    const service = new WorkspaceService();
    const result = await service.show({ startPath: fixture.workspaceRoot });
    const map = await service.createWorkspaceMap({ startPath: fixture.workspaceRoot });
    const savedMap = JSON.parse(await readFile(map.repoMapPath, "utf8"));

    expect(result.workspace.workspaceName).toBe("Customer Platform");
    expect(result.workspace.repos?.map((repo) => repo.name)).toEqual([
      "customer-api",
      "customer-web",
      "billing-service"
    ]);
    expect(service.resolveRepos(result.workspace).map((repo) => repo.repoRoot)).toEqual(
      [fixture.customerApi, fixture.customerWeb, fixture.billingService]
    );
    expect(map.repoMap.summary.repoCount).toBe(3);
    expect(savedMap.repos).toHaveLength(3);
  });

  it("adds, lists, and removes named repos through the CLI", async () => {
    const fixture = await createWorkspaceFixture();
    const initCapture = createCapture();
    const addCapture = createCapture();
    const listCapture = createCapture();
    const removeCapture = createCapture();

    expect(
      (
        await runCli(
          ["workspace", "init", "Customer Platform", "--path", fixture.workspaceRoot],
          initCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          [
            "workspace",
            "add",
            "customer-web",
            fixture.customerWeb,
            "--role",
            "frontend",
            "--path",
            fixture.workspaceRoot
          ],
          addCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workspace", "list", "--path", fixture.workspaceRoot, "--json"],
          listCapture.io
        )
      ).exitCode
    ).toBe(0);
    const listed = JSON.parse(listCapture.stdout.join("\n"));

    expect(listed.workspaceName).toBe("Customer Platform");
    expect(listed.repos).toContainEqual(
      expect.objectContaining({ name: "customer-web", role: "frontend" })
    );

    expect(
      (
        await runCli(
          ["workspace", "remove", "customer-web", "--path", fixture.workspaceRoot],
          removeCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(removeCapture.stdout.join("\n")).toContain("Repos: 1");
  });

  it("indexes and searches across multiple repos", async () => {
    const fixture = await createWorkspaceFixture();
    await writeWorkspaceConfig(fixture.workspaceRoot, [
      { name: "customer-api", path: "../customer-api", role: "backend" },
      { name: "customer-web", path: "../customer-web", role: "frontend" },
      { name: "billing-service", path: "../billing-service", role: "service" }
    ]);

    const index = await new IndexingService().indexWorkspace({
      startPath: fixture.workspaceRoot
    });
    const search = await new IndexingService().searchWorkspace({
      startPath: fixture.workspaceRoot,
      query: "invoice",
      limit: 5
    });

    expect(index.results).toHaveLength(3);
    // Normalize separators so assertion passes on both Windows (\) and Unix (/)
    expect(index.repoMapPath.replace(/\\/g, "/")).toContain(
      ".copilot-architect/repo-map.json"
    );
    expect(search.combinedResults.map((result) => result.repoName)).toContain(
      "billing-service"
    );
    expect(search.combinedResults[0]).toEqual(
      expect.objectContaining({
        repoName: "billing-service",
        relativePath: "src/invoice.ts"
      })
    );
  });

  it("generates workspace plans with impacted repos and per-repo validation plans", async () => {
    const fixture = await createWorkspaceFixture();
    await writeWorkspaceConfig(fixture.workspaceRoot, [
      { name: "customer-api", path: "../customer-api", role: "backend" },
      { name: "customer-web", path: "../customer-web", role: "frontend" },
      { name: "billing-service", path: "../billing-service", role: "service" }
    ]);
    const planCapture = createCapture();
    const validateCapture = createCapture();

    expect(
      (
        await runCli(
          [
            "workspace",
            "plan",
            "Add invoice approval workflow",
            "--path",
            fixture.workspaceRoot,
            "--json"
          ],
          planCapture.io
        )
      ).exitCode
    ).toBe(0);
    const plan = JSON.parse(planCapture.stdout.join("\n"));

    expect(
      plan.multiRepo.impactedRepos.map((repo: { name: string }) => repo.name)
    ).toContain("billing-service");
    expect(plan.multiRepo.perRepoValidationPlans).toHaveLength(3);
    expect(plan.plan.multiRepo.impactedRepos).toHaveLength(
      plan.multiRepo.impactedRepos.length
    );

    expect(
      (
        await runCli(
          ["workspace", "validate-plan", "--path", fixture.workspaceRoot, "--json"],
          validateCapture.io
        )
      ).exitCode
    ).toBe(0);
    const validation = JSON.parse(validateCapture.stdout.join("\n"));

    expect(validation.perRepoValidationPlans).toHaveLength(3);
    expect(validation.messages.join("\n")).toContain("Per-repo validation plans: 3");
  });
});

async function createWorkspaceFixture(): Promise<{
  workspaceRoot: string;
  customerApi: string;
  customerWeb: string;
  billingService: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "copilot-workspace-"));
  const workspaceRoot = path.join(parent, "customer-platform");
  const customerApi = path.join(parent, "customer-api");
  const customerWeb = path.join(parent, "customer-web");
  const billingService = path.join(parent, "billing-service");

  await writeRepo(customerApi, {
    "package.json": JSON.stringify({
      name: "customer-api",
      scripts: { test: "node --test" }
    }),
    "src/customer.ts": "export function loadCustomer() { return 'customer'; }"
  });
  await writeRepo(customerWeb, {
    "package.json": JSON.stringify({
      name: "customer-web",
      dependencies: { react: "^18.2.0" },
      scripts: { test: "vitest run" }
    }),
    "src/CustomerApp.tsx": "export function CustomerApp() { return 'customer'; }"
  });
  await writeRepo(billingService, {
    "package.json": JSON.stringify({
      name: "billing-service",
      scripts: { test: "vitest run" }
    }),
    "src/invoice.ts": "export function approveInvoice() { return 'approved'; }"
  });
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });

  return { workspaceRoot, customerApi, customerWeb, billingService };
}

async function writeWorkspaceConfig(
  workspaceRoot: string,
  repos: Array<{ name: string; path: string; role: string }>
): Promise<void> {
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceName: "Customer Platform",
        workspaceRoot,
        artifactRoot: path.join(workspaceRoot, ".copilot-architect"),
        repos,
        repoRoots: []
      },
      null,
      2
    ),
    "utf8"
  );
}

async function writeRepo(
  repoRoot: string,
  files: Record<string, string>
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
}

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
