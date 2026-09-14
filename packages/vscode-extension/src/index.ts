import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const EXTENSION_ID = "copilotArchitect";
export const VIEW_CONTAINER_ID = "copilotArchitect";
export const DASHBOARD_VIEW_ID = "copilotArchitect.dashboard";
export const DASHBOARD_PANEL_TYPE = "copilotArchitect.panel";
export const OUTPUT_CHANNEL_NAME = "Copilot Architect";
export const CHAT_PARTICIPANT_ID = "copilot-architect.architect";

export interface CopilotArchitectCommand {
  id: string;
  title: string;
  cliArgs: string[];
  prompt?: {
    title: string;
    prompt: string;
    placeHolder: string;
  };
  startsMcp?: boolean;
}

export const COPILOT_ARCHITECT_COMMANDS: CopilotArchitectCommand[] = [
  {
    id: "copilotArchitect.analyzeRepo",
    title: "Copilot Architect: Analyze Repo",
    cliArgs: ["analyze"]
  },
  {
    id: "copilotArchitect.buildIndex",
    title: "Copilot Architect: Build Index",
    cliArgs: ["index"]
  },
  {
    id: "copilotArchitect.generatePlan",
    title: "Copilot Architect: Generate Plan",
    cliArgs: ["plan"],
    prompt: {
      title: "Copilot Architect",
      prompt: "Feature request",
      placeHolder: "Add invoice approval workflow"
    }
  },
  {
    id: "copilotArchitect.validate",
    title: "Copilot Architect: Validate",
    cliArgs: ["validate"]
  },
  {
    id: "copilotArchitect.review",
    title: "Copilot Architect: Review",
    cliArgs: ["review", "--plan", "latest", "--validation", "latest"]
  },
  {
    id: "copilotArchitect.startMcp",
    title: "Copilot Architect: Start MCP",
    cliArgs: ["mcp"],
    startsMcp: true
  },
  {
    id: "copilotArchitect.installAgents",
    title: "Copilot Architect: Install Agents",
    cliArgs: ["agents", "install"]
  },
  {
    id: "copilotArchitect.generateInstructions",
    title: "Copilot Architect: Generate Instructions",
    cliArgs: ["instructions", "generate"]
  }
];

export interface DisposableLike {
  dispose(): void;
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
  extensionUri?: UriLike;
  extensionPath?: string;
}

export interface UriLike {
  fsPath?: string;
  toString(): string;
}

export interface WorkspaceFolderLike {
  uri: UriLike;
  name: string;
  index: number;
}

export interface OutputChannelLike extends DisposableLike {
  appendLine(message: string): void;
  show(preserveFocus?: boolean): void;
}

export interface WebviewLike {
  html: string;
  options?: {
    enableCommandUris?: boolean;
    enableScripts?: boolean;
  };
}

export interface WebviewViewLike {
  webview: WebviewLike;
}

export interface WebviewPanelLike extends DisposableLike {
  webview: WebviewLike;
  reveal(): void;
}

export interface WebviewViewProviderLike {
  resolveWebviewView(webviewView: WebviewViewLike): void;
}

export interface TerminalLike extends DisposableLike {
  sendText(text: string): void;
  show(preserveFocus?: boolean): void;
}

export interface ChatRequestLike {
  command?: string;
  prompt: string;
}

export interface ChatResponseStreamLike {
  markdown(value: string): void;
  progress?(value: string): void;
}

export interface ChatHistoryTurnLike {
  /** Present on user turns. */
  prompt?: string;
  /** Present on assistant turns — array of response parts. */
  response?: Array<{ value?: string }>;
}

export type ChatRequestHandlerLike = (
  request: ChatRequestLike,
  context: { history?: ChatHistoryTurnLike[] },
  stream: ChatResponseStreamLike,
  token: unknown
) => Promise<void> | void;

export interface LanguageModelChatMessageLike {
  role: number;
  content: string | unknown[];
}

export interface LanguageModelResponseLike {
  text: AsyncIterable<string>;
}

export interface LanguageModelLike {
  sendRequest(
    messages: LanguageModelChatMessageLike[],
    options: Record<string, unknown>,
    token: unknown
  ): Promise<LanguageModelResponseLike>;
}

export interface VscodeApiLike {
  commands: {
    registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown
    ): DisposableLike;
    executeCommand?(command: string, ...args: unknown[]): Promise<unknown>;
  };
  window: {
    createOutputChannel(name: string): OutputChannelLike;
    showInformationMessage(message: string): unknown;
    showErrorMessage(message: string): unknown;
    showInputBox?(options: {
      title?: string;
      prompt?: string;
      placeHolder?: string;
    }): Promise<string | undefined>;
    showOpenDialog?(options: {
      canSelectFolders?: boolean;
      canSelectFiles?: boolean;
      openLabel?: string;
      title?: string;
    }): Promise<UriLike[] | undefined>;
    registerWebviewViewProvider?(
      viewId: string,
      provider: WebviewViewProviderLike
    ): DisposableLike;
    createWebviewPanel?(
      viewType: string,
      title: string,
      showOptions: number | { viewColumn?: number },
      options: { enableCommandUris?: boolean; enableScripts?: boolean }
    ): WebviewPanelLike;
    createTerminal?(options: { name: string; cwd?: string }): TerminalLike;
    /** The file the user currently has open in the editor. */
    activeTextEditor?: {
      document: {
        fileName: string;
        getText(): string;
      };
    };
  };
  workspace: {
    workspaceFolders?: WorkspaceFolderLike[];
    updateWorkspaceFolders?(
      start: number,
      deleteCount: number,
      ...workspaceFoldersToAdd: { uri: UriLike; name?: string }[]
    ): boolean;
  };
  Uri?: {
    file(path: string): UriLike;
  };
  ViewColumn?: {
    One: number;
  };
  chat?: {
    createChatParticipant(id: string, handler: ChatRequestHandlerLike): DisposableLike;
  };
  lm?: {
    selectChatModels(selector?: {
      vendor?: string;
      family?: string;
    }): Promise<LanguageModelLike[]>;
    /**
     * Available in VS Code 1.94+ with GitHub Copilot.
     * Returns a float embedding vector for each input string.
     */
    computeEmbeddings?(
      embeddingsModel: string,
      input: string[],
      token?: unknown
    ): Promise<{ values: Array<{ values: number[] | Float32Array }> }>;
  };
  LanguageModelChatMessage?: {
    User(content: string): LanguageModelChatMessageLike;
    Assistant(content: string): LanguageModelChatMessageLike;
  };
}

export interface CliRunRequest {
  args: string[];
  cwd: string;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  commandLine: string;
}

export interface CliRunner {
  run(request: CliRunRequest): Promise<CliRunResult>;
}

export interface McpStarter {
  start(request: CliRunRequest): DisposableLike;
}

export interface ExtensionDependencies {
  runner?: CliRunner;
  mcpStarter?: McpStarter;
}

export interface ExtensionState {
  workspaceRoot: string;
  mcpStatus: "stopped" | "starting" | "running";
  lastCommand?: string;
  lastExitCode?: number;
  lastStdout?: string;
  lastStderr?: string;
  artifacts?: DashboardArtifacts;
}

/** Live values read from `.copilot-architect/` artifacts to populate the dashboard. */
export interface DashboardArtifacts {
  languages?: string[];
  frameworks?: string[];
  latestPlan?: { title: string; status?: string; generatedAt?: string };
  latestValidation?: {
    status?: string;
    generatedAt?: string;
    passed?: number;
    total?: number;
  };
  latestReview?: { summary?: string; generatedAt?: string; findingCount?: number };
  agentCount?: number;
  repoCount?: number;
}

export interface ActivatedExtensionApi {
  runWorkflowCommand(commandId: string): Promise<CliRunResult | undefined>;
  refreshDashboard(): void;
  getState(): ExtensionState;
}

let activeMcpProcess: DisposableLike | undefined;

export function activate(
  context: ExtensionContextLike,
  vscode: VscodeApiLike = loadVscodeApi(),
  dependencies: ExtensionDependencies = {}
): ActivatedExtensionApi {
  const workspaceRoot = getWorkspaceRoot(vscode);
  const extensionRoot = resolveExtensionRoot(context);
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const state: ExtensionState = {
    workspaceRoot,
    mcpStatus: "stopped"
  };
  const runner = dependencies.runner ?? new NodeCliRunner();
  const mcpStarter = dependencies.mcpStarter ?? new TerminalMcpStarter(vscode);
  const dashboard = new DashboardController(vscode, state);

  context.subscriptions.push(outputChannel);

  if (vscode.window.registerWebviewViewProvider) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(DASHBOARD_VIEW_ID, dashboard)
    );
  }

  const runWorkflowCommand = async (
    commandId: string
  ): Promise<CliRunResult | undefined> => {
    const command = COPILOT_ARCHITECT_COMMANDS.find((item) => item.id === commandId);

    if (!command) {
      throw new Error(`Unknown Copilot Architect command: ${commandId}`);
    }

    if (command.startsMcp) {
      activeMcpProcess?.dispose();
      state.mcpStatus = "starting";
      const mcpArgs = [...command.cliArgs, "--path", workspaceRoot];
      outputChannel.appendLine(`$ ${createCliCommandLine(mcpArgs)}`);
      activeMcpProcess = mcpStarter.start({
        args: mcpArgs,
        cwd: extensionRoot,
        onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
      });
      state.mcpStatus = "running";
      state.lastCommand = createCliCommandLine(command.cliArgs);
      dashboard.refresh();
      vscode.window.showInformationMessage("Copilot Architect MCP server started.");
      return undefined;
    }

    const args = await resolveCommandArgs(command, vscode);

    if (!args) {
      return undefined;
    }

    outputChannel.show(true);

    // Workspace-aware overrides: when workspace.json exists, route analyze and index
    // to per-repo workspace commands instead of treating the root as a single project.
    if (command.id === "copilotArchitect.analyzeRepo") {
      const repoRoots = await getRegisteredRepoRoots(workspaceRoot);
      if (repoRoots.length > 0) {
        outputChannel.appendLine(
          `[workspace mode] analyzing ${repoRoots.length} registered repo(s)…`
        );
        let passed = 0;
        for (const repoRoot of repoRoots) {
          const repoArgs = ["analyze", "--path", repoRoot];
          outputChannel.appendLine(`$ ${createCliCommandLine(repoArgs)}`);
          const r = await runner.run({
            args: repoArgs,
            cwd: extensionRoot,
            onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
          });
          if (r.exitCode === 0) passed++;
        }
        state.lastCommand = `analyze (workspace, ${repoRoots.length} repos)`;
        state.lastExitCode = passed === repoRoots.length ? 0 : 1;
        dashboard.refresh();
        vscode.window.showInformationMessage(
          `Analyze complete: ${passed}/${repoRoots.length} repos analyzed.`
        );
        return undefined;
      }
    }

    if (command.id === "copilotArchitect.buildIndex") {
      const repoRoots = await getRegisteredRepoRoots(workspaceRoot);
      if (repoRoots.length > 0) {
        const wsArgs = ["workspace", "index", "--path", workspaceRoot];
        outputChannel.appendLine(`[workspace mode] $ ${createCliCommandLine(wsArgs)}`);
        const r = await runner.run({
          args: wsArgs,
          cwd: extensionRoot,
          onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
        });
        state.lastCommand = createCliCommandLine(wsArgs);
        state.lastExitCode = r.exitCode;
        dashboard.refresh();
        if (r.exitCode === 0) {
          vscode.window.showInformationMessage(
            `Index built across ${repoRoots.length} registered repos.`
          );
        } else {
          vscode.window.showErrorMessage("Workspace index failed. See output.");
        }
        return r;
      }
    }

    if (command.id === "copilotArchitect.generatePlan") {
      const repoRoots = await getRegisteredRepoRoots(workspaceRoot);
      if (repoRoots.length > 0) {
        // workspace plan produces a cross-repo plan; feature request is args[1]
        const wsArgs = ["workspace", "plan", ...args.slice(1), "--path", workspaceRoot];
        outputChannel.appendLine(`[workspace mode] $ ${createCliCommandLine(wsArgs)}`);
        const r = await runner.run({
          args: wsArgs,
          cwd: extensionRoot,
          onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
        });
        state.lastCommand = createCliCommandLine(wsArgs);
        state.lastExitCode = r.exitCode;
        dashboard.refresh();
        if (r.exitCode === 0) {
          vscode.window.showInformationMessage(
            `Workspace plan generated across ${repoRoots.length} repos.`
          );
        } else {
          vscode.window.showErrorMessage("Workspace plan failed. See output.");
        }
        return r;
      }
    }

    if (command.id === "copilotArchitect.validate") {
      const repoRoots = await getRegisteredRepoRoots(workspaceRoot);
      if (repoRoots.length > 0) {
        outputChannel.appendLine(
          `[workspace mode] validating ${repoRoots.length} repo(s)…`
        );
        let passed = 0;
        for (const repoRoot of repoRoots) {
          const repoArgs = ["validate", "--path", repoRoot];
          outputChannel.appendLine(`$ ${createCliCommandLine(repoArgs)}`);
          const r = await runner.run({
            args: repoArgs,
            cwd: extensionRoot,
            onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
          });
          if (r.exitCode === 0) passed++;
        }
        state.lastCommand = `validate (workspace, ${repoRoots.length} repos)`;
        state.lastExitCode = passed === repoRoots.length ? 0 : 1;
        dashboard.refresh();
        if (passed === repoRoots.length) {
          vscode.window.showInformationMessage(
            `Validation passed: all ${repoRoots.length} repos.`
          );
        } else {
          vscode.window.showErrorMessage(
            `Validation: ${passed}/${repoRoots.length} repos passed. See output for details.`
          );
        }
        return undefined;
      }
    }

    if (command.id === "copilotArchitect.review") {
      const repoRoots = await getRegisteredRepoRoots(workspaceRoot);
      if (repoRoots.length > 0) {
        outputChannel.appendLine(
          `[workspace mode] reviewing ${repoRoots.length} repo(s)…`
        );
        let passed = 0;
        for (const repoRoot of repoRoots) {
          const repoArgs = [
            "review",
            "--plan",
            "latest",
            "--validation",
            "latest",
            "--path",
            repoRoot
          ];
          outputChannel.appendLine(`$ ${createCliCommandLine(repoArgs)}`);
          const r = await runner.run({
            args: repoArgs,
            cwd: extensionRoot,
            onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
          });
          if (r.exitCode === 0) passed++;
        }
        state.lastCommand = `review (workspace, ${repoRoots.length} repos)`;
        state.lastExitCode = passed > 0 ? 0 : 1;
        dashboard.refresh();
        vscode.window.showInformationMessage(
          `Review complete: ${passed}/${repoRoots.length} repos reviewed. See .copilot-architect/reviews/ in each repo.`
        );
        return undefined;
      }
    }

    // Single-repo (default) path
    const argsWithPath = [...args, "--path", workspaceRoot];
    const commandLine = createCliCommandLine(argsWithPath);
    outputChannel.appendLine(`$ ${commandLine}`);

    const result = await runner.run({
      args: argsWithPath,
      cwd: extensionRoot,
      onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
    });

    state.lastCommand = commandLine;
    state.lastExitCode = result.exitCode;
    state.lastStdout = trimForDashboard(result.stdout);
    state.lastStderr = trimForDashboard(result.stderr);
    dashboard.refresh();

    if (result.exitCode === 0) {
      vscode.window.showInformationMessage(`${command.title} completed.`);
    } else {
      vscode.window.showErrorMessage(`${command.title} failed. See output.`);
    }

    return result;
  };

  for (const command of COPILOT_ARCHITECT_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command.id, () => runWorkflowCommand(command.id))
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotArchitect.openDashboard", () =>
      dashboard.openPanel()
    ),
    vscode.commands.registerCommand("copilotArchitect.refreshDashboard", () =>
      dashboard.refresh()
    ),
    vscode.commands.registerCommand(
      "copilotArchitect.openRepoInNewWindow",
      async () => {
        const uris = await vscode.window.showOpenDialog?.({
          canSelectFolders: true,
          canSelectFiles: false,
          openLabel: "Open Repo",
          title: "Select a repository folder to open"
        });
        if (!uris || uris.length === 0) return;
        // Open in the SAME window so the already-running extension re-activates
        // against the selected repo. Forcing a new window can launch a plain
        // window where this extension is not loaded (notably for dev/unpacked
        // installs), which is why the repo previously opened without Copilot
        // Architect features.
        await vscode.commands.executeCommand?.("vscode.openFolder", uris[0], {
          forceNewWindow: false
        });
      }
    ),
    vscode.commands.registerCommand("copilotArchitect.setupMcp", async () => {
      outputChannel.appendLine("$ npm run cli -- mcp config --path " + workspaceRoot);
      outputChannel.show(true);
      const result = await runner.run({
        args: ["mcp", "config", "--path", workspaceRoot],
        cwd: extensionRoot,
        onOutput: (_s, t) => outputChannel.appendLine(t)
      });
      if (result.exitCode === 0) {
        const action = await (
          vscode.window.showInformationMessage as (
            msg: string,
            ...items: string[]
          ) => Promise<string | undefined>
        )(
          "MCP server configured. Reload the window to activate Copilot Architect tools.",
          "Reload Window"
        );
        if (action === "Reload Window") {
          await vscode.commands.executeCommand?.("workbench.action.reloadWindow");
        }
      } else {
        vscode.window.showErrorMessage(
          "MCP config failed. Check the Output channel for details."
        );
      }
    }),
    vscode.commands.registerCommand("copilotArchitect.workspaceScan", async () => {
      // Ask the user which folder contains the sub-repos (e.g. repos/, services/, etc.)
      const uris = await vscode.window.showOpenDialog?.({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "Select Repos Folder",
        title: "Select the folder whose immediate sub-directories are your repositories"
      });
      const reposDir = uris?.[0]?.fsPath;
      if (!reposDir) return;

      let subDirs: string[];
      try {
        const entries = await readdir(reposDir, { withFileTypes: true });
        subDirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => path.join(reposDir, e.name));
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not read folder: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (subDirs.length === 0) {
        vscode.window.showInformationMessage(
          "No sub-directories found in the selected folder."
        );
        return;
      }

      outputChannel.appendLine(
        `[workspace scan] ${subDirs.length} repo(s) found in ${reposDir}`
      );
      outputChannel.show(true);

      // 1. Initialize workspace at the workspace root — skip if workspace.json already
      // exists so that previously registered repos are not lost on a re-scan.
      const existingWorkspace = await readJsonSafe<unknown>(
        path.join(workspaceRoot, ".copilot-architect", "workspace.json")
      );
      if (!existingWorkspace) {
        await runner.run({
          args: ["workspace", "init", "--path", workspaceRoot],
          cwd: extensionRoot,
          onOutput: (_s, t) => outputChannel.appendLine(t)
        });
      }

      // 2. Register each sub-directory as a named repo. The CLI takes the repo
      // name and path as positional arguments — passing the name via --name
      // would set the *workspace* name instead and leave the repo unnamed.
      const registeredDirs: string[] = [];
      for (const subDir of subDirs) {
        const repoName = path.basename(subDir);
        const result = await runner.run({
          args: ["workspace", "add", repoName, subDir, "--path", workspaceRoot],
          cwd: extensionRoot,
          onOutput: (_s, t) => outputChannel.appendLine(t)
        });
        if (result.exitCode === 0) {
          registeredDirs.push(subDir);
          outputChannel.appendLine(`✓ registered: ${repoName}`);
        } else {
          outputChannel.appendLine(`✗ failed:     ${repoName}`);
        }
      }

      if (registeredDirs.length === 0) {
        vscode.window.showErrorMessage(
          "No repos could be registered. Check the Output channel for details."
        );
        return;
      }

      // 3. Analyze each repo that was actually registered (not the first N by
      // count) so repo-map.json is created in every registered sub-repo folder.
      outputChannel.appendLine(
        `\n[workspace scan] analyzing ${registeredDirs.length} repo(s)…`
      );
      vscode.window.showInformationMessage(
        `Registered ${registeredDirs.length} repos — analyzing each one, please wait…`
      );
      for (const subDir of registeredDirs) {
        const repoName = path.basename(subDir);
        outputChannel.appendLine(`  → analyze: ${repoName}`);
        await runner.run({
          args: ["analyze", "--path", subDir],
          cwd: extensionRoot,
          onOutput: (_s, t) => outputChannel.appendLine(t)
        });
      }

      // 4. Build a combined workspace index (creates index.json in every sub-repo folder)
      outputChannel.appendLine(`\n[workspace scan] building workspace index…`);
      await runner.run({
        args: ["workspace", "index", "--path", workspaceRoot],
        cwd: extensionRoot,
        onOutput: (_s, t) => outputChannel.appendLine(t)
      });

      // 5. Surface the registered repos in the Explorer by adding them as
      // workspace folders — otherwise the scan only updates workspace.json and
      // the file tree keeps showing the original repo.
      const added = addWorkspaceFolders(vscode, registeredDirs);

      state.lastCommand = `workspace scan + index (${registeredDirs.length} repos)`;
      state.lastExitCode = 0;
      dashboard.refresh();
      vscode.window.showInformationMessage(
        `Done! ${registeredDirs.length} repos analyzed and indexed${
          added > 0 ? ` and added to the Explorer` : ""
        }. Use @architect /search or /plan to work across all repos.`
      );
    })
  );

  if (vscode.chat) {
    const chatHandler: ChatRequestHandlerLike = async (
      request,
      context,
      stream,
      token
    ) => {
      if (request.command === "help" || (!request.command && !request.prompt.trim())) {
        stream.markdown(getChatHelpText());
        return;
      }

      const args = resolveChatCommandArgs(request.command, request.prompt.trim());
      if (!args) {
        stream.markdown(
          `Unknown command \`/${request.command}\`. Use \`/help\` to see available commands.`
        );
        return;
      }

      // args[0] is the actual CLI command regardless of whether the user used a slash command
      const cliCommand = args[0];

      // Workspace-aware arg resolution: workspace plan uses the workspace root and all repos
      const chatRepoRoots = await getRegisteredRepoRoots(workspaceRoot);
      let runArgs: string[];
      if (chatRepoRoots.length > 0 && cliCommand === "plan") {
        runArgs = ["workspace", "plan", ...args.slice(1), "--path", workspaceRoot];
      } else {
        runArgs = [...args, "--path", workspaceRoot];
      }

      // Question/analysis prompts: skip the CLI entirely and answer conversationally.
      // The plan CLI pipeline is designed for feature implementation — running it for
      // questions produces "Files to modify" / risk-score output that is wrong for Q&A.
      if (cliCommand === "question") {
        stream.progress?.("Searching your codebase…");
        const userPrompt = request.prompt.trim();
        const userTerms = [...new Set(tokenize(userPrompt))];
        const repoResult = await buildRepoContext(workspaceRoot, userPrompt, vscode);
        let fileCtx = await readFilesForLmContext(
          workspaceRoot,
          repoResult.fileAnchors,
          userTerms
        );
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          const activeRelPath = path.relative(
            workspaceRoot,
            activeEditor.document.fileName
          );
          if (!repoResult.fileAnchors.some((a) => a.relativePath === activeRelPath)) {
            fileCtx += `\n\n=== Currently open in editor: ${activeRelPath} ===\n${activeEditor.document.getText().slice(0, 3_000)}`;
          }
        }
        const historyCtx = formatChatHistory(context.history);
        if (vscode.lm) {
          stream.progress?.("Generating answer…");
          const lmPrompt = buildCommandLmPrompt(
            "question",
            userPrompt,
            "",
            repoResult.contextText,
            fileCtx,
            historyCtx
          );
          if (lmPrompt) {
            await streamLmResponse(vscode, lmPrompt, stream, token);
          }
        }
        return;
      }

      stream.progress?.(getChatProgressMessage(cliCommand));

      const result = await runner.run({ args: runArgs, cwd: extensionRoot });

      if (result.exitCode !== 0) {
        const errText = (result.stderr || result.stdout).trim();
        stream.markdown(
          `**Command failed** (exit ${result.exitCode})\n\n\`\`\`\n${errText.slice(0, 2000)}\n\`\`\``
        );
        return;
      }

      // Prefer the written markdown artifact over raw stdout
      let content = result.stdout;
      const artifactPath = getChatArtifactPath(cliCommand, workspaceRoot);
      if (artifactPath) {
        try {
          content = await readFile(artifactPath, "utf8");
        } catch {
          /* no artifact yet — use stdout */
        }
      }

      // Try LM for every command
      if (vscode.lm) {
        stream.progress?.("Getting AI-powered insights…");
        const userPrompt = request.prompt.trim();
        const userTerms = [...new Set(tokenize(userPrompt))];

        const repoResult =
          cliCommand === "plan"
            ? await buildRepoContext(workspaceRoot, userPrompt, vscode)
            : { contextText: "", fileAnchors: [] as FileAnchor[] };
        const repoCtx = repoResult.contextText;

        // Collect full file content for plan commands so the LM can see
        // existing implementations rather than guessing from 4 KB previews.
        let fileContext = "";
        if (cliCommand === "plan") {
          // Merge plan files (static analysis) with symbol-registry matches
          // (from buildRepoContext). Plan files come first; registry anchors
          // supply line numbers for surgical excerpt extraction.
          const planFilePaths = extractFilesFromPlan(content);
          const anchorMap = new Map(
            repoResult.fileAnchors.map((a) => [a.relativePath, a.anchorLine])
          );
          const merged: FileAnchor[] = [
            ...planFilePaths.map((p) => ({
              relativePath: p,
              anchorLine: anchorMap.get(p)
            })),
            ...repoResult.fileAnchors.filter(
              (a) => !planFilePaths.includes(a.relativePath)
            )
          ];
          if (merged.length > 0) {
            fileContext = await readFilesForLmContext(workspaceRoot, merged, userTerms);
          }
          // Include the currently open file so the LM sees the exact code the
          // developer is looking at right now.
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor) {
            const activeRelPath = path.relative(
              workspaceRoot,
              activeEditor.document.fileName
            );
            if (!merged.some((a) => a.relativePath === activeRelPath)) {
              const activeContent = activeEditor.document.getText().slice(0, 3_000);
              fileContext += `\n\n=== Currently open in editor: ${activeRelPath} ===\n${activeContent}`;
            }
          }
        }

        const historyCtx = formatChatHistory(context.history);

        // For plan commands, try the agentic tool-use loop first — it lets the
        // LM iteratively request the files it needs rather than relying on a
        // single pre-selected context window.
        if (cliCommand === "plan") {
          stream.progress?.("Reasoning over your codebase…");
          const agentSucceeded = await runAgenticPlanLoop(
            vscode,
            workspaceRoot,
            userPrompt,
            [repoCtx, historyCtx ? `\n${historyCtx}` : ""].join(""),
            repoResult.fileAnchors,
            stream,
            token
          );
          if (agentSucceeded) {
            const hint = getChatFollowUpHint(cliCommand);
            if (hint) stream.markdown(hint);
            return;
          }
          // Fall through to single-shot if agent loop fails or is unsupported.
          stream.progress?.("Getting AI-powered insights…");
        }

        const lmPrompt = buildCommandLmPrompt(
          cliCommand,
          userPrompt,
          content,
          repoCtx,
          fileContext,
          historyCtx
        );
        if (lmPrompt) {
          const streamed = await streamLmResponse(vscode, lmPrompt, stream, token);
          if (streamed) {
            const hint = getChatFollowUpHint(cliCommand);
            if (hint) stream.markdown(hint);
            return;
          }
        }
      } else if (cliCommand === "plan") {
        stream.markdown(
          "> ℹ️ **GitHub Copilot language model not available.** Install GitHub Copilot Chat and sign in for AI-powered answers. Showing static analysis:\n\n"
        );
      }

      // Fallback: show clean formatted output
      if (artifactPath) {
        const fallback =
          cliCommand === "plan" ? extractPlanSummary(content) : content.slice(0, 10000);
        stream.markdown(fallback);
      } else {
        stream.markdown(formatCliOutputAsMarkdown(content));
      }
      const hint = getChatFollowUpHint(cliCommand);
      if (hint) stream.markdown(hint);
    };

    context.subscriptions.push(
      vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, chatHandler)
    );
  }

  dashboard.refresh();

  return {
    runWorkflowCommand,
    refreshDashboard: () => dashboard.refresh(),
    getState: () => ({ ...state })
  };
}

export function deactivate(): void {
  activeMcpProcess?.dispose();
  activeMcpProcess = undefined;
}

export class NodeCliRunner implements CliRunner {
  async run(request: CliRunRequest): Promise<CliRunResult> {
    return new Promise((resolve) => {
      const [exe, cliArgs] = resolveNpmSpawn(["run", "cli", "--", ...request.args]);
      const child = spawn(exe, cliArgs, {
        cwd: request.cwd,
        shell: false,
        env: { ...process.env, FORCE_COLOR: "0" }
      });
      const commandLine = createCliCommandLine(request.args);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        request.onOutput?.("stdout", text.trimEnd());
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        request.onOutput?.("stderr", text.trimEnd());
      });

      child.on("error", (error) => {
        stderr += error.message;
        resolve({
          exitCode: 1,
          stdout,
          stderr,
          commandLine
        });
      });

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          commandLine
        });
      });
    });
  }
}

export class TerminalMcpStarter implements McpStarter {
  constructor(private readonly vscode: VscodeApiLike) {}

  start(request: CliRunRequest): DisposableLike {
    if (this.vscode.window.createTerminal) {
      const terminal = this.vscode.window.createTerminal({
        name: "Copilot Architect MCP",
        cwd: request.cwd
      });
      terminal.sendText(createCliCommandLine(request.args));
      terminal.show(true);
      return terminal;
    }

    return new NodeMcpStarter().start(request);
  }
}

export class NodeMcpStarter implements McpStarter {
  start(request: CliRunRequest): DisposableLike {
    const [exe, cliArgs] = resolveNpmSpawn(["run", "cli", "--", ...request.args]);
    const child = spawn(exe, cliArgs, {
      cwd: request.cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    attachProcessOutput(child, request);

    return {
      dispose: () => {
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }
}

class DashboardController implements WebviewViewProviderLike {
  private view: WebviewViewLike | undefined;
  private panel: WebviewPanelLike | undefined;

  constructor(
    private readonly vscode: VscodeApiLike,
    private readonly state: ExtensionState
  ) {}

  resolveWebviewView(webviewView: WebviewViewLike): void {
    this.view = webviewView;
    this.configureWebview(webviewView.webview);
    this.refresh();
  }

  openPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    if (!this.vscode.window.createWebviewPanel) {
      this.vscode.window.showInformationMessage(
        "Copilot Architect dashboard is available in the activity bar."
      );
      return;
    }

    this.panel = this.vscode.window.createWebviewPanel(
      DASHBOARD_PANEL_TYPE,
      "Copilot Architect",
      this.vscode.ViewColumn?.One ?? 1,
      { enableCommandUris: true, enableScripts: false }
    );
    this.configureWebview(this.panel.webview);
    this.refresh();
  }

  refresh(): void {
    // Render immediately with whatever is known, then reload artifacts from disk
    // and re-render so the cards reflect the latest analyze/plan/validate output.
    this.render();
    void this.reloadArtifacts();
  }

  private async reloadArtifacts(): Promise<void> {
    try {
      this.state.artifacts = await loadDashboardArtifacts(this.state.workspaceRoot);
    } catch {
      // Keep the previously loaded artifacts on any read failure.
    }
    this.render();
  }

  private render(): void {
    const html = createDashboardHtml(this.state);

    if (this.view) {
      this.configureWebview(this.view.webview);
      this.view.webview.html = html;
    }

    if (this.panel) {
      this.configureWebview(this.panel.webview);
      this.panel.webview.html = html;
    }
  }

  private configureWebview(webview: WebviewLike): void {
    webview.options = {
      enableCommandUris: true,
      enableScripts: false
    };
  }
}

export function createDashboardHtml(state: ExtensionState): string {
  const artifacts = state.artifacts;
  const sections = [
    {
      title: "Repo summary",
      body: escapeHtml(
        artifacts?.repoCount
          ? `${state.workspaceRoot} · ${artifacts.repoCount} registered repo(s)`
          : state.workspaceRoot
      )
    },
    {
      title: "Languages/frameworks",
      body: escapeHtml(formatLanguagesFrameworks(artifacts))
    },
    {
      title: "Plans",
      body: escapeHtml(formatPlan(artifacts))
    },
    {
      title: "Validation runs",
      body: escapeHtml(formatValidation(artifacts))
    },
    {
      title: "Review reports",
      body: escapeHtml(formatReview(artifacts))
    },
    {
      title: "Agent status",
      body: escapeHtml(formatAgents(artifacts))
    },
    {
      title: "MCP status",
      body: state.mcpStatus
    }
  ];

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Copilot Architect</title>",
    "<style>",
    "body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:16px;}",
    "h1{font-size:20px;font-weight:600;margin:0 0 12px;}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;}",
    "section{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;background:var(--vscode-sideBar-background);min-height:74px;}",
    "h2{font-size:13px;font-weight:600;margin:0 0 8px;}",
    "p{font-size:12px;line-height:1.4;margin:0;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere;}",
    ".actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;}",
    "a{font-size:12px;color:var(--vscode-textLink-foreground);text-decoration:none;}",
    "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;}",
    "</style>",
    "</head>",
    "<body>",
    "<h1>Copilot Architect</h1>",
    `<div class="actions"><a href="command:copilotArchitect.openRepoInNewWindow">Open Repo</a> <a href="command:copilotArchitect.workspaceScan">Scan &amp; Register Sub-repos</a> <a href="command:copilotArchitect.setupMcp">Setup MCP Server</a>${COPILOT_ARCHITECT_COMMANDS.map(renderCommandLink).join("")}</div>`,
    '<div class="grid">',
    ...sections.map(
      (section) => `<section><h2>${section.title}</h2><p>${section.body}</p></section>`
    ),
    "</div>",
    '<section style="margin-top:10px">',
    "<h2>Last command</h2>",
    `<p>${escapeHtml(state.lastCommand ?? "None")}</p>`,
    `<p>Exit code: ${state.lastExitCode ?? "n/a"}</p>`,
    state.lastStdout ? `<pre>${escapeHtml(state.lastStdout)}</pre>` : "",
    state.lastStderr ? `<pre>${escapeHtml(state.lastStderr)}</pre>` : "",
    "</section>",
    "</body>",
    "</html>"
  ].join("");
}

export function createCliCommandLine(args: string[]): string {
  return ["npm", "run", "cli", "--", ...args.map(quoteCliArg)].join(" ");
}

// --- Dashboard artifact loading + formatting ---

export async function loadDashboardArtifacts(
  workspaceRoot: string
): Promise<DashboardArtifacts> {
  const root = path.join(workspaceRoot, ".copilot-architect");
  const artifacts: DashboardArtifacts = {};

  const repoMap = await readJsonSafe<{
    summary?: { primaryLanguages?: string[]; primaryFrameworks?: string[] };
  }>(path.join(root, "repo-map.json"));
  if (repoMap?.summary) {
    artifacts.languages = repoMap.summary.primaryLanguages;
    artifacts.frameworks = repoMap.summary.primaryFrameworks;
  }

  const plan = await readJsonSafe<{
    title?: string;
    task?: string;
    status?: string;
    generatedAt?: string;
  }>(path.join(root, "plans", "latest-plan.json"));
  if (plan) {
    artifacts.latestPlan = {
      title: plan.title ?? plan.task ?? "Untitled plan",
      status: plan.status,
      generatedAt: plan.generatedAt
    };
  }

  const validation = await readJsonSafe<{
    status?: string;
    generatedAt?: string;
    results?: Array<{ status?: string }>;
  }>(path.join(root, "runs", "latest-validation.json"));
  if (validation) {
    const results = validation.results ?? [];
    artifacts.latestValidation = {
      status: validation.status,
      generatedAt: validation.generatedAt,
      passed: results.filter((result) => result.status === "passed").length,
      total: results.length
    };
  }

  const review = await readJsonSafe<{
    summary?: string;
    generatedAt?: string;
    findings?: unknown[];
  }>(path.join(root, "reviews", "latest-review.json"));
  if (review) {
    artifacts.latestReview = {
      summary: review.summary,
      generatedAt: review.generatedAt,
      findingCount: review.findings?.length
    };
  }

  artifacts.agentCount = await countAgentFiles(
    path.join(workspaceRoot, ".github", "agents")
  );

  const workspace = await readJsonSafe<{ repos?: unknown[] }>(
    path.join(root, "workspace.json")
  );
  if (workspace?.repos) {
    artifacts.repoCount = workspace.repos.length;
  }

  return artifacts;
}

async function readJsonSafe<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function countAgentFiles(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory);
    return entries.filter((name) => name.endsWith(".agent.md")).length;
  } catch {
    return 0;
  }
}

function formatLanguagesFrameworks(artifacts: DashboardArtifacts | undefined): string {
  const languages = artifacts?.languages ?? [];
  const frameworks = artifacts?.frameworks ?? [];
  if (languages.length === 0 && frameworks.length === 0) {
    return "Run Analyze Repo to detect languages and frameworks.";
  }
  const parts = [languages.join(", ") || "no languages detected"];
  if (frameworks.length > 0) {
    parts.push(frameworks.join(", "));
  }
  return parts.join(" · ");
}

function formatPlan(artifacts: DashboardArtifacts | undefined): string {
  const plan = artifacts?.latestPlan;
  if (!plan) {
    return "No plan yet — run Generate Plan.";
  }
  const meta = [plan.status, formatDate(plan.generatedAt)].filter(Boolean).join(", ");
  return meta ? `${plan.title} (${meta})` : plan.title;
}

function formatValidation(artifacts: DashboardArtifacts | undefined): string {
  const validation = artifacts?.latestValidation;
  if (!validation) {
    return "No validation run yet — run Validate.";
  }
  const date = formatDate(validation.generatedAt);
  const counts =
    typeof validation.total === "number"
      ? `${validation.passed ?? 0}/${validation.total} passed`
      : "";
  return [validation.status ?? "unknown", counts, date].filter(Boolean).join(" · ");
}

function formatReview(artifacts: DashboardArtifacts | undefined): string {
  const review = artifacts?.latestReview;
  if (!review) {
    return "No review yet — run Review.";
  }
  const summary = review.summary ? truncate(review.summary, 100) : "Review available";
  const findings =
    typeof review.findingCount === "number"
      ? ` (${review.findingCount} finding(s))`
      : "";
  return `${summary}${findings}`;
}

function formatAgents(artifacts: DashboardArtifacts | undefined): string {
  const count = artifacts?.agentCount ?? 0;
  return count > 0
    ? `${count} agent(s) installed in .github/agents`
    : "No agents installed — run Install Agents.";
}

function formatDate(iso: string | undefined): string {
  return iso && iso.length >= 10 ? iso.slice(0, 10) : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function loadVscodeApi(): VscodeApiLike {
  const require = createRequire(import.meta.url);
  return require("vscode") as VscodeApiLike;
}

async function resolveCommandArgs(
  command: CopilotArchitectCommand,
  vscode: VscodeApiLike
): Promise<string[] | undefined> {
  if (!command.prompt) {
    return command.cliArgs;
  }

  const value = await vscode.window.showInputBox?.({
    title: command.prompt.title,
    prompt: command.prompt.prompt,
    placeHolder: command.prompt.placeHolder
  });
  const request = value?.trim();

  return request ? [...command.cliArgs, request] : undefined;
}

function getWorkspaceRoot(vscode: VscodeApiLike): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

// Add the given folders to the current VS Code workspace (skipping any already
// present) so they appear in the Explorer. Returns the number actually added.
function addWorkspaceFolders(vscode: VscodeApiLike, dirs: string[]): number {
  const update = vscode.workspace.updateWorkspaceFolders;
  const toUri = vscode.Uri?.file;
  if (!update || !toUri) {
    return 0;
  }

  const existing = new Set(
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
  );
  const folders = dirs
    .filter((dir) => !existing.has(dir))
    .map((dir) => ({ uri: toUri(dir), name: path.basename(dir) }));

  if (folders.length === 0) {
    return 0;
  }

  const start = vscode.workspace.workspaceFolders?.length ?? 0;
  update.call(vscode.workspace, start, 0, ...folders);
  return folders.length;
}

function resolveExtensionRoot(context: ExtensionContextLike): string {
  // extensionPath = .../Copilot_Assistant/packages/vscode-extension
  // monorepo root = .../Copilot_Assistant (two levels up)
  const extensionPath = context.extensionPath ?? context.extensionUri?.fsPath;
  if (extensionPath) {
    return path.resolve(extensionPath, "..", "..");
  }
  return process.cwd();
}

// On Windows, npm.cmd cannot be spawned with shell:false (EINVAL).
// Route through cmd.exe /c so the .cmd file is executed correctly.
function resolveNpmSpawn(args: string[]): [string, string[]] {
  if (process.platform === "win32") {
    return ["cmd.exe", ["/c", "npm.cmd", ...args]];
  }
  return ["npm", args];
}

function attachProcessOutput(
  child: ChildProcessWithoutNullStreams,
  request: CliRunRequest
): void {
  child.stdout.on("data", (chunk: Buffer) => {
    request.onOutput?.("stdout", chunk.toString().trimEnd());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    request.onOutput?.("stderr", chunk.toString().trimEnd());
  });
}

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9._:/=+-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function trimForDashboard(value: string): string {
  return value.trim().slice(-2000);
}

export function resolveChatCommandArgs(
  command: string | undefined,
  prompt: string
): string[] | undefined {
  switch (command) {
    case "analyze":
      return ["analyze"];
    case "index":
      return ["index"];
    case "plan":
      return prompt ? ["plan", prompt] : undefined;
    case "validate":
      return ["validate"];
    case "review":
      return ["review", "--plan", "latest", "--validation", "latest"];
    case "search":
      return prompt ? ["search", prompt] : undefined;
    case "diagnostics":
      return ["diagnostics"];
    case "agents":
      return ["agents", "install"];
    case "instructions":
      return ["instructions", "generate"];
    default:
      if (!prompt) return undefined;
      // Free-form messages: route to the appropriate handler based on intent.
      // Questions and analysis requests get a conversational Q&A path (no CLI plan artifact).
      // Feature implementation requests go through the plan pipeline.
      return classifyIntent(prompt) === "question"
        ? ["question", prompt]
        : ["plan", prompt];
  }
}

/**
 * Classify a free-form prompt as a question/analysis request or a feature
 * implementation request. Questions get a conversational Q&A response;
 * implementation requests run the full planning pipeline.
 */
export function classifyIntent(prompt: string): "question" | "plan" {
  const lower = prompt.toLowerCase().trim();

  // Documentation requests — "create a doc", "write a readme", "document X"
  if (
    /\b(doc|docs|documentation|readme|wiki)\b/.test(lower) &&
    /\b(create|write|generate|explain|add)\b/.test(lower)
  ) {
    return "question";
  }

  // Explicit question starters
  if (
    /^(what|how|why|where|which|who|when|show|list|explain|describe|analyze|analyse|tell|give|can you explain|is there|are there|does|do )\b/.test(
      lower
    )
  ) {
    return "question";
  }

  // Strong analysis/explanation verbs anywhere in the prompt
  if (
    /\b(explain|describe|analyze|analyse|understand|overview|summarize|summarise|walk me through|show me how)\b/.test(
      lower
    )
  ) {
    return "question";
  }

  // "how X works / is implemented / is structured"
  if (/\bhow\b.*(work|implement|structur|organiz|architect)/i.test(lower)) {
    return "question";
  }

  return "plan";
}

function getChatProgressMessage(command: string): string {
  const messages: Record<string, string> = {
    question: "Searching your codebase…",
    analyze: "Analyzing repository…",
    index: "Building file index…",
    plan: "Generating feature plan…",
    validate: "Running validation commands…",
    review: "Generating code review…",
    search: "Searching repository…",
    diagnostics: "Running diagnostics…",
    agents: "Installing agent templates…",
    instructions: "Generating Copilot instructions…"
  };
  return messages[command] ?? "Running Copilot Architect…";
}

function getChatArtifactPath(
  command: string,
  workspaceRoot: string
): string | undefined {
  const base = path.join(workspaceRoot, ".copilot-architect");
  switch (command) {
    case "plan":
      return path.join(base, "plans", "latest-plan.md");
    case "validate":
      return path.join(base, "runs", "latest-validation.md");
    case "review":
      return path.join(base, "reviews", "latest-review.md");
    default:
      return undefined;
  }
}

function getChatFollowUpHint(command: string): string | undefined {
  switch (command) {
    case "analyze":
      return "\n\n---\n**Next steps:** Run `/index` to build a searchable file index, then `/plan <feature>` to generate an implementation plan.";
    case "index":
      return "\n\n---\n**Next steps:** Use `/search <query>` to find relevant files, or `/plan <feature>` to generate a plan.";
    case "plan":
      return "\n\n---\n**Next steps:** Run `/validate` to check build and tests, then ask `@FeatureImplementer` to implement the plan.";
    case "validate":
      return "\n\n---\n**Next steps:** Run `/review` to generate a review report, or ask `@Debugger` to diagnose any failures.";
    case "review":
      return "\n\n---\n**Next steps:** Share the review with `@CodeReviewer` for deeper analysis, or address the findings and re-run `/validate`.";
    case "instructions":
      return "\n\n---\n**Next steps:** Run `/agents` to install custom Copilot agent templates that use these instructions.";
    default:
      return undefined;
  }
}

// Returns the absolute paths of all repos registered in workspace.json.
// Returns [] when no workspace.json exists (single-repo mode).
async function getRegisteredRepoRoots(workspaceRoot: string): Promise<string[]> {
  try {
    const wsPath = path.join(workspaceRoot, ".copilot-architect", "workspace.json");
    const ws = JSON.parse(await readFile(wsPath, "utf8")) as {
      repos?: Array<{ path?: string }>;
    };
    const repos = ws.repos ?? [];
    return repos
      .filter((r) => r.path && r.path !== ".")
      .map((r) => path.resolve(workspaceRoot, r.path as string));
  } catch {
    return [];
  }
}

function extractFilesFromPlan(markdown: string): string[] {
  const m = /## Likely Files To Modify\n([\s\S]*?)(?=\n## |\s*$)/m.exec(markdown);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+\.[a-zA-Z0-9]+)`/g)]
    .map((match) => match[1])
    .filter(Boolean);
}

/**
 * Tokenize text into lowercase terms — splits on non-alphanumeric boundaries
 * AND camelCase/acronym boundaries so "UserService" → ["user", "service"].
 * Matches the same tokenizer used by the BM25 indexer.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.split(/[^a-zA-Z0-9]+/)) {
    if (!chunk) continue;
    for (const sub of chunk.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const lower = sub.toLowerCase();
      if (lower.length >= 2) tokens.push(lower);
    }
  }
  return tokens;
}

/** Cosine similarity between two numeric vectors. Returns 0 for zero-norm inputs. */
function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** A file with an optional 1-based anchor line (best-matching symbol location). */
interface FileAnchor {
  relativePath: string;
  /** 1-based start line of the best-matching symbol. When set, excerpt is
   *  extracted around this line rather than from the file beginning. */
  anchorLine?: number;
}

/**
 * Extract a targeted excerpt from `content`.
 * When `anchorLine` is given (1-based), extract lines around that declaration.
 * Otherwise grep for `terms` and return matching lines with context windows.
 * Falls back to the file beginning when nothing matches.
 */
function extractRelevantSnippets(
  content: string,
  terms: string[],
  maxChars: number,
  anchorLine?: number
): string {
  const lines = content.split("\n");

  // Anchor-line mode: centre the excerpt on the symbol declaration.
  if (anchorLine && anchorLine > 0) {
    const idx = anchorLine - 1; // convert to 0-based
    const start = Math.max(0, idx - 8);
    const end = Math.min(lines.length - 1, idx + 70);
    return lines
      .slice(start, end + 1)
      .join("\n")
      .slice(0, maxChars);
  }

  if (terms.length === 0) return content.slice(0, maxChars);

  const WINDOW = 12;
  const included = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      for (
        let j = Math.max(0, i - WINDOW);
        j <= Math.min(lines.length - 1, i + WINDOW);
        j++
      ) {
        included.add(j);
      }
    }
  }

  if (included.size === 0) return content.slice(0, maxChars);

  const sorted = [...included].sort((a, b) => a - b);
  const parts: string[] = [];
  let prevIdx = -2;
  let chars = 0;
  for (const idx of sorted) {
    if (chars >= maxChars) break;
    if (idx > prevIdx + 1) parts.push("…");
    const line = lines[idx];
    parts.push(line);
    chars += line.length + 1;
    prevIdx = idx;
  }
  return parts.join("\n").slice(0, maxChars);
}

/** Return relative paths that the given source file imports (relative imports only). */
function parseRelativeImports(content: string, ext: string): string[] {
  const raw: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    for (const m of content.matchAll(/\bimport\b[^'"]*?['"](\.[^'"]+)['"]/g))
      raw.push(m[1]);
    for (const m of content.matchAll(/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g))
      raw.push(m[1]);
  } else if (ext === ".py") {
    for (const m of content.matchAll(/^from\s+(\.+[^\s]*)\s+import/gm)) raw.push(m[1]);
  }
  return [...new Set(raw)];
}

/** Expand a relative import specifier to candidate file paths (with extensions). */
function resolveImportCandidates(fromRelDir: string, importPath: string): string[] {
  const base = path.join(fromRelDir, importPath).replace(/\\/g, "/");
  if (path.extname(importPath)) return [base];
  const EXTS = [".ts", ".tsx", ".js", ".jsx", ".py"];
  return [...EXTS.map((e) => `${base}${e}`), ...EXTS.map((e) => `${base}/index${e}`)];
}

/**
 * Read source files from disk, extract targeted excerpts, and follow one level
 * of relative imports. `anchors` supply optional line numbers so excerpts are
 * centred on the relevant symbol declaration rather than the file start.
 */
async function readFilesForLmContext(
  workspaceRoot: string,
  anchors: FileAnchor[],
  requestTerms: string[] = []
): Promise<string> {
  const parts: string[] = [];
  let totalChars = 0;
  const visited = new Set<string>();

  async function readOne(anchor: FileAnchor, depth: number): Promise<void> {
    const { relativePath: relPath, anchorLine } = anchor;
    if (visited.has(relPath) || totalChars >= 16_000) return;
    visited.add(relPath);

    let content: string;
    try {
      content = await readFile(path.join(workspaceRoot, relPath), "utf8");
    } catch {
      return;
    }

    const perFileCap = depth === 0 ? 4_000 : 2_000;
    const excerpt = extractRelevantSnippets(
      content,
      requestTerms,
      perFileCap,
      anchorLine
    );
    const lineHint = anchorLine ? `:${anchorLine}` : "";
    parts.push(`\n=== ${relPath}${lineHint} ===\n${excerpt}`);
    totalChars += excerpt.length;

    // Follow direct imports one level deep.
    if (depth === 0) {
      const ext = path.extname(relPath).toLowerCase();
      const imports = parseRelativeImports(content, ext);
      const fromDir = path.dirname(relPath);
      for (const imp of imports.slice(0, 8)) {
        if (totalChars >= 16_000) break;
        for (const candidate of resolveImportCandidates(fromDir, imp)) {
          if (!visited.has(candidate)) {
            await readOne({ relativePath: candidate }, 1);
            break;
          }
        }
      }
    }
  }

  for (const anchor of anchors.slice(0, 6)) {
    if (totalChars >= 16_000) break;
    await readOne(anchor, 0);
  }

  return parts.join("\n");
}

/** Summarise the last few chat turns into a compact string for the LM prompt. */
function formatChatHistory(history: ChatHistoryTurnLike[] | undefined): string {
  if (!history?.length) return "";
  const turns = history.slice(-6);
  const lines: string[] = ["Previous conversation:"];
  for (const turn of turns) {
    if (turn.prompt) {
      lines.push(`User: ${turn.prompt.slice(0, 400)}`);
    } else if (turn.response) {
      const text = turn.response
        .map((p) => p.value ?? "")
        .join("")
        .slice(0, 600);
      if (text) lines.push(`Assistant: ${text}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

interface RepoContextResult {
  contextText: string;
  /** Top-ranked files with symbol anchor lines for targeted excerpt extraction. */
  fileAnchors: FileAnchor[];
}

// ─── Claude-inspired retrieval mechanisms ────────────────────────────────────

/**
 * HyDE — Hypothetical Document Embedding.
 *
 * Instead of embedding the user's natural-language question (which lives far
 * from code in embedding space), we ask the LM to write a short hypothetical
 * code snippet that *would* implement what the user is asking for, then search
 * for the real code that looks most like that snippet.
 *
 * "how is access controlled?" → LM generates a plausible middleware/guard
 * snippet → we tokenize THAT and score against the index → recall for
 * AuthMiddleware / checkPermission / RoleGuard dramatically improves.
 *
 * Returns an empty string on any failure so callers can fall back gracefully.
 */
async function generateHypotheticalSnippet(
  vscodeApi: VscodeApiLike,
  userQuery: string,
  token: unknown
): Promise<string> {
  if (!vscodeApi.lm) return "";
  try {
    let models: LanguageModelLike[] = [];
    for (const selector of [
      { vendor: "copilot", family: "gpt-4o" },
      { vendor: "copilot" },
      {}
    ]) {
      models = await vscodeApi.lm.selectChatModels(selector);
      if (models.length) break;
    }
    if (!models.length) return "";

    const hydePrompt =
      `You are a code search assistant. The developer asked: "${userQuery}"\n` +
      "Write a SHORT (10-20 line) hypothetical code snippet — a function, class, or middleware — " +
      "that would implement what they are looking for. Use realistic variable and function names. " +
      "Output ONLY the code, no explanation, no markdown fences.";

    const msg = vscodeApi.LanguageModelChatMessage?.User(hydePrompt);
    if (!msg) return "";
    const response = await models[0].sendRequest([msg], {}, token);
    const parts: string[] = [];
    for await (const chunk of response.text) parts.push(chunk);
    return parts.join("").slice(0, 800);
  } catch {
    return "";
  }
}

/**
 * Multi-query expansion.
 *
 * A single query misses synonyms and paraphrases: "add user" doesn't match
 * createAccount, registerMember, or POST /signup. We ask the LM to produce
 * four reformulations then merge all results with Reciprocal Rank Fusion (RRF)
 * so every variant contributes — whichever query finds the right file first
 * "wins" the ranking.
 *
 * Returns the original query list on any failure.
 */
async function expandQuery(
  vscodeApi: VscodeApiLike,
  userQuery: string,
  token: unknown
): Promise<string[]> {
  if (!vscodeApi.lm) return [userQuery];
  try {
    let models: LanguageModelLike[] = [];
    for (const selector of [
      { vendor: "copilot", family: "gpt-4o" },
      { vendor: "copilot" },
      {}
    ]) {
      models = await vscodeApi.lm.selectChatModels(selector);
      if (models.length) break;
    }
    if (!models.length) return [userQuery];

    const expandPrompt =
      `Rephrase this code search query in 4 different ways that a developer might express the same intent. ` +
      `Use technical synonyms, alternate function/class names, and API terms. ` +
      `Output ONLY the 4 queries, one per line, no numbering, no extra text.\n\nQuery: ${userQuery}`;

    const msg = vscodeApi.LanguageModelChatMessage?.User(expandPrompt);
    if (!msg) return [userQuery];
    const response = await models[0].sendRequest([msg], {}, token);
    const parts: string[] = [];
    for await (const chunk of response.text) parts.push(chunk);
    const expanded = parts
      .join("")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 3)
      .slice(0, 4);
    return [userQuery, ...expanded];
  } catch {
    return [userQuery];
  }
}

/**
 * Score a set of documents against multiple query variants and merge with
 * Reciprocal Rank Fusion (RRF, k=60). Each variant produces its own ranked
 * list; a document that ranks highly in *any* variant gets a strong combined
 * score — so synonyms and paraphrases all contribute.
 */
function multiQueryRrfScore(
  docs: Array<{
    relativePath: string;
    symbols: Array<{ name: string; startLine?: number }>;
    textPreview?: string;
  }>,
  queryVariants: string[]
): Map<string, number> {
  const K = 60;
  const totals = new Map<string, number>();

  for (const variant of queryVariants) {
    const terms = [...new Set(tokenize(variant))];
    const ranked = docs
      .map((d) => {
        const pathTokens = new Set(tokenize(d.relativePath));
        const symTokenSet = new Set(d.symbols.flatMap((s) => tokenize(s.name)));
        const preview = (d.textPreview ?? "").toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (pathTokens.has(t)) score += 3;
          if (symTokenSet.has(t)) score += 5;
          if (preview.includes(t)) score += 1;
        }
        return { path: d.relativePath, score };
      })
      .sort((a, b) => b.score - a.score);

    for (let rank = 0; rank < ranked.length; rank++) {
      const rrf = 1 / (K + rank + 1);
      totals.set(ranked[rank].path, (totals.get(ranked[rank].path) ?? 0) + rrf);
    }
  }

  return totals;
}

/**
 * Agentic tool-use loop.
 *
 * Instead of a single prompt → single answer, this sends the LM a set of
 * "tools" it can call (readFile, searchSymbol, followImport) and runs a
 * max-step loop. The LM requests the files it needs; we fetch them and send
 * the results back as tool responses — exactly how Claude Code works.
 *
 * Only runs when the VS Code LM API supports tool use (VS Code 1.94+).
 * Falls back to the standard single-shot path on any error.
 */
async function runAgenticPlanLoop(
  vscodeApi: VscodeApiLike,
  workspaceRoot: string,
  userPrompt: string,
  initialContext: string,
  fileAnchors: FileAnchor[],
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<boolean> {
  if (!vscodeApi.lm) return false;

  const TOOL_READ_FILE = "readFile";
  const TOOL_SEARCH = "searchSymbol";
  const MAX_STEPS = 4;

  // System context for the agent
  const systemCtx = [
    "You are Copilot Architect, an AI assistant with deep knowledge of the developer's codebase.",
    "You have tools to read files and search for symbols. Use them to find the existing implementation",
    "before suggesting any new code. When you have enough context, answer the developer's question.",
    initialContext
  ].join("\n");

  const tools = [
    {
      name: TOOL_READ_FILE,
      description:
        "Read a source file from the repository. Use the exact relative path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path, e.g. src/auth/AuthService.ts"
          },
          startLine: {
            type: "number",
            description: "Optional 1-based line to start reading from"
          }
        },
        required: ["path"]
      }
    },
    {
      name: TOOL_SEARCH,
      description: "Search for a symbol or concept in the codebase index.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Symbol name or short phrase to search for"
          }
        },
        required: ["query"]
      }
    }
  ];

  let models: LanguageModelLike[] = [];
  try {
    for (const selector of [
      { vendor: "copilot", family: "gpt-4o" },
      { vendor: "copilot" },
      {}
    ]) {
      models = await vscodeApi.lm.selectChatModels(selector);
      if (models.length) break;
    }
    if (!models.length) return false;
  } catch {
    return false;
  }

  // Check if the model supports tool use by inspecting its interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = models[0] as any;
  if (typeof model.sendRequest !== "function") return false;

  // Build initial file context from anchors
  let accumulatedContext = "";
  for (const anchor of fileAnchors.slice(0, 4)) {
    try {
      const content = await readFile(
        path.join(workspaceRoot, anchor.relativePath),
        "utf8"
      );
      const excerpt = extractRelevantSnippets(
        content,
        tokenize(userPrompt),
        3_000,
        anchor.anchorLine
      );
      accumulatedContext += `\n=== ${anchor.relativePath} ===\n${excerpt}`;
    } catch {
      /* file unavailable */
    }
  }

  const messages: LanguageModelChatMessageLike[] = [
    ...(vscodeApi.LanguageModelChatMessage
      ? [
          vscodeApi.LanguageModelChatMessage.User(
            `${systemCtx}\n\nExisting code context:\n${accumulatedContext}\n\nDeveloper's question: ${userPrompt}`
          )
        ]
      : [{ role: 1, content: `${systemCtx}\n\n${userPrompt}` }])
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await model.sendRequest(messages, { tools }, token);

      // Collect streamed text and tool calls
      const textParts: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

      for await (const chunk of response.text) {
        // VS Code LM streams text chunks; tool calls arrive as structured parts
        if (typeof chunk === "string") {
          textParts.push(chunk);
        } else if (chunk && typeof chunk === "object") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c = chunk as any;
          if (c.type === "tool_use" || c.name) {
            toolCalls.push({
              name: c.name ?? c.type,
              input: c.input ?? c.parameters ?? {}
            });
          }
        }
      }

      const assistantText = textParts.join("");

      // No tool calls → final answer, stream it out
      if (toolCalls.length === 0) {
        if (assistantText) {
          stream.markdown(assistantText);
          return true;
        }
        return false;
      }

      // Execute tool calls and append results
      const toolResults: string[] = [];
      for (const call of toolCalls.slice(0, 3)) {
        if (call.name === TOOL_READ_FILE) {
          const relPath = String(call.input.path ?? "");
          const startLine = Number(call.input.startLine ?? 0) || undefined;
          try {
            const fc = await readFile(path.join(workspaceRoot, relPath), "utf8");
            const snippet = extractRelevantSnippets(
              fc,
              tokenize(userPrompt),
              3_000,
              startLine
            );
            toolResults.push(`readFile("${relPath}"):\n${snippet}`);
          } catch {
            toolResults.push(`readFile("${relPath}"): file not found`);
          }
        } else if (call.name === TOOL_SEARCH) {
          const q = String(call.input.query ?? "");
          const terms = tokenize(q);
          // Quick in-memory search over what we already loaded
          const hits = fileAnchors
            .filter((a) => terms.some((t) => tokenize(a.relativePath).includes(t)))
            .slice(0, 3)
            .map((a) => a.relativePath);
          toolResults.push(
            `searchSymbol("${q}"): ${hits.length ? hits.join(", ") : "no results"}`
          );
        }
      }

      // Push the assistant's reasoning + tool results back as context
      if (assistantText && vscodeApi.LanguageModelChatMessage) {
        messages.push(vscodeApi.LanguageModelChatMessage.Assistant(assistantText));
      }
      if (toolResults.length && vscodeApi.LanguageModelChatMessage) {
        messages.push(
          vscodeApi.LanguageModelChatMessage.User(
            `Tool results:\n${toolResults.join("\n---\n")}\n\nContinue answering.`
          )
        );
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function buildRepoContext(
  workspaceRoot: string,
  request?: string,
  vscodeApi?: VscodeApiLike
): Promise<RepoContextResult> {
  const lines: string[] = [];
  let fileAnchors: FileAnchor[] = [];

  try {
    const mapPath = path.join(workspaceRoot, ".copilot-architect", "repo-map.json");
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const repo = map.repos?.[0];
    if (repo) {
      const langs = (repo.languages as Array<{ name: string }>)
        ?.map((l) => l.name)
        .join(", ");
      const fws = (repo.frameworks as Array<{ name: string }>)
        ?.map((f) => f.name)
        .join(", ");
      const testCmd = (repo.commands?.test as Array<{ command: string }>)?.[0]?.command;
      const entry = (repo.entryPoints as Array<{ filePath: string }>)?.[0]?.filePath;
      if (langs) lines.push(`Languages: ${langs}`);
      if (fws) lines.push(`Frameworks: ${fws}`);
      if (entry) lines.push(`Entry point: ${entry}`);
      if (testCmd) lines.push(`Test command: ${testCmd}`);
    }
  } catch {
    /* no repo-map yet */
  }

  try {
    const indexPath = path.join(
      workspaceRoot,
      ".copilot-architect",
      "index",
      "index.json"
    );
    const idx = JSON.parse(await readFile(indexPath, "utf8"));

    type IndexSymbol = {
      name: string;
      kind: string;
      startLine?: number;
      endLine?: number;
    };
    type IndexDoc = {
      relativePath: string;
      symbols: IndexSymbol[];
      textPreview?: string;
      extension: string;
      fileSizeBytes: number;
      isConfigFile: boolean;
      isDocFile: boolean;
    };
    const docs = (idx.documents as IndexDoc[]) ?? [];

    const SOURCE_EXTS = new Set([
      ".py",
      ".ts",
      ".js",
      ".tsx",
      ".jsx",
      ".java",
      ".go",
      ".rb",
      ".cs"
    ]);
    const sourceDocs = docs.filter(
      (d) =>
        !d.isConfigFile &&
        !d.isDocFile &&
        d.fileSizeBytes > 0 &&
        SOURCE_EXTS.has(d.extension)
    );

    // --- Symbol registry: token → {file, anchorLine} ----------------------------
    // Built from every symbol in the index. Gives us "go-to-definition" resolution
    // without a language server: when a query term matches a symbol name token, we
    // know exactly which file and line to read.
    const symbolRegistry = new Map<
      string,
      { relativePath: string; anchorLine?: number }[]
    >();
    for (const doc of docs) {
      for (const sym of doc.symbols) {
        for (const tok of tokenize(sym.name)) {
          const entries = symbolRegistry.get(tok) ?? [];
          entries.push({ relativePath: doc.relativePath, anchorLine: sym.startLine });
          symbolRegistry.set(tok, entries);
        }
      }
    }

    // --- Multi-query + HyDE scoring ----------------------------------------------
    // queryVariants: [original] + LM-generated paraphrases (async, best-effort)
    // hydeSnippet: hypothetical code snippet matching the query (HyDE mechanism)
    // Both run in parallel; failures fall back to the single original query.
    const [queryVariants, hydeSnippet] = await Promise.all([
      request && vscodeApi
        ? expandQuery(vscodeApi, request, undefined)
        : Promise.resolve(request ? [request] : []),
      request && vscodeApi
        ? generateHypotheticalSnippet(vscodeApi, request, undefined)
        : Promise.resolve("")
    ]);

    // RRF over all query variants gives every synonym/paraphrase a voice.
    const rrfScores =
      queryVariants.length > 0
        ? multiQueryRrfScore(sourceDocs, queryVariants)
        : new Map<string, number>();

    // Extra terms from the HyDE snippet boost matching files.
    const hydeTerms = hydeSnippet ? [...new Set(tokenize(hydeSnippet))] : [];

    const requestTerms = request ? [...new Set(tokenize(request))] : [];
    const allQueryTerms = [...new Set([...requestTerms, ...hydeTerms])];

    type Scored = { doc: IndexDoc; score: number; anchorLine?: number };
    let scored: Scored[] = sourceDocs.map((d) => {
      const pathTokens = new Set(tokenize(d.relativePath));
      const symTokens = new Map<string, number | undefined>(); // token → startLine
      for (const s of d.symbols) {
        for (const tok of tokenize(s.name)) {
          if (!symTokens.has(tok)) symTokens.set(tok, s.startLine);
        }
      }
      const previewLower = (d.textPreview ?? "").toLowerCase();

      let score = (rrfScores.get(d.relativePath) ?? 0) * 20; // RRF contribution (scaled)
      let bestAnchorLine: number | undefined;
      for (const term of allQueryTerms) {
        // Path match (worth 3 points — strong structural signal)
        if (pathTokens.has(term)) score += 3;
        // Symbol name match (worth 5 points — most precise signal)
        if (symTokens.has(term)) {
          score += 5;
          bestAnchorLine ??= symTokens.get(term);
        }
        // Preview body match (worth 1 point — content signal)
        if (previewLower.includes(term)) score += 1;
      }
      return { doc: d, score, anchorLine: bestAnchorLine };
    });

    // --- LM embedding reranking (VS Code 1.94+, GitHub Copilot) ------------------
    // Try to rerank the top-30 keyword candidates by cosine similarity.
    // Falls back silently to keyword scoring when embeddings are unavailable.
    if (vscodeApi?.lm?.computeEmbeddings && request && requestTerms.length > 0) {
      const EMBEDDING_MODELS = [
        "github:text-embedding-3-small",
        "github:text-embedding-ada-002",
        "text-embedding-3-small",
        "text-embedding-ada-002"
      ];
      const candidates = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

      if (candidates.length > 1) {
        for (const model of EMBEDDING_MODELS) {
          try {
            const docTexts = candidates.map(
              (c) =>
                `${c.doc.relativePath} ${c.doc.symbols.map((s) => s.name).join(" ")} ${c.doc.textPreview?.slice(0, 300) ?? ""}`
            );
            const result = await vscodeApi.lm.computeEmbeddings(model, [
              request,
              ...docTexts
            ]);
            const queryEmb = result.values[0].values;
            for (let i = 0; i < candidates.length; i++) {
              const sim = cosineSimilarity(queryEmb, result.values[i + 1].values);
              // Blend: 70% embedding similarity, 30% keyword score (normalised to [0,1])
              const maxKw = Math.max(...candidates.map((c) => c.score), 1);
              candidates[i].score = 0.7 * sim + 0.3 * (candidates[i].score / maxKw);
            }
            // Re-sort the candidates slice; leave the zero-score tail unchanged.
            candidates.sort((a, b) => b.score - a.score);
            // Splice reranked candidates back into `scored`.
            const rerankedPaths = new Set(candidates.map((c) => c.doc.relativePath));
            scored = [
              ...candidates,
              ...scored.filter((s) => !rerankedPaths.has(s.doc.relativePath))
            ];
            break; // Success — stop trying other model names.
          } catch {
            /* model not available, try next */
          }
        }
      }
    }

    scored.sort(
      (a, b) => b.score - a.score || b.doc.fileSizeBytes - a.doc.fileSizeBytes
    );

    // Top anchor files for disk reading.
    fileAnchors = scored
      .filter((s) => s.score > 0)
      .slice(0, 8)
      .map((s) => ({ relativePath: s.doc.relativePath, anchorLine: s.anchorLine }));

    // File list — quick orientation table for the LM.
    const topDocs = scored.slice(0, 25);
    if (topDocs.length) {
      lines.push("\nSource files:");
      for (const { doc, anchorLine } of topDocs) {
        const syms = doc.symbols
          ?.slice(0, 6)
          .map((s) => s.name)
          .join(", ");
        const hint = anchorLine ? `:${anchorLine}` : "";
        lines.push(`- ${doc.relativePath}${hint}${syms ? ` [${syms}]` : ""}`);
      }
    }

    // Index previews as a lightweight fallback for non-plan commands.
    const previewDocs = scored.slice(0, 5);
    if (previewDocs.length) {
      lines.push("\nExisting code (index previews):");
      let totalChars = 0;
      for (const { doc } of previewDocs) {
        if (totalChars >= 6_000) break;
        const preview = doc.textPreview?.slice(0, 2_000);
        if (!preview) continue;
        lines.push(`\n--- ${doc.relativePath} ---`);
        lines.push(preview);
        totalChars += preview.length;
      }
    }
  } catch {
    /* no index yet */
  }

  return { contextText: lines.join("\n"), fileAnchors };
}

function buildCommandLmPrompt(
  command: string,
  userRequest: string,
  content: string,
  repoContext: string,
  fileContext = "",
  historyContext = ""
): string | undefined {
  const body = content.trim().slice(0, 8000);
  const repoSection = repoContext ? `\nRepository context:\n${repoContext}\n` : "";
  const fileSection = fileContext
    ? `\nFull file content (read directly from disk — includes imported modules):\n${fileContext}\n`
    : "";
  const historySection = historyContext ? `\n${historyContext}\n` : "";

  switch (command) {
    case "question":
      return [
        "You are Copilot Architect, an expert on the developer's specific codebase.",
        "Answer the developer's question directly and concretely, using the actual code shown below.",
        "Rules:",
        "- Quote exact file paths, function names, class names, and patterns you can see.",
        "- If the question asks about something that already exists in the repo, describe how it works — do NOT suggest rewriting it.",
        "- If the question asks for documentation, write the documentation from the actual code.",
        "- Never give generic advice. Every statement must reference something visible in the code below.",
        "- If the answer is not in the provided code, say so clearly rather than guessing.",
        historySection,
        repoSection,
        fileSection,
        `Developer's question: "${userRequest}"`
      ].join("\n");

    case "plan": {
      const summary = extractPlanSummary(content);
      return [
        "You are Copilot Architect, a coding assistant with deep knowledge of the developer's existing codebase.",
        "IMPORTANT: Before suggesting any new code, look carefully at the existing code provided below to see if the feature is already implemented.",
        "If it already exists: explain exactly how it works, point to the relevant functions and files, and do NOT suggest rewriting it.",
        "If it is partially implemented: describe what is in place and what is missing.",
        "If it is absent: provide a concise implementation guide that follows the existing patterns in the codebase.",
        "Answer specifically about THIS codebase using the actual file names, function names, and patterns you can see. No generic advice.",
        historySection,
        repoSection,
        fileSection,
        `Static analysis:\n${summary}`,
        "",
        `Developer's request: "${userRequest}"`,
        "",
        "Step 1 — check the existing code above: does this feature already exist?",
        "Step 2 — if yes: describe the existing implementation with file:line references.",
        "Step 3 — if no or incomplete: which exact file(s) to modify, what to add, and a short code snippet following the repo patterns.",
        "Step 4 — one command to verify the behavior."
      ].join("\n");
    }

    case "analyze":
      return [
        "You are Copilot Architect. The developer just ran repo analysis.",
        "Summarize concisely: main language/framework, key entry points, and 2-3 actionable observations.",
        "Under 200 words. Use the actual names found in the output.",
        "",
        `Analysis output:\n${body}`
      ].join("\n");

    case "index":
      return [
        "You are Copilot Architect. The developer just built a searchable file index for their repo.",
        "Confirm what was indexed. Suggest 3 useful `/search` queries they could run next.",
        "Keep it short and practical.",
        "",
        `Index output:\n${body}`
      ].join("\n");

    case "validate":
      return [
        "You are Copilot Architect. The developer just ran validation (build, tests, lint).",
        "If everything passed: confirm briefly and note any warnings.",
        "If something failed: identify the failure and give specific fix steps with the relevant error lines.",
        "Be direct — no fluff.",
        historySection,
        `Validation results:\n${body}`
      ].join("\n");

    case "review":
      return [
        "You are Copilot Architect. The developer just ran a code review on their latest git diff.",
        "Summarize the most important findings: bugs, security issues, missing tests, code quality.",
        "Give 3-5 specific, actionable recommendations referencing actual file names and lines where available.",
        historySection,
        `Review report:\n${body}`
      ].join("\n");

    case "search":
      return [
        "You are Copilot Architect. The developer searched their repo index.",
        "For each result: state the file path, what it does, and the specific existing code or pattern most relevant to the query.",
        "If the query describes something that already exists in the results, say so clearly and describe the existing implementation.",
        "Group related results. Use bullet points. Reference actual function names you can see.",
        historySection,
        `Search query: "${userRequest}"`,
        "",
        `Search results:\n${body}`
      ].join("\n");

    case "diagnostics":
      return [
        "You are Copilot Architect. The developer ran repo diagnostics.",
        "Highlight warnings, missing configs, or issues. Give specific recommendations to improve readiness.",
        "If everything is fine, say so briefly.",
        "",
        `Diagnostics output:\n${body}`
      ].join("\n");

    case "agents":
      return [
        "You are Copilot Architect. Custom Copilot agent templates were just installed.",
        "List what agents were created and what each does. Give one example of invoking each in Copilot Chat.",
        "Be brief.",
        "",
        `Agents install output:\n${body}`
      ].join("\n");

    case "instructions":
      return [
        "You are Copilot Architect. A `.github/copilot-instructions.md` file was just generated.",
        "In 3-4 bullet points, summarize what instructions were written and how they improve Copilot assistance.",
        "",
        `Instructions output:\n${body}`
      ].join("\n");

    default:
      return undefined;
  }
}

async function streamLmResponse(
  vscode: VscodeApiLike,
  prompt: string,
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<boolean> {
  if (!vscode.lm) return false;

  try {
    // Try progressively broader selectors — different VS Code versions expose models differently
    let models: LanguageModelLike[] = [];
    for (const selector of [
      { vendor: "copilot", family: "gpt-4o" },
      { vendor: "copilot", family: "claude-sonnet-4-5" },
      { vendor: "copilot" },
      {}
    ]) {
      models = await vscode.lm.selectChatModels(selector);
      if (models.length) break;
    }

    if (!models.length) {
      stream.markdown(
        "_No Copilot language model found. Make sure GitHub Copilot Chat is installed and you are signed in, then reload the window._\n\n"
      );
      return false;
    }

    const model = models[0];

    // VS Code 1.92+ has static .User() factory; earlier versions use constructor with role enum
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const LmMsg = (vscode as any).LanguageModelChatMessage;
    let message: LanguageModelChatMessageLike;
    if (typeof LmMsg?.User === "function") {
      message = LmMsg.User(prompt) as LanguageModelChatMessageLike;
    } else if (typeof LmMsg === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const roleUser = (vscode as any).LanguageModelChatMessageRole?.User ?? 1;
      message = new LmMsg(roleUser, prompt) as LanguageModelChatMessageLike;
    } else {
      message = { role: 1, content: prompt };
    }

    const lmResponse = await model.sendRequest([message], {}, token);

    let hasContent = false;
    for await (const chunk of lmResponse.text) {
      stream.markdown(chunk);
      hasContent = true;
    }
    return hasContent;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stream.markdown(`\n> ⚠️ **Copilot LM error:** ${msg}\n\n`);
    return false;
  }
}

export function extractPlanSummary(markdown: string): string {
  const titleMatch = /^#\s+(.+)$/m.exec(markdown);
  const title = titleMatch?.[1] ?? "Implementation Plan";

  // Parse ## sections into a map
  const sectionMap: Record<string, string> = {};
  for (const chunk of markdown.split(/\n(?=## )/)) {
    const m = /^## (.+)\n([\s\S]*)/.exec(chunk);
    if (m) sectionMap[m[1].trim()] = m[2].trim();
  }

  const lines: string[] = [`# ${title}`, ""];

  const files = sectionMap["Likely Files To Modify"];
  if (files) {
    lines.push("## Files to modify", files, "");
  }

  const steps = sectionMap["Step-by-Step Implementation Plan"];
  if (steps) {
    lines.push("## Implementation steps", steps, "");
  }

  const cmds = sectionMap["Validation Commands"];
  if (cmds) {
    lines.push("## Run to validate", cmds, "");
  }

  const risks = sectionMap["Risks"];
  if (risks) {
    const riskItems = risks
      .split(/\n(?=-)/)
      .map((r) => r.replace(/\s*Mitigation:[\s\S]*/, "").trim())
      .filter((r) => r.startsWith("-"));
    if (riskItems.length) {
      lines.push("## Risks", riskItems.join("\n"), "");
    }
  }

  const questions = sectionMap["Open Questions"];
  if (questions) {
    lines.push("## Open questions", questions, "");
  }

  return lines.join("\n").trim();
}

// Lines that are internal CLI noise the user doesn't need to see
const NOISE_PATTERNS = [
  /^Copilot Architect:/, // CLI banner
  /^\s*>\s*(copilot-architect|node)/, // npm/node invocation lines
  /\/(Users|home|tmp)\//, // absolute file paths
  /^Plan (JSON|Markdown):/, // artifact path echoes
  /^Latest (JSON|Markdown):/,
  /^Validation (JSON|Markdown|Logs):/,
  /^Review (JSON|Markdown):/,
  /^Status:\s*draft/ // internal draft status
];

export function formatCliOutputAsMarkdown(stdout: string): string {
  const lines = stdout.trim().split("\n");
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      out.push("");
      continue;
    }

    // Drop internal noise lines
    if (NOISE_PATTERNS.some((p) => p.test(trimmed))) {
      continue;
    }

    // Already a markdown list item — keep as-is
    if (/^\s*[-*]\s/.test(line)) {
      out.push(trimmed);
      continue;
    }

    // "Key: value" line — bold the key
    const colonMatch = /^([A-Za-z][A-Za-z0-9 ]{0,30}):\s(.+)$/.exec(trimmed);
    if (colonMatch) {
      out.push(`**${colonMatch[1]}:** ${colonMatch[2]}`);
      continue;
    }

    out.push(trimmed);
  }

  // Collapse consecutive blank lines and strip leading/trailing blanks
  const collapsed: string[] = [];
  for (const line of out) {
    if (!line && collapsed.length && !collapsed[collapsed.length - 1]) continue;
    collapsed.push(line);
  }
  while (collapsed.length && !collapsed[0]) collapsed.shift();
  while (collapsed.length && !collapsed[collapsed.length - 1]) collapsed.pop();

  return collapsed.join("\n");
}

export function getChatHelpText(): string {
  return [
    "## Copilot Architect",
    "",
    "Use `@architect` with a slash command in Copilot Chat:",
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `/analyze` | Detect languages, frameworks, and entry points |",
    "| `/index` | Build a searchable local file index |",
    "| `/plan <feature>` | Generate a feature implementation plan |",
    "| `/validate` | Run build, test, lint, and format commands |",
    "| `/review` | Review the latest git diff against the approved plan |",
    "| `/search <query>` | Search the repo index |",
    "| `/diagnostics` | Report repo readiness and analysis signals |",
    "| `/agents` | Install custom Copilot agent templates |",
    "| `/instructions` | Generate `.github/copilot-instructions.md` |",
    "",
    "**Example:** `@architect /plan add user authentication`",
    "",
    "You can also skip the slash command:",
    "",
    "- Questions and analysis requests get a direct answer from your codebase:",
    "  `@architect explain how authentication works`",
    "  `@architect analyze the repo and create a doc explaining it`",
    "",
    "- Feature requests run the full planning pipeline:",
    "  `@architect add a payment webhook handler`"
  ].join("\n");
}

function renderCommandLink(command: CopilotArchitectCommand): string {
  return `<a href="command:${command.id}">${escapeHtml(command.title.replace("Copilot Architect: ", ""))}</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
