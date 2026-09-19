import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCopilotArchitectMcpServer } from "../packages/mcp-server/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { RepoDiscoveryService, WorkspaceService } from "../packages/core/src/index.js";
import { IndexingService } from "../packages/indexer/src/index.js";
import { FeaturePlanningService } from "../packages/planner/src/index.js";
import {
  CHAT_COMMANDS,
  ARTIFACT_DIRECTORY,
  CURRENT_SCHEMA_VERSION,
  getArtifactDirectoryPath
} from "../packages/shared/src/index.js";
import { CommandRiskAssessmentService } from "../packages/validator/src/index.js";

const workspaceRoot = process.cwd();
const sampleRoot = path.join(workspaceRoot, "samples");
const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const requiredSamples = [
  "react-app",
  "angular-app",
  "python-service",
  "java-maven-service",
  "java-gradle-service",
  "node-api",
  "polyglot-monorepo",
  "generic-repo"
] as const;

describe("Phase 22 sample repo matrix", () => {
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(servers.map((server) => server.close()));
    clients.length = 0;
    servers.length = 0;
  });

  it("ships all required sample repos and CI test workflow", async () => {
    for (const sample of requiredSamples) {
      await expect(
        readFile(path.join(sampleRoot, sample, "README.md"), "utf8")
      ).resolves.toContain("Sample");
    }

    const workflow = await readFile(
      path.join(workspaceRoot, ".github", "workflows", "ci.yml"),
      "utf8"
    );

    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run lint");
  });

  it("proves language and framework support through repo discovery", async () => {
    const expectations = [
      {
        sample: "react-app",
        languages: ["TypeScript"],
        frameworks: ["React", "React DOM", "Vite React"]
      },
      {
        sample: "angular-app",
        languages: ["TypeScript"],
        frameworks: ["Angular", "Angular CLI"]
      },
      {
        sample: "python-service",
        languages: ["Python"],
        frameworks: ["FastAPI", "pytest"]
      },
      {
        sample: "java-maven-service",
        languages: ["Java"],
        frameworks: ["Maven", "Spring Boot", "JUnit"]
      },
      {
        sample: "java-gradle-service",
        languages: ["Java"],
        frameworks: ["Gradle", "Spring Boot", "JUnit"]
      },
      {
        sample: "node-api",
        languages: ["TypeScript"],
        frameworks: ["Node.js"]
      },
      {
        sample: "polyglot-monorepo",
        languages: ["TypeScript", "Python", "Java"],
        frameworks: ["FastAPI"]
      },
      {
        sample: "generic-repo",
        languages: [],
        frameworks: []
      }
    ] as const;

    for (const expected of expectations) {
      const repoRoot = await copySample(expected.sample);
      const result = await new RepoDiscoveryService().analyze({ startPath: repoRoot });
      const repo = result.repoMap.repos[0];
      const languages = repo?.languages.map((language) => language.name) ?? [];
      const frameworks = repo?.frameworks.map((framework) => framework.name) ?? [];

      expect(languages).toEqual(expect.arrayContaining(expected.languages));
      expect(frameworks).toEqual(expect.arrayContaining(expected.frameworks));

      if (expected.sample === "generic-repo") {
        expect(repo?.architecturalPatterns).toContain("generic-text-indexing");
      }
    }
  });

  it("indexes, searches, plans, detects validation commands, and blocks unsafe commands", async () => {
    const repoRoot = await copySample("react-app");
    const indexer = new IndexingService();
    const index = await indexer.index({ startPath: repoRoot });
    const search = await indexer.search({
      startPath: repoRoot,
      query: "invoice approval",
      limit: 5
    });
    const plan = await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    const unsafe = new CommandRiskAssessmentService().assess(repoRoot, {
      kind: "validation",
      name: "unsafe",
      command: "rm",
      args: ["-rf", "."],
      confidence: "high",
      source: "sample-matrix",
      required: true
    });

    expect(index.index.stats.documentCount).toBeGreaterThan(0);
    expect(search.results.map((result) => result.relativePath)).toContain(
      "src/invoices/InvoiceApproval.tsx"
    );
    expect(plan.plan.validationPlan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm", args: ["test"] }),
        expect.objectContaining({ command: "npm", args: ["run", "build"] })
      ])
    );
    expect(
      plan.plan.advancedAnalysis.architecturePatterns.map((pattern) => pattern.name)
    ).toContain("React app");
    expect(unsafe.allowed).toBe(false);
    expect(unsafe.matchedRules).toContain("rm-rf");
  });

  it("exposes sample repo intelligence through MCP tools", async () => {
    const repoRoot = await copySample("node-api");
    const { client } = await createConnectedServer(repoRoot);

    const repoMap = await callJsonTool(client, "repo_map", { path: repoRoot });
    const search = await callJsonTool(client, "search_repo", {
      path: repoRoot,
      query: "approve invoice",
      limit: 5
    });
    const plan = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });

    expect(repoMap.ok).toBe(true);
    expect(search.ok).toBe(true);
    expect(plan.ok).toBe(true);
    expect(plan.data?.plan.task).toBe("Add invoice approval workflow");
  });

  it("supports workspace commands across sample repos", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "copilot-sample-workspace-"));
    const workspacePath = path.join(parent, "workspace");
    const reactPath = await copySample("react-app", path.join(parent, "react-app"));
    const nodePath = await copySample("node-api", path.join(parent, "node-api"));
    await mkdir(path.join(workspacePath, ARTIFACT_DIRECTORY), { recursive: true });
    await writeFile(
      path.join(workspacePath, ARTIFACT_DIRECTORY, "workspace.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        workspaceName: "Sample Workspace",
        workspaceRoot: workspacePath,
        artifactRoot: path.join(workspacePath, ARTIFACT_DIRECTORY),
        repos: [
          { name: "react-app", path: "../react-app", role: "frontend" },
          { name: "node-api", path: "../node-api", role: "backend" }
        ],
        repoRoots: []
      }),
      "utf8"
    );

    const workspaceMap = await new WorkspaceService().createWorkspaceMap({
      startPath: workspacePath
    });
    const workspaceIndex = await new IndexingService().indexWorkspace({
      startPath: workspacePath
    });
    const workspaceSearch = await runCliCapture([
      "workspace",
      "search",
      "invoice",
      "--path",
      workspacePath,
      "--json"
    ]);

    expect(workspaceMap.repos.map((repo) => repo.name)).toEqual([
      "react-app",
      "node-api"
    ]);
    expect(workspaceIndex.results).toHaveLength(2);
    expect(workspaceSearch.exitCode).toBe(0);
    expect(JSON.parse(workspaceSearch.stdout).combinedResults.length).toBeGreaterThan(
      0
    );
    expect(reactPath).toContain("react-app");
    expect(nodePath).toContain("node-api");
  });

  it("runs the MVP end-to-end CLI flow on the React sample", async () => {
    const repoRoot = await copySample("react-app");
    const commands = [
      ["analyze", "--path", repoRoot],
      ["index", "--path", repoRoot],
      ["search", "invoice", "--path", repoRoot],
      ["plan", "Add invoice approval workflow", "--path", repoRoot],
      ["instructions", "generate", "--path", repoRoot],
      ["plan", "approve", "--path", repoRoot, "--revision", "1", "--by", "reviewer"],
      [
        "handoff",
        "--approve",
        "--plan",
        "latest",
        "--path",
        repoRoot,
        "--no-clipboard"
      ],
      ["validate", "--path", repoRoot],
      ["review", "--path", repoRoot]
    ];

    for (const command of commands) {
      const result = await runCliCapture(command);
      expect(result.exitCode, `${command.join(" ")}\n${result.stderr}`).toBe(0);
    }

    await expect(
      readFile(
        path.join(getArtifactDirectoryPath(repoRoot, "plans"), "latest-plan.md"),
        "utf8"
      )
    ).resolves.toContain("## Risk Scores");
    await expect(
      readFile(
        path.join(getArtifactDirectoryPath(repoRoot, "handoffs"), "latest-handoff.md"),
        "utf8"
      )
    ).resolves.toContain(CHAT_COMMANDS.implement);
    await expect(
      readFile(
        path.join(getArtifactDirectoryPath(repoRoot, "reviews"), "latest-review.md"),
        "utf8"
      )
    ).resolves.toContain("Review");
  }, 60_000);
});

async function copySample(sampleName: string, targetPath?: string): Promise<string> {
  const target =
    targetPath ?? (await mkdtemp(path.join(tmpdir(), `copilot-sample-${sampleName}-`)));
  await cp(path.join(sampleRoot, sampleName), target, {
    recursive: true,
    force: true
  });
  return target;
}

async function runCliCapture(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCli(args, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  });

  return {
    exitCode: result.exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n")
  };
}

async function createConnectedServer(repoRoot: string): Promise<{ client: Client }> {
  const server = createCopilotArchitectMcpServer({ startPath: repoRoot });
  const client = new Client({ name: "sample-matrix-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  servers.push(server);
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client };
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{
  ok: boolean;
  data?: {
    plan?: { task: string };
  };
  error?: string;
}> {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];

  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} did not return text content`);
  }

  return JSON.parse(first.text);
}
