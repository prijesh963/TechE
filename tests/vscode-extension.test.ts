import { existsSync } from "node:fs";
import { SessionService } from "../packages/session/src/index.js";
import { renderRolePrompt } from "../packages/agents/src/index.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COPILOT_ARCHITECT_COMMANDS,
  getChatHelpText,
  COPILOT_ARCHITECT_SECONDARY_ACTIONS,
  DASHBOARD_PRIMARY_ACTIONS,
  DASHBOARD_VIEW_ID,
  activate,
  buildCommandLmPrompt,
  createCliCommandLine,
  createDashboardHtml,
  STAGED_SCHEME,
  parseStagedUri,
  stagedUri,
  formatSession,
  loadDashboardSession,
  parseProposedDecisions,
  deactivate,
  diagnoseEmptyContext,
  buildRepoContext,
  shouldBuildWorkspaceGraph,
  formatAgentInsights,
  loadDashboardArtifacts,
  type CliRunRequest,
  type CliRunResult,
  type DisposableLike,
  type ExtensionContextLike,
  type McpStarter,
  type QuickPickItemLike,
  type UriLike,
  type VscodeApiLike,
  type WebviewViewProviderLike
} from "../packages/vscode-extension/src/index.js";

const passThroughRunner = {
  run: async (request: CliRunRequest): Promise<CliRunResult> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    commandLine: createCliCommandLine(request.args)
  })
};

describe("VS Code extension shell", () => {
  it("declares activity bar, webview, and workflow commands in the manifest", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages/vscode-extension/package.json"),
        "utf8"
      )
    );
    const contributedCommands = manifest.contributes.commands.map(
      (command: { command: string; title: string }) => command
    );

    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.contributes.viewsContainers.activitybar[0]).toEqual(
      expect.objectContaining({
        id: "copilotArchitect",
        title: "Copilot Architect",
        icon: "resources/copilot-architect.svg"
      })
    );
    expect(manifest.contributes.views.copilotArchitect[0]).toEqual(
      expect.objectContaining({
        id: DASHBOARD_VIEW_ID,
        name: "Copilot Architect",
        type: "webview"
      })
    );

    for (const command of COPILOT_ARCHITECT_COMMANDS) {
      expect(contributedCommands).toContainEqual(
        expect.objectContaining({
          command: command.id,
          title: command.title
        })
      );
      expect(manifest.activationEvents).toContain(`onCommand:${command.id}`);
    }

    // Every command the dashboard links to must be declared, or the link is a
    // no-op in the real extension host.
    const dashboardCommandIds = [
      ...DASHBOARD_PRIMARY_ACTIONS.map((action) => action.id),
      ...COPILOT_ARCHITECT_SECONDARY_ACTIONS.map((action) => action.id),
      "copilotArchitect.moreActions"
    ];
    for (const commandId of dashboardCommandIds) {
      expect(contributedCommands).toContainEqual(
        expect.objectContaining({ command: commandId })
      );
      expect(manifest.activationEvents).toContain(`onCommand:${commandId}`);
    }
  });

  it("activates in a fake extension host and registers commands through CLI/MCP shims", async () => {
    const fake = createFakeVscode();
    // extensionPath = .../ext-root/packages/vscode-extension → resolveExtensionRoot goes two levels up
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };
    const cliRequests: CliRunRequest[] = [];
    const mcpRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        request.onOutput?.("stdout", "ok");
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const mcpStarter: McpStarter = {
      start: (request) => {
        mcpRequests.push(request);
        return { dispose: () => undefined };
      }
    };

    const api = activate(context, fake.vscode, { runner, mcpStarter });
    await fake.commands.get("copilotArchitect.analyzeRepo")?.();
    await fake.commands.get("copilotArchitect.buildGraph")?.();
    await fake.commands.get("copilotArchitect.startMcp")?.();

    expect(fake.viewProviderId).toBe(DASHBOARD_VIEW_ID);
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(
      COPILOT_ARCHITECT_COMMANDS.length
    );
    expect(cliRequests.map((request) => request.args)).toEqual([
      ["analyze", "--path", "/workspace/repo"],
      ["graph", "--path", "/workspace/repo"]
    ]);
    // Use path.resolve so the expected value matches platform-specific separator/drive letter
    expect(cliRequests[0]?.cwd).toBe(
      path.resolve("/workspace/ext-root/packages/vscode-extension", "..", "..")
    );
    expect(mcpRequests[0]?.args).toEqual(["mcp", "--path", "/workspace/repo"]);
    expect(api.getState().mcpStatus).toBe("running");

    deactivate();
  });

  it("registers sub-repos with positional name+path and surfaces them in the Explorer", async () => {
    const reposDir = await mkdtemp(path.join(tmpdir(), "copilot-ext-scan-"));
    const repoA = path.join(reposDir, "service-a");
    const repoB = path.join(reposDir, "service-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(path.join(repoA, "pom.xml"), "<project/>\n", "utf8");
    await writeFile(path.join(repoB, "package.json"), "{}\n", "utf8");
    await mkdir(path.join(reposDir, ".hidden"), { recursive: true });
    // Real projects carry folders like these beside their services. Before
    // they were registered as repos, so eight services reported as twelve.
    await mkdir(path.join(reposDir, "docs"), { recursive: true });
    await mkdir(path.join(reposDir, "scripts"), { recursive: true });

    const fake = createFakeVscode();
    fake.openDialogResult = [{ fsPath: reposDir, toString: () => reposDir }];
    const cliRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    activate(context, fake.vscode, { runner });
    await fake.commands.get("copilotArchitect.workspaceScan")?.();

    const addArgs = cliRequests
      .filter((request) => request.args[0] === "workspace" && request.args[1] === "add")
      .map((request) => request.args);
    // Repo name + path are positional; the CLI's --name sets the workspace name.
    expect(addArgs).toContainEqual([
      "workspace",
      "add",
      "service-a",
      repoA,
      "--path",
      "/workspace/repo"
    ]);
    expect(addArgs).toContainEqual([
      "workspace",
      "add",
      "service-b",
      repoB,
      "--path",
      "/workspace/repo"
    ]);
    expect(addArgs.every((args) => !args.includes("--name"))).toBe(true);

    // Every registered repo is analyzed; the hidden directory is skipped.
    const analyzedPaths = cliRequests
      .filter((request) => request.args[0] === "analyze")
      .map((request) => request.args[2]);
    expect(analyzedPaths).toEqual(expect.arrayContaining([repoA, repoB]));
    expect(analyzedPaths).not.toContain(path.join(reposDir, ".hidden"));

    // Registered repos are added to the workspace so they show in the Explorer.
    expect(fake.addedFolders.map((folder) => folder.uri.fsPath)).toEqual(
      expect.arrayContaining([repoA, repoB])
    );

    deactivate();
  });

  it("sets up a single repo end to end and starts the MCP server", async () => {
    const fake = createFakeVscode();
    fake.quickPickChoice = "This repo";
    const cliRequests: CliRunRequest[] = [];
    const mcpRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const mcpStarter: McpStarter = {
      start: (request) => {
        mcpRequests.push(request);
        return { dispose: () => undefined };
      }
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    const api = activate(context, fake.vscode, { runner, mcpStarter });
    await fake.commands.get("copilotArchitect.setupRepo")?.();

    // init → analyze → graph → diagnostics → index → agents install → mcp config
    expect(cliRequests.map((request) => request.args)).toEqual([
      ["init", "--path", "/workspace/repo"],
      ["analyze", "--path", "/workspace/repo"],
      ["graph", "--path", "/workspace/repo"],
      ["diagnostics", "--path", "/workspace/repo"],
      ["index", "--path", "/workspace/repo"],
      ["mcp", "config", "--path", "/workspace/repo"]
    ]);
    expect(mcpRequests[0]?.args).toEqual(["mcp", "--path", "/workspace/repo"]);
    expect(api.getState().mcpStatus).toBe("running");

    deactivate();
  });

  it("registers only the folders that look like repositories", async () => {
    // Reported from spring-petclinic-microservices: eight services came back
    // as "12 repos" because docs/, docker/ and scripts/ were registered too,
    // putting documentation in the ranking against source on every search.
    const reposDir = await mkdtemp(path.join(tmpdir(), "copilot-ext-petclinic-"));
    const services = ["customers-service", "vets-service", "visits-service"];
    for (const name of services) {
      await mkdir(path.join(reposDir, name), { recursive: true });
      await writeFile(path.join(reposDir, name, "pom.xml"), "<project/>\n", "utf8");
    }
    for (const name of ["docs", "docker", "scripts"]) {
      await mkdir(path.join(reposDir, name), { recursive: true });
      await writeFile(path.join(reposDir, name, "README.md"), "# notes\n", "utf8");
    }

    const fake = createFakeVscode();
    fake.openDialogResult = [{ fsPath: reposDir, toString: () => reposDir }];
    const cliRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };

    activate(
      {
        subscriptions: [],
        extensionPath: "/workspace/ext-root/packages/vscode-extension"
      },
      fake.vscode,
      { runner }
    );
    await fake.commands.get("copilotArchitect.workspaceScan")?.();

    const registered = cliRequests
      .filter((request) => request.args[0] === "workspace" && request.args[1] === "add")
      .map((request) => request.args[2]);

    expect(registered.sort()).toEqual(services.sort());
    for (const skipped of ["docs", "docker", "scripts"]) {
      expect(registered).not.toContain(skipped);
    }
  });

  it("refuses rather than registering a folder of non-repos", async () => {
    // Pointing the scan at the wrong folder should say so, not register
    // three documentation directories and report a working workspace.
    const reposDir = await mkdtemp(path.join(tmpdir(), "copilot-ext-norepos-"));
    for (const name of ["docs", "images"]) {
      await mkdir(path.join(reposDir, name), { recursive: true });
    }

    const fake = createFakeVscode();
    fake.openDialogResult = [{ fsPath: reposDir, toString: () => reposDir }];
    const cliRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };

    activate(
      {
        subscriptions: [],
        extensionPath: "/workspace/ext-root/packages/vscode-extension"
      },
      fake.vscode,
      { runner }
    );
    await fake.commands.get("copilotArchitect.workspaceScan")?.();

    expect(cliRequests.some((request) => request.args[1] === "add")).toBe(false);
  });

  it("sets up every sub-repo when the multi-repo mode is chosen", async () => {
    const reposDir = await mkdtemp(path.join(tmpdir(), "copilot-ext-setup-multi-"));
    const repoA = path.join(reposDir, "service-a");
    const repoB = path.join(reposDir, "service-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(path.join(repoA, "pom.xml"), "<project/>\n", "utf8");
    await writeFile(path.join(repoB, "package.json"), "{}\n", "utf8");

    const fake = createFakeVscode();
    fake.quickPickChoice = "Multiple repos";
    fake.openDialogResult = [{ fsPath: reposDir, toString: () => reposDir }];
    const cliRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    activate(context, fake.vscode, { runner });
    await fake.commands.get("copilotArchitect.setupRepo")?.();

    const argsList = cliRequests.map((request) => request.args);
    // Each sub-repo is registered, then initialized/analyzed/graphed in place.
    expect(argsList).toContainEqual([
      "workspace",
      "add",
      "service-a",
      repoA,
      "--path",
      "/workspace/repo"
    ]);
    for (const repo of [repoA, repoB]) {
      expect(argsList).toContainEqual(["init", "--path", repo]);
      expect(argsList).toContainEqual(["analyze", "--path", repo]);
      expect(argsList).toContainEqual(["graph", "--path", repo]);
      // Assessment is per-repo, not on the parent container folder.
      expect(argsList).toContainEqual(["diagnostics", "--path", repo]);
    }
    expect(argsList).not.toContainEqual(["diagnostics", "--path", "/workspace/repo"]);
    // One combined workspace index rather than a per-repo index.
    expect(argsList).toContainEqual([
      "workspace",
      "index",
      "--path",
      "/workspace/repo"
    ]);
    expect(argsList).not.toContainEqual(["index", "--path", "/workspace/repo"]);
    // Registered repos show up in the Explorer.
    expect(fake.addedFolders.map((folder) => folder.uri.fsPath)).toEqual(
      expect.arrayContaining([repoA, repoB])
    );

    deactivate();
  });

  it("reports failed setup steps instead of aborting the rest of the chain", async () => {
    const fake = createFakeVscode();
    fake.quickPickChoice = "This repo";
    const cliRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          // Fail one step only; later steps must still run.
          exitCode: request.args[0] === "diagnostics" ? 1 : 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    const api = activate(context, fake.vscode, { runner });
    await fake.commands.get("copilotArchitect.setupRepo")?.();

    expect(cliRequests.map((request) => request.args[0])).toContain("mcp");
    expect(api.getState().lastExitCode).toBe(1);

    deactivate();
  });

  it("stops the running MCP server and clears the status", async () => {
    const fake = createFakeVscode();
    let disposed = 0;
    const mcpStarter: McpStarter = {
      start: () => ({ dispose: () => (disposed += 1) })
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    const api = activate(context, fake.vscode, {
      runner: passThroughRunner,
      mcpStarter
    });
    await fake.commands.get("copilotArchitect.startMcp")?.();
    expect(api.getState().mcpStatus).toBe("running");

    await fake.commands.get("copilotArchitect.stopMcp")?.();
    expect(disposed).toBe(1);
    expect(api.getState().mcpStatus).toBe("stopped");

    // Stopping again is a no-op rather than a second dispose on a dead handle.
    await fake.commands.get("copilotArchitect.stopMcp")?.();
    expect(disposed).toBe(1);

    deactivate();
  });

  it("configures and starts MCP in one action", async () => {
    const fake = createFakeVscode();
    const cliRequests: CliRunRequest[] = [];
    const mcpRequests: CliRunRequest[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        cliRequests.push(request);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandLine: createCliCommandLine(request.args)
        };
      }
    };
    const mcpStarter: McpStarter = {
      start: (request) => {
        mcpRequests.push(request);
        return { dispose: () => undefined };
      }
    };
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    const api = activate(context, fake.vscode, { runner, mcpStarter });
    await fake.commands.get("copilotArchitect.startAndSetupMcp")?.();

    expect(cliRequests[0]?.args).toEqual([
      "mcp",
      "config",
      "--path",
      "/workspace/repo"
    ]);
    expect(mcpRequests[0]?.args).toEqual(["mcp", "--path", "/workspace/repo"]);
    expect(api.getState().mcpStatus).toBe("running");

    deactivate();
  });

  it("routes the More actions quick pick to the chosen command", async () => {
    const fake = createFakeVscode();
    fake.quickPickChoice = "Build Symbol Graph";
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    activate(context, fake.vscode, { runner: passThroughRunner });
    await fake.commands.get("copilotArchitect.moreActions")?.();

    expect(fake.quickPickItems[0]?.map((item) => item.label)).toEqual(
      COPILOT_ARCHITECT_SECONDARY_ACTIONS.map((action) => action.label)
    );
    expect(
      fake.executeCommandCalls.some(
        (call) => call.command === "copilotArchitect.buildGraph"
      )
    ).toBe(true);

    deactivate();
  });

  it("opens the selected repo in the same window so the extension stays active", async () => {
    const fake = createFakeVscode();
    fake.openDialogResult = [
      { fsPath: "/some/other/repo", toString: () => "/some/other/repo" }
    ];
    const context: ExtensionContextLike = {
      subscriptions: [],
      extensionPath: "/workspace/ext-root/packages/vscode-extension"
    };

    activate(context, fake.vscode, { runner: passThroughRunner });
    await fake.commands.get("copilotArchitect.openRepoInNewWindow")?.();

    const openCall = fake.executeCommandCalls.find(
      (call) => call.command === "vscode.openFolder"
    );
    expect(openCall).toBeDefined();
    expect(openCall?.args[0]).toMatchObject({ fsPath: "/some/other/repo" });
    expect(openCall?.args[1]).toEqual({ forceNewWindow: false });

    deactivate();
  });

  it("loads live dashboard values from .copilot-architect artifacts", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-ext-dash-"));
    const ca = path.join(repoRoot, ".copilot-architect");
    await mkdir(path.join(ca, "plans"), { recursive: true });
    await mkdir(path.join(ca, "runs"), { recursive: true });
    await mkdir(path.join(ca, "reviews"), { recursive: true });
    await mkdir(path.join(repoRoot, ".github", "agents"), { recursive: true });

    await writeFile(
      path.join(ca, "repo-map.json"),
      JSON.stringify({
        summary: { primaryLanguages: ["TypeScript"], primaryFrameworks: ["React"] }
      }),
      "utf8"
    );
    await writeFile(
      path.join(ca, "plans", "latest-plan.json"),
      JSON.stringify({
        title: "Add invoice approval",
        status: "draft",
        generatedAt: "2026-06-21T10:00:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(ca, "runs", "latest-validation.json"),
      JSON.stringify({
        status: "passed",
        generatedAt: "2026-06-21T11:00:00.000Z",
        results: [{ status: "passed" }, { status: "failed" }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(ca, "reviews", "latest-review.json"),
      JSON.stringify({ summary: "Looks good", findings: [{}, {}, {}] }),
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, ".github", "agents", "FeatureArchitect.agent.md"),
      "# agent",
      "utf8"
    );
    await writeFile(
      path.join(ca, "workspace.json"),
      JSON.stringify({ repos: [{ name: "a" }, { name: "b" }] }),
      "utf8"
    );

    const artifacts = await loadDashboardArtifacts(repoRoot);

    expect(artifacts.languages).toEqual(["TypeScript"]);
    expect(artifacts.frameworks).toEqual(["React"]);
    expect(artifacts.latestPlan?.title).toBe("Add invoice approval");
    expect(artifacts.latestValidation).toMatchObject({
      status: "passed",
      passed: 1,
      total: 2
    });
    expect(artifacts.latestReview?.findingCount).toBe(3);
    expect(artifacts.agentCount).toBe(1);
    expect(artifacts.repoCount).toBe(2);
  });

  it("returns empty artifacts when none are on disk", async () => {
    const artifacts = await loadDashboardArtifacts(
      path.join(tmpdir(), `copilot-missing-${Date.now()}`)
    );
    expect(artifacts.languages).toBeUndefined();
    expect(artifacts.latestPlan).toBeUndefined();
    expect(artifacts.agentCount).toBe(0);
    expect(artifacts.contextInsights).toBeUndefined();
  });

  it("measures the latest plan's selection against the whole indexed repo", async () => {
    const repoRoot = await createInsightsRepo({
      // 4000 chars indexed, 800 of which the plan selected → 80% smaller.
      documents: [
        { relativePath: "src/invoice.ts", fileSizeBytes: 800 },
        { relativePath: "src/unrelated-a.ts", fileSizeBytes: 1600 },
        { relativePath: "src/unrelated-b.ts", fileSizeBytes: 1600 }
      ],
      plan: {
        task: "Add invoice approval workflow",
        relevantFiles: [{ filePath: "src/invoice.ts" }]
      }
    });

    const { contextInsights } = await loadDashboardArtifacts(repoRoot);

    expect(contextInsights).toEqual({
      repoFileCount: 3,
      repoEstimatedTokens: 1000,
      selectedFileCount: 1,
      selectedEstimatedTokens: 200,
      reductionPercent: 80,
      request: "Add invoice approval workflow"
    });
    const rendered = formatAgentInsights({ contextInsights });
    expect(rendered).toContain("Without Copilot Architect: 3 files");
    expect(rendered).toContain("With Copilot Architect: 1 file ");
    expect(rendered).toContain("Sends 80% less");
    expect(rendered).toContain("Add invoice approval workflow");
    // The baseline stays spelled out so "without" is never read as a measured
    // Copilot figure.
    expect(rendered).toContain("whole-repo context");
  });

  it("ignores plan files that are not in the index", async () => {
    const repoRoot = await createInsightsRepo({
      documents: [{ relativePath: "src/invoice.ts", fileSizeBytes: 400 }],
      plan: {
        task: "Add invoice approval",
        // A doc file the indexer skipped — it must not inflate the selection.
        relevantFiles: [{ filePath: "src/invoice.ts" }, { filePath: "notes/design.md" }]
      }
    });

    const { contextInsights } = await loadDashboardArtifacts(repoRoot);

    expect(contextInsights?.selectedFileCount).toBe(1);
    expect(contextInsights?.selectedEstimatedTokens).toBe(100);
  });

  it("asks for a plan when the repo is indexed but nothing is planned yet", async () => {
    const repoRoot = await createInsightsRepo({
      documents: [{ relativePath: "src/invoice.ts", fileSizeBytes: 400 }]
    });

    const artifacts = await loadDashboardArtifacts(repoRoot);

    expect(artifacts.contextInsights?.selectedFileCount).toBe(0);
    expect(formatAgentInsights(artifacts)).toContain("No plan yet");
    expect(formatAgentInsights(artifacts)).toContain(
      "Without Copilot Architect: 1 file"
    );
  });

  it("asks for setup when there is no index to measure against", () => {
    expect(formatAgentInsights(undefined)).toContain("run Setup Repo");
    expect(formatAgentInsights({})).toContain("run Setup Repo");
  });

  it("renders live artifact values into the dashboard cards", () => {
    const html = createDashboardHtml({
      workspaceRoot: "/workspace/repo",
      mcpStatus: "running",
      artifacts: {
        languages: ["TypeScript", "Python"],
        frameworks: ["React"],
        latestPlan: {
          title: "Add invoice approval",
          status: "draft",
          generatedAt: "2026-06-21T10:00:00.000Z"
        },
        latestValidation: {
          status: "passed",
          passed: 3,
          total: 4,
          generatedAt: "2026-06-21T11:00:00.000Z"
        },
        latestReview: { summary: "All clear", findingCount: 2 },
        agentCount: 7,
        repoCount: 2
      }
    });

    expect(html).toContain("TypeScript, Python");
    expect(html).toContain("React");
    expect(html).toContain("Add invoice approval");
    expect(html).toContain("3/4 passed");
    expect(html).toContain("7 agent(s) installed");
    expect(html).toContain("2 registered repo(s)");
  });

  it("renders the required dashboard sections without reading business artifacts", () => {
    const html = createDashboardHtml({
      workspaceRoot: "/workspace/repo",
      mcpStatus: "stopped",
      lastCommand: "npm run cli -- analyze",
      lastExitCode: 0,
      lastStdout: "analysis complete",
      lastStderr: ""
    });

    expect(html).toContain("Current work");
    expect(html).toContain("Repo summary");
    expect(html).toContain("Languages/frameworks");
    expect(html).toContain("Plans");
    expect(html).toContain("Validation runs");
    expect(html).toContain("Review reports");
    expect(html).toContain("Agent status");
    expect(html).toContain("MCP status");
    expect(html).toContain("Agent insights");
  });

  it("renders exactly the five primary actions plus More actions", () => {
    const html = createDashboardHtml({
      workspaceRoot: "/workspace/repo",
      mcpStatus: "stopped"
    });

    for (const action of DASHBOARD_PRIMARY_ACTIONS) {
      expect(html).toContain(`command:${action.id}`);
    }
    expect(html).toContain("command:copilotArchitect.moreActions");

    // Secondary actions are reachable only through the quick pick, so the
    // sidebar shows one row of buttons instead of eleven wrapped links.
    for (const action of COPILOT_ARCHITECT_SECONDARY_ACTIONS) {
      expect(html).not.toContain(`command:${action.id}`);
    }
    expect(html.match(/<a href="command:/g)).toHaveLength(
      DASHBOARD_PRIMARY_ACTIONS.length + 1
    );
  });

  it("sees every registered repo, not just the workspace root", async () => {
    // Regression: `@architect Analyze repo and explain more about R2D2` replied
    // "the provided context is empty — the only file shown is workspace.json".
    // The Q&A path read the workspace root's own index, which on a multi-repo
    // workspace indexes nothing but registration. Retrieval now goes through
    // IndexingService, but the guarantee this protects is unchanged.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-ws-ctx-"));
    await writeWorkspace(workspaceRoot, ["svc-orders", "web-ui"]);
    await writeSource(
      workspaceRoot,
      "svc-orders/src/main/java/com/acme/R2D2Service.java",
      "package com.acme;\npublic class R2D2Service { public void astromech() {} }"
    );
    await writeSource(
      workspaceRoot,
      "web-ui/src/app/r2d2.component.ts",
      'export class R2d2Component { droid = "R2D2"; }'
    );

    const context = await buildRepoContext(workspaceRoot, "R2D2");

    // Both repos reachable, and paths are relative to the WORKSPACE root —
    // readFilesForLmContext resolves them with path.join(workspaceRoot, rel),
    // so a path relative to a sub-repo would silently fail to open.
    const anchored = context.fileAnchors.map((anchor) => anchor.relativePath);
    expect(anchored).toContain("svc-orders/src/main/java/com/acme/R2D2Service.java");
    expect(anchored).toContain("web-ui/src/app/r2d2.component.ts");
  });

  it("names why a context is empty instead of implying the repo is", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-ws-empty-"));
    await writeWorkspace(workspaceRoot, ["svc-orders", "web-ui"]);

    const unindexed = await diagnoseEmptyContext(workspaceRoot);
    expect(unindexed).toContain("No searchable index");
    expect(unindexed).toContain("Setup Repo");

    // Once indexed, an empty result is a miss, not a missing setup step — the
    // two used to be indistinguishable to the user.
    await writeRepoIndex(workspaceRoot, "svc-orders");
    await writeRepoIndex(workspaceRoot, "web-ui");
    const searched = await diagnoseEmptyContext(workspaceRoot);
    expect(searched).toContain("nothing matched");
    expect(searched).not.toContain("No searchable index");
  });

  it("stops rebuilding a workspace graph for repos that share no code", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-ws-graph-"));
    const marker = async (state: Record<string, unknown>) => {
      await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
      await writeFile(
        path.join(workspaceRoot, ".copilot-architect", "graph-workspace.json"),
        JSON.stringify(state),
        "utf8"
      );
    };

    // Never built — nothing is known yet, so build it.
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["a", "b"])).toBe(true);

    // Learned that these repos share no code: a rebuild would parse every file
    // again to find the same nothing.
    await marker({ repos: ["a", "b"], crossRepoEdgeCount: 0 });
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["a", "b"])).toBe(false);
    // Order must not matter.
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["b", "a"])).toBe(false);

    // A new repo can introduce the first shared dependency, so re-check.
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["a", "b", "c"])).toBe(true);
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["a"])).toBe(true);

    // Repos that DO share code keep their graph current.
    await marker({ repos: ["a", "b"], crossRepoEdgeCount: 4 });
    expect(await shouldBuildWorkspaceGraph(workspaceRoot, ["a", "b"])).toBe(true);
  });

  it("offers four phases, not a menu of twelve", async () => {
    // The R2D2 report was this problem: the user wrote "Code Analysis Agent"
    // and typed @architect — two different systems. One door, four steps.
    const manifest = JSON.parse(
      await readFile(path.join("packages", "vscode-extension", "package.json"), "utf8")
    );
    const participant = manifest.contributes.chatParticipants[0];

    expect(participant.name).toBe("architect");
    expect(participant.commands.map((c: { name: string }) => c.name)).toEqual([
      "analyze",
      "create-plan",
      "implement",
      "review",
      "help"
    ]);

    // Approve and End are commands, so they can be rendered as buttons. The
    // gate that authorizes writing code must not rest on reading sentiment.
    const ids = manifest.contributes.commands.map(
      (c: { command: string }) => c.command
    );
    expect(ids).toContain("copilotArchitect.approvePlan");
    expect(ids).toContain("copilotArchitect.endSession");
  });

  it("states the no-command rule rather than guessing intent", () => {
    const help = getChatHelpText();

    expect(help).toContain("/create-plan");
    expect(help).toContain("No slash command means `/analyze`");
    // The old routing inferred "question" vs "plan" from wording, so the same
    // sentence could route two ways on two days.
    expect(help).not.toContain("/plan <feature>");
    expect(help).not.toContain("/diagnostics");
  });
});

interface FakeVscode {
  vscode: VscodeApiLike;
  commands: Map<string, (...args: unknown[]) => Promise<unknown> | unknown>;
  input: string | undefined;
  viewProviderId: string | undefined;
  openDialogResult: UriLike[] | undefined;
  executeCommandCalls: Array<{ command: string; args: unknown[] }>;
  addedFolders: Array<{ uri: UriLike; name?: string }>;
  /** Label the fake quick pick resolves to; undefined mimics a dismissed picker. */
  quickPickChoice: string | undefined;
  quickPickItems: QuickPickItemLike[][];
  /** The staged-content provider the extension registered, if it did. */
  contentProvider:
    { provideTextDocumentContent(uri: UriLike): string | undefined } | undefined;
}

/** Writes just the index (and optionally plan) artifacts the insights card reads. */
async function createInsightsRepo(fixture: {
  documents: Array<{ relativePath: string; fileSizeBytes: number }>;
  plan?: { task?: string; relevantFiles?: Array<{ filePath: string }> };
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-ext-insights-"));
  const artifactRoot = path.join(repoRoot, ".copilot-architect");
  await mkdir(path.join(artifactRoot, "index"), { recursive: true });
  await writeFile(
    path.join(artifactRoot, "index", "index.json"),
    JSON.stringify({ documents: fixture.documents }),
    "utf8"
  );

  if (fixture.plan) {
    await mkdir(path.join(artifactRoot, "plans"), { recursive: true });
    await writeFile(
      path.join(artifactRoot, "plans", "latest-plan.json"),
      JSON.stringify(fixture.plan),
      "utf8"
    );
  }

  return repoRoot;
}

function createFakeVscode(workspaceRoot = "/workspace/repo"): FakeVscode {
  const commands = new Map<
    string,
    (...args: unknown[]) => Promise<unknown> | unknown
  >();
  const fake: FakeVscode = {
    commands,
    input: undefined,
    viewProviderId: undefined,
    openDialogResult: undefined,
    executeCommandCalls: [],
    addedFolders: [],
    quickPickChoice: undefined,
    quickPickItems: [],
    contentProvider: undefined,
    vscode: {
      commands: {
        registerCommand: (command, callback): DisposableLike => {
          commands.set(command, callback);
          return { dispose: () => commands.delete(command) };
        },
        executeCommand: async (command, ...args) => {
          fake.executeCommandCalls.push({ command, args });
          return undefined;
        }
      },
      window: {
        createOutputChannel: () => ({
          appendLine: () => undefined,
          show: () => undefined,
          dispose: () => undefined
        }),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        showInputBox: async () => fake.input,
        showOpenDialog: async () => fake.openDialogResult,
        showQuickPick: async (items: QuickPickItemLike[]) => {
          fake.quickPickItems.push(items);
          return items.find((item) => item.label === fake.quickPickChoice);
        },
        registerWebviewViewProvider: (
          viewId: string,
          provider: WebviewViewProviderLike
        ): DisposableLike => {
          fake.viewProviderId = viewId;
          provider.resolveWebviewView({ webview: { html: "" } });
          return { dispose: () => undefined };
        },
        createWebviewPanel: () => ({
          webview: { html: "" },
          reveal: () => undefined,
          dispose: () => undefined
        }),
        createTerminal: () => ({
          sendText: () => undefined,
          show: () => undefined,
          dispose: () => undefined
        })
      },
      workspace: {
        workspaceFolders: [
          {
            uri: {
              fsPath: workspaceRoot,
              toString: () => workspaceRoot
            },
            name: path.basename(workspaceRoot),
            index: 0
          }
        ],
        updateWorkspaceFolders: (_start, _deleteCount, ...folders) => {
          fake.addedFolders.push(...folders);
          return true;
        },
        registerTextDocumentContentProvider: (_scheme, provider) => {
          fake.contentProvider = provider;
          return { dispose: () => undefined };
        }
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath, toString: () => fsPath })
      },
      ViewColumn: {
        One: 1
      }
    }
  };

  return fake;
}

async function writeWorkspace(workspaceRoot: string, repos: string[]): Promise<void> {
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify({ repos: repos.map((name) => ({ name, path: name })) }),
    "utf8"
  );
}

describe("the analyze prompt", () => {
  it("sends the role, rather than computing it and dropping it", () => {
    // The bug: the "question" branch — the one /analyze uses — never
    // referenced the role it was handed. Phase 5 replaced the .agent.md files
    // with roles invoked by code, on the argument that a role invoked by code
    // cannot skip its steps. This branch skipped it for every answer.
    const prompt = buildCommandLmPrompt(
      "question",
      "How does authentication work?",
      renderRolePrompt("analyze"),
      "Repository: 8 files"
    );

    expect(prompt).toContain("Cite `file:line`");
    expect(prompt).toContain("Zero matches mean the query missed");
    expect(prompt).toContain("Say what you did not see");
  });

  it("carries the question, the repo context and the file context", () => {
    const prompt = buildCommandLmPrompt(
      "question",
      "How does authentication work?",
      renderRolePrompt("analyze"),
      "Repository: 8 files",
      "src/Auth.java contents"
    );

    expect(prompt).toContain("How does authentication work?");
    expect(prompt).toContain("Repository: 8 files");
    expect(prompt).toContain("src/Auth.java contents");
  });
});

describe("the analyze role", () => {
  it("says the developer owns this code", () => {
    // Without it, a request to audit one's own repository reads as a request
    // to find weaknesses in someone else's, and gets declined.
    const rendered = renderRolePrompt("analyze");

    expect(rendered).toContain("developer owns this code");
    expect(rendered).toContain("open in their editor");
  });

  it("treats reviewing for weaknesses as part of the job", () => {
    // Reported: "/analyze identify the security gaps" returned "Sorry, I
    // can't assist with that." Declining leaves the weakness in place.
    const rendered = renderRolePrompt("analyze");

    expect(rendered).toContain("part of the job, not outside it");
    expect(rendered).toContain("security");
  });

  it("asks for the fix and not the exploit", () => {
    const rendered = renderRolePrompt("analyze");

    expect(rendered).toContain("Do not write an exploit");
    expect(rendered).toContain("needs the fix, not the attack");
  });

  it("keeps the lesson that an empty search is not a clean repo", () => {
    // Recovered from the SecurityReviewer role dropped in Phase 5: the
    // costliest security answer is a confident "no issues found" produced by
    // searching for the wrong words.
    const rendered = renderRolePrompt("analyze");

    expect(rendered).toContain("not the same as a clean repository");
  });

  it("locates a secret without quoting it", () => {
    const rendered = renderRolePrompt("analyze");

    expect(rendered).toContain("without quoting its value");
    expect(rendered).toContain("rotated");
  });
});

describe("proposed decisions", () => {
  it("reads well-formed proposals", () => {
    const proposals = parseProposedDecisions(
      [
        "design | Approvals are recorded per invoice, not per batch | a batch-level table",
        "scope | Changes stay inside the billing service"
      ].join("\n")
    );

    expect(proposals).toEqual([
      {
        kind: "design",
        statement: "Approvals are recorded per invoice, not per batch",
        rejected: "a batch-level table"
      },
      { kind: "scope", statement: "Changes stay inside the billing service" }
    ]);
  });

  it("drops anything it cannot read rather than guessing", () => {
    // One click turns a proposal into a recorded decision that binds
    // implementation. A parser that reconstructs meaning from a malformed
    // line would put words in the developer's mouth.
    const proposals = parseProposedDecisions(
      [
        "Here are the decisions I propose:",
        "1. We should probably use Kafka",
        "urgency | Ship it by Friday",
        "design | short",
        "design |",
        "| Approvals are per invoice"
      ].join("\n")
    );

    expect(proposals).toEqual([]);
  });

  it("tolerates the bullets and fences models add anyway", () => {
    const proposals = parseProposedDecisions(
      "- constraint | Do not modify the shared schema package\n" +
        "* fact | OrderService is deprecated and should not gain callers"
    );

    expect(proposals.map((p) => p.kind)).toEqual(["constraint", "fact"]);
  });

  it("does not propose the same decision twice", () => {
    const proposals = parseProposedDecisions(
      [
        "scope | Changes stay inside the billing service",
        "scope | changes stay inside the billing service"
      ].join("\n")
    );

    expect(proposals).toHaveLength(1);
  });

  it("reads the id of a decision being replaced", () => {
    const proposals = parseProposedDecisions(
      "design | Approvals are recorded per batch after all | per-invoice approval | d1"
    );

    expect(proposals).toEqual([
      {
        kind: "design",
        statement: "Approvals are recorded per batch after all",
        rejected: "per-invoice approval",
        replaces: "d1"
      }
    ]);
  });

  it("reads a replacement with no rejected alternative", () => {
    const proposals = parseProposedDecisions(
      "scope | Changes now include the orders service | | d2"
    );

    expect(proposals[0]).toEqual({
      kind: "scope",
      statement: "Changes now include the orders service",
      replaces: "d2"
    });
  });

  it("ignores anything in the id field that is not an id", () => {
    // A model narrating — "replaces the earlier scope decision" — must not
    // become a supersedes. Superseding the wrong decision silently is worse
    // than the contradiction this field exists to fix.
    const proposals = parseProposedDecisions(
      [
        "design | Approvals are per batch | per invoice | the earlier decision",
        "scope | Billing service only | orders too | decision 1",
        "fact | OrderService is deprecated now | | D1"
      ].join("\n")
    );

    expect(proposals.every((proposal) => proposal.replaces === undefined)).toBe(true);
  });

  it("caps the list so it stays a decision, not a survey", () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `design | Decision number ${i} about the service layer`
    ).join("\n");

    expect(parseProposedDecisions(many)).toHaveLength(4);
  });
});

describe("staged diff URIs", () => {
  it("round-trips a workspace and path", () => {
    const uri = stagedUri("/home/dev/my repo", "src/billing/InvoiceService.ts");

    expect(uri.startsWith(`${STAGED_SCHEME}:/`)).toBe(true);
    expect(parseStagedUri(uri)).toEqual({
      workspaceRoot: "/home/dev/my repo",
      relativePath: "src/billing/InvoiceService.ts",
      side: "staged"
    });
  });

  it("keeps the real filename in the path so the diff title names the file", () => {
    // The title is the only place a developer can tell which file they are
    // looking at, so the path component cannot be an opaque id.
    const uri = stagedUri("/repo", "src/billing/ApprovalPolicy.ts");
    expect(uri).toContain("src/billing/ApprovalPolicy.ts");
  });

  it("marks the empty side of an add or a delete", () => {
    const empty = stagedUri("/repo", "src/new.ts", "empty");
    expect(parseStagedUri(empty)?.side).toBe("empty");
  });

  it("survives a workspace path containing a query character", () => {
    const uri = stagedUri("/home/dev/repo?weird&name", "src/a.ts");
    expect(parseStagedUri(uri)?.workspaceRoot).toBe("/home/dev/repo?weird&name");
  });

  it("refuses anything that is not a staged URI", () => {
    expect(parseStagedUri("file:///repo/src/a.ts")).toBeUndefined();
    expect(parseStagedUri(`${STAGED_SCHEME}:/src/a.ts`)).toBeUndefined();
    expect(parseStagedUri(`${STAGED_SCHEME}:/src/a.ts?side=staged`)).toBeUndefined();
  });
});

describe("the staged content provider", () => {
  it("serves an empty document for the other side of an add", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-provider-"));
    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    const empty = stagedUri(workspaceRoot, "src/new.ts", "empty");
    expect(
      fake.contentProvider?.provideTextDocumentContent({
        toString: () => empty
      })
    ).toBe("");
  });

  it("serves nothing rather than throwing for an unknown workspace", async () => {
    // A diff editor left open after the staging is gone must render empty,
    // not crash the provider.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-provider-none-"));
    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    expect(
      fake.contentProvider?.provideTextDocumentContent({
        toString: () => stagedUri("/some/other/workspace", "src/a.ts")
      })
    ).toBe("");
    expect(
      fake.contentProvider?.provideTextDocumentContent({
        toString: () => "file:///not/a/staged/uri.ts"
      })
    ).toBe("");
  });
});

describe("showing a staged diff", () => {
  it("says so when the file is no longer staged", async () => {
    // A button from an old chat turn must not open a diff of nothing.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-diff-stale-"));
    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.showStagedDiff")?.("src/gone.ts");

    // No diff was opened; the developer was told why.
    expect(
      fake.executeCommandCalls.some((call) => call.command === "vscode.diff")
    ).toBe(false);
  });

  it("contributes the command so the preview button resolves", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages/vscode-extension/package.json"),
        "utf8"
      )
    );
    const ids = manifest.contributes.commands.map(
      (c: { command: string }) => c.command
    );

    expect(ids).toContain("copilotArchitect.showStagedDiff");
    expect(manifest.activationEvents).toContain(
      "onCommand:copilotArchitect.showStagedDiff"
    );
  });
});

describe("applying staged changes", () => {
  it("writes nothing when the staging is gone", async () => {
    // Staged in memory, so a window reload loses it. Writing content whose
    // preview the developer can no longer see would defeat the preview.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-stale-stage-"));
    await writeFile(path.join(workspaceRoot, "app.ts"), "export const a = 1;", "utf8");

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.applyChanges")?.(1);

    // Untouched: nothing was staged, so nothing was written.
    await expect(readFile(path.join(workspaceRoot, "app.ts"), "utf8")).resolves.toBe(
      "export const a = 1;"
    );
  });

  it("refuses to write over a file edited since the preview", async () => {
    // The defect: generation checked freshness, then Phase 16 split
    // generation from writing and nothing re-checked. The staged content is
    // a complete replacement built from the version the developer had before
    // they touched it, so applying it destroys whatever they did.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-stale-write-"));
    await writeFile(path.join(workspaceRoot, "app.ts"), "export const a = 1;", "utf8");

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    // The developer's own edit, after the preview was built.
    await writeFile(path.join(workspaceRoot, "app.ts"), "export const a = 99;", "utf8");
    await fake.commands.get("copilotArchitect.applyChanges")?.(1);

    await expect(readFile(path.join(workspaceRoot, "app.ts"), "utf8")).resolves.toBe(
      "export const a = 99;"
    );
  });

  it("contributes the apply command so the preview button resolves", async () => {
    // A button whose command is not contributed silently does nothing, which
    // would leave the developer with a preview they cannot act on.
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages/vscode-extension/package.json"),
        "utf8"
      )
    );
    const ids = manifest.contributes.commands.map(
      (c: { command: string }) => c.command
    );

    expect(ids).toContain("copilotArchitect.applyChanges");
    expect(manifest.activationEvents).toContain(
      "onCommand:copilotArchitect.applyChanges"
    );
  });
});

describe("confirming a proposed decision", () => {
  it("records it against the session", async () => {
    // The gap this closes: recordDecision existed and was tested, but no code
    // path called it, so the Decisions block rendered empty forever. This
    // asserts the button actually reaches the session.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-confirm-"));
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add invoice approval" });

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.confirmDecision")?.({
      kind: "scope",
      statement: "Changes stay inside the billing service",
      rejected: "touching the orders service too"
    });

    const session = await sessions.current({ workspaceRoot });
    expect(session?.decisions).toHaveLength(1);
    expect(session?.decisions[0]).toEqual(
      expect.objectContaining({
        kind: "scope",
        statement: "Changes stay inside the billing service",
        rejected: "touching the orders service too"
      })
    );
  });

  it("replaces the decision it supersedes instead of holding both", async () => {
    // The gap this closes: a developer who changed their mind ended up with
    // two contradictory decisions, both active, both reaching the plan and
    // the dashboard with nothing marking which was current.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-supersede-"));
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add invoice approval" });
    await sessions.recordDecision(
      { workspaceRoot },
      { kind: "design", statement: "Approvals are recorded per invoice" }
    );

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.confirmDecision")?.({
      kind: "design",
      statement: "Approvals are recorded per batch after all",
      rejected: "per-invoice approval",
      replaces: "d1"
    });

    const session = await sessions.current({ workspaceRoot });

    // Both are kept — a change of mind keeps its history.
    expect(session?.decisions).toHaveLength(2);
    expect(session?.decisions[1].supersedes).toBe("d1");

    // Only the current one is active, so only it reaches a plan or the card.
    const active = sessions.activeDecisions(session!);
    expect(active).toHaveLength(1);
    expect(active[0].statement).toBe("Approvals are recorded per batch after all");
  });

  it("records the decision anyway when the id it claims to replace is gone", async () => {
    // A chat turn can sit on screen for a long time. recordDecision throws on
    // an id it cannot find, which would lose the developer's click over a
    // stale button — so the id is re-checked and dropped rather than passed.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-stale-id-"));
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add invoice approval" });

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.confirmDecision")?.({
      kind: "scope",
      statement: "Changes stay inside the billing service",
      replaces: "d9"
    });

    const session = await sessions.current({ workspaceRoot });
    expect(session?.decisions).toHaveLength(1);
    expect(session?.decisions[0].supersedes).toBeUndefined();
  });

  it("ignores a click carrying nothing to record", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-confirm-empty-"));
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add invoice approval" });

    const fake = createFakeVscode(workspaceRoot);
    activate(
      { subscriptions: [], extensionPath: path.join(workspaceRoot, "ext") },
      fake.vscode,
      {
        runner: passThroughRunner,
        mcpStarter: { start: () => ({ dispose: () => undefined }) }
      }
    );

    await fake.commands.get("copilotArchitect.confirmDecision")?.(undefined);
    await fake.commands.get("copilotArchitect.confirmDecision")?.({ kind: "scope" });

    expect((await sessions.current({ workspaceRoot }))?.decisions).toEqual([]);
  });
});

describe("dashboard session card", () => {
  it("tells an idle developer what to type", () => {
    // A blank panel reads as a broken extension.
    const html = formatSession(undefined);

    expect(html).toContain("No session open");
    expect(html).toContain("/create-plan");
  });

  it("shows the feature, phase, plan version and decisions", () => {
    const html = formatSession({
      title: "Add invoice approval",
      phase: "implement",
      decisions: [
        { kind: "design", statement: "Approvals are per invoice" },
        { kind: "scope", statement: "Billing service only" }
      ],
      plans: [
        { version: 1, status: "approved", implemented: true },
        { version: 2, status: "draft", implemented: false }
      ],
      staleBranch: false
    });

    expect(html).toContain("Add invoice approval");
    expect(html).toContain("implement");
    expect(html).toContain("v2 draft");
    expect(html).toContain("1 of 2 approved");
    // Which version is running is what /review compares against.
    expect(html).toContain("implemented v1");
    expect(html).toContain("Decisions (2)");
    expect(html).toContain("Approvals are per invoice");
  });

  it("says a moved branch will park the session, without parking it", () => {
    const html = formatSession({
      title: "Add invoice approval",
      phase: "plan",
      decisions: [],
      plans: [],
      staleBranch: true
    });

    expect(html).toContain("branch has moved");
    expect(html).toContain("none drafted yet");
    expect(html).toContain("none recorded");
  });

  it("escapes session text", () => {
    const html = formatSession({
      title: "<img src=x onerror=alert(1)>",
      phase: "analyze",
      decisions: [{ kind: "fact", statement: "<script>bad()</script>" }],
      plans: [],
      staleBranch: false
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });
});

describe("loadDashboardSession", () => {
  it("reports a session without ending it", async () => {
    // The bug this guards: reading the dashboard used to mean calling
    // current(), which parks a session whose branch moved. Repainting a
    // panel must never end the developer's work.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-dash-session-"));
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add invoice approval" });
    await sessions.recordDecision(
      { workspaceRoot },
      { kind: "scope", statement: "Billing service only" }
    );

    const card = await loadDashboardSession(workspaceRoot, sessions);

    expect(card?.title).toBe("Add invoice approval");
    expect(card?.decisions).toEqual([
      { kind: "scope", statement: "Billing service only" }
    ]);

    // Still active after being looked at, twice.
    await loadDashboardSession(workspaceRoot, sessions);
    expect(await sessions.current({ workspaceRoot })).toBeDefined();
  });

  it("returns nothing when no session is open", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-dash-none-"));
    expect(await loadDashboardSession(workspaceRoot)).toBeUndefined();
  });
});

describe("packaged CLI invocation", () => {
  it("names a command that exists on disk rather than an npm script", () => {
    // The defect this covers: an installed extension has no monorepo, so
    // `npm run cli --` resolved to nothing and every command failed. The
    // command line must name the interpreter and an absolute entry point.
    const commandLine = createCliCommandLine(["analyze"]);

    expect(commandLine).not.toContain("npm run cli");
    expect(commandLine.startsWith(quoteForTest(process.execPath))).toBe(true);

    const entryPoint = commandLine
      .slice(quoteForTest(process.execPath).length)
      .trim()
      .split(" ")[0];
    expect(existsSync(entryPoint)).toBe(true);
  });

  it("echoes exactly what it spawns", async () => {
    // The output channel prints this line and the MCP terminal executes it.
    // A friendly approximation in either place is a command a developer
    // cannot copy, or one the terminal cannot run.
    const seen: string[] = [];
    const runner = {
      run: async (request: CliRunRequest): Promise<CliRunResult> => {
        seen.push(createCliCommandLine(request.args));
        return { exitCode: 0, stdout: "", stderr: "", commandLine: seen.at(-1)! };
      }
    };

    const result = await runner.run({ args: ["plan", "Add invoice approval"] });

    expect(result.commandLine).toBe(seen[0]);
    // An argument with a space stays one argument.
    expect(result.commandLine).toContain('"Add invoice approval"');
  });
});

function quoteForTest(value: string): string {
  return /^[A-Za-z0-9._:/=+-]+$/.test(value) ? value : `"${value}"`;
}

/** diagnoseEmptyContext only checks whether an index file exists. */
async function writeRepoIndex(workspaceRoot: string, repo: string): Promise<void> {
  const indexDir = path.join(workspaceRoot, repo, ".copilot-architect", "index");
  await mkdir(indexDir, { recursive: true });
  await writeFile(
    path.join(indexDir, "index.json"),
    JSON.stringify({ documents: [] }),
    "utf8"
  );
}

async function writeSource(
  workspaceRoot: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const fullPath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}
