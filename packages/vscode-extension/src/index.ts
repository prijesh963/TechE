import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderRolePrompt } from "@copilot-architect/agents";
import { GroundingService, summarizeGrounding } from "@copilot-architect/grounding";
import { ReviewService } from "@copilot-architect/reviewer";
import { looksLikeRepo } from "@copilot-architect/shared";
import { ValidationService } from "@copilot-architect/validator";
import {
  IndexingService,
  tokenize,
  type SearchResult
} from "@copilot-architect/indexer";
import {
  buildPlannedChange,
  parsePlanApproach,
  createPlanContract,
  writeApprovedPlan,
  applyPlanChanges,
  checkOutlines,
  compareAgainstPlan,
  planValidationCommands,
  plannedPaths,
  applyFileEdits,
  describeRefusals,
  parseFileEdits,
  previewWrites,
  summarizeOutlineChecks,
  summarizeWrites,
  verifyPlanFreshness,
  type ApplyChangeInput,
  DEFAULT_MAX_CHANGES,
  parseSelectedChanges,
  parseAddOutlines,
  renderOutline,
  selectByRelevance,
  verifySelectedChanges,
  type PlanContract,
  type ParsedApproach,
  type PlannedOutline,
  type PlannedChange,
  type VerifiedChange
} from "@copilot-architect/planner";
import {
  SessionService,
  checkConstraints,
  diffCheckpoint,
  type Decision,
  type DecisionKind,
  type SessionPhase,
  type UnenforceableConstraint
} from "@copilot-architect/session";

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
    id: "copilotArchitect.buildGraph",
    title: "Copilot Architect: Build Symbol Graph",
    cliArgs: ["graph"]
  },
  {
    id: "copilotArchitect.startMcp",
    title: "Copilot Architect: Start MCP",
    cliArgs: ["mcp"],
    startsMcp: true
  },
  {
    id: "copilotArchitect.generateInstructions",
    title: "Copilot Architect: Generate Instructions",
    cliArgs: ["instructions", "generate"]
  }
];

/**
 * The links rendered directly in the dashboard's action row. Everything else
 * lives behind "More actions…" (see COPILOT_ARCHITECT_SECONDARY_ACTIONS) so a
 * narrow sidebar shows one row of buttons instead of eleven wrapped links.
 */
export const DASHBOARD_PRIMARY_ACTIONS: { id: string; label: string }[] = [
  { id: "copilotArchitect.setupRepo", label: "Setup Repo" },
  { id: "copilotArchitect.startAndSetupMcp", label: "Start & Setup MCP" },
  { id: "copilotArchitect.stopMcp", label: "Stop MCP" },
  { id: "copilotArchitect.generateInstructions", label: "Generate Instructions" }
];

/**
 * Commands reachable from the dashboard's "More actions…" quick pick rather
 * than as their own link: setup steps and lower-frequency actions.
 *
 * Plan, Validate and Review are deliberately not here. They were buttons that
 * ran the CLI and wrote a `FeaturePlan` to `plans/latest-plan.json`, while
 * `/create-plan` writes a `PlanContract` to `plans/approved/`. The two never
 * met, so a developer could produce two unrelated plans for one feature and
 * `/review` would only ever know about one of them. Those verbs belong to
 * `@architect`, where the session can hold them together.
 */
export const COPILOT_ARCHITECT_SECONDARY_ACTIONS: {
  id: string;
  label: string;
  description: string;
}[] = [
  {
    id: "copilotArchitect.openRepoInNewWindow",
    label: "Open Repo",
    description: "Open a different repository folder in this window"
  },
  {
    id: "copilotArchitect.workspaceScan",
    label: "Scan & Register Sub-repos",
    description: "Register every sub-directory of a folder as a workspace repo"
  },
  {
    id: "copilotArchitect.analyzeRepo",
    label: "Analyze Repo",
    description: "Rebuild repo-map.json only"
  },
  {
    id: "copilotArchitect.buildIndex",
    label: "Build Index",
    description: "Rebuild the searchable index only"
  },
  {
    id: "copilotArchitect.buildGraph",
    label: "Build Symbol Graph",
    description: "Rebuild graph.json — call and import edges used by search"
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
  /**
   * Renders a clickable command. Approve and End are buttons rather than
   * phrases because the gate that authorizes writing code must not depend on a
   * model reading sentiment out of "looks good to me".
   */
  button?(command: { command: string; title: string; arguments?: unknown[] }): void;
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

export interface QuickPickItemLike {
  label: string;
  description?: string;
  detail?: string;
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
    /**
     * With `items`, resolves to the one chosen — or `undefined` if dismissed.
     *
     * The apply step runs outside a chat turn, so a chat button cannot be
     * offered there. A notification action is the equivalent that works.
     */
    showInformationMessage(message: string, ...items: string[]): unknown;
    showErrorMessage(message: string, ...items: string[]): unknown;
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
    showQuickPick?(
      items: QuickPickItemLike[],
      options?: { title?: string; placeHolder?: string }
    ): Promise<QuickPickItemLike | undefined>;
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
    createTerminal?(options: {
      name: string;
      cwd?: string;
      env?: Record<string, string>;
    }): TerminalLike;
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
    /**
     * Serves the staged side of a diff. Registering a scheme is how VS Code
     * shows content that is not on disk: staging to a temp file would mean
     * writing before the write was agreed, which is the thing the preview
     * exists to prevent.
     */
    registerTextDocumentContentProvider?(
      scheme: string,
      provider: { provideTextDocumentContent(uri: UriLike): string | undefined }
    ): DisposableLike;
  };
  Uri?: {
    file(path: string): UriLike;
    parse?(value: string): UriLike;
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
  /** The work in progress. Absent when no session is open. */
  session?: DashboardSession;
}

/**
 * The session, flattened for display.
 *
 * The dashboard used to show only artifacts on disk — plan paths, validation
 * paths, a row of buttons — while the session model tracked the feature, the
 * phase, the decisions and which plan version was implemented, with nowhere to
 * appear. A developer could only find out where they were by scrolling the
 * chat.
 */
export interface DashboardSession {
  title: string;
  phase: SessionPhase;
  decisions: { kind: string; statement: string }[];
  plans: { version: number; status: string; implemented: boolean }[];
  /**
   * The branch moved since this session opened. Shown rather than acted on:
   * the next phase will park it, and a repaint must not.
   */
  staleBranch: boolean;
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
  contextInsights?: ContextInsights;
}

/**
 * How much repo content the latest plan narrowed the agent's context down to,
 * derived from two artifacts already on disk: every indexed file (the context
 * an agent has to fall back on without a plan) versus the files that plan
 * actually selected.
 *
 * Token counts are a chars÷4 estimate — the same directional estimator
 * `packages/measurement` uses (see docs/benchmarks/AFTER.md). It is not a real
 * tokenizer and not a Copilot billing figure.
 */
export interface ContextInsights {
  /** Files in the index, and their combined size as estimated tokens. */
  repoFileCount: number;
  repoEstimatedTokens: number;
  /** Files the latest plan selected, and their combined size as estimated tokens. */
  selectedFileCount: number;
  selectedEstimatedTokens: number;
  /** Rounded to one decimal place; 0 when the index has no measurable content. */
  reductionPercent: number;
  /** The request the latest plan was generated for, when recorded. */
  request?: string;
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

  /**
   * Starts (or restarts) the MCP server process. Shared by the Start MCP
   * command, Start & Setup MCP, and Setup Repo's final step so all three
   * track the same `activeMcpProcess` handle that Stop MCP disposes.
   */
  const startMcpServer = (cliArgs: string[] = ["mcp"]): void => {
    activeMcpProcess?.dispose();
    state.mcpStatus = "starting";
    const mcpArgs = [...cliArgs, "--path", workspaceRoot];
    outputChannel.appendLine(`$ ${createCliCommandLine(mcpArgs)}`);
    activeMcpProcess = mcpStarter.start({
      args: mcpArgs,
      cwd: extensionRoot,
      onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
    });
    state.mcpStatus = "running";
    state.lastCommand = createCliCommandLine(cliArgs);
    dashboard.refresh();
  };

  const runWorkflowCommand = async (
    commandId: string
  ): Promise<CliRunResult | undefined> => {
    const command = COPILOT_ARCHITECT_COMMANDS.find((item) => item.id === commandId);

    if (!command) {
      throw new Error(`Unknown Copilot Architect command: ${commandId}`);
    }

    if (command.startsMcp) {
      startMcpServer(command.cliArgs);
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

  /** Runs one Setup Repo step, logging it and reporting whether it passed. */
  const runSetupStep = async (label: string, args: string[]): Promise<boolean> => {
    outputChannel.appendLine(`\n[setup] ${label}`);
    outputChannel.appendLine(`$ ${createCliCommandLine(args)}`);
    const result = await runner.run({
      args,
      cwd: extensionRoot,
      onOutput: (stream, text) => outputChannel.appendLine(`[${stream}] ${text}`)
    });
    outputChannel.appendLine(
      result.exitCode === 0 ? `✓ ${label}` : `✗ ${label} (exit ${result.exitCode})`
    );
    return result.exitCode === 0;
  };

  /**
   * Registers every immediate sub-directory of `reposDir` as a workspace repo.
   * Shared by Setup Repo's multi-repo path and the standalone Scan & Register
   * command so the two cannot drift apart. Returns the directories that were
   * registered successfully.
   */
  const registerSubRepos = async (reposDir: string): Promise<string[]> => {
    let subDirs: string[];
    try {
      const entries = await readdir(reposDir, { withFileTypes: true });
      subDirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.join(reposDir, entry.name));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not read folder: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }

    if (subDirs.length === 0) {
      vscode.window.showInformationMessage(
        "No sub-directories found in the selected folder."
      );
      return [];
    }

    // A directory has to carry something that builds. Registering every
    // sub-directory swept `docs/`, `docker/` and `scripts/` into a workspace
    // beside eight real services — reported as "12 repos", with
    // documentation ranked against source in every search.
    const skipped: string[] = [];
    const candidates: string[] = [];

    for (const subDir of subDirs) {
      if (await looksLikeRepo(subDir)) {
        candidates.push(subDir);
      } else {
        skipped.push(path.basename(subDir));
      }
    }

    if (skipped.length > 0) {
      // Named, not silently dropped: a developer whose repo uses a build
      // system this does not know needs to see why it was left out.
      outputChannel.appendLine(
        `[workspace scan] skipped ${skipped.length} folder(s) with no project file: ${skipped.join(", ")}`
      );
    }

    if (candidates.length === 0) {
      vscode.window.showErrorMessage(
        `None of the ${subDirs.length} sub-directories look like repositories — no package.json, pom.xml, build.gradle or equivalent. Use "Setup Repo" if this folder is itself the repo.`
      );
      return [];
    }

    subDirs = candidates;

    outputChannel.appendLine(
      `[workspace scan] ${subDirs.length} repo(s) found in ${reposDir}`
    );

    // Skip workspace init when workspace.json already exists so a re-scan does
    // not drop previously registered repos.
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

    // The CLI takes repo name and path as positional arguments — passing the
    // name via --name would set the *workspace* name and leave the repo unnamed.
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

    return registeredDirs;
  };

  /**
   * One-click repo onboarding: initialize artifacts, analyze, build the
   * symbol graph and index, run the readiness assessment, install agents, and
   * configure + start the MCP server. Handles a single repo (the current
   * workspace folder) or a parent folder of sub-repos, chosen up front.
   *
   * Steps run to completion even if an earlier one fails — the dashboard's
   * Start & Setup MCP and Install Agents actions exist precisely so a user can
   * retry an individual step, so aborting the whole chain on the first failure
   * would just hide the rest of the work.
   */
  const setupRepo = async (): Promise<void> => {
    const MULTI_REPO_LABEL = "Multiple repos";
    const mode = await vscode.window.showQuickPick?.(
      [
        {
          label: "This repo",
          description: workspaceRoot,
          detail: "Set up the folder currently open in this window"
        },
        {
          label: MULTI_REPO_LABEL,
          description: "Pick a parent folder",
          detail: "Register and set up every sub-directory as a separate repo"
        }
      ],
      {
        title: "Copilot Architect: Setup Repo",
        placeHolder: "What do you want to set up?"
      }
    );

    // A host without showQuickPick (or a dismissed picker) falls back to the
    // single-repo path rather than doing nothing.
    if (mode === undefined && vscode.window.showQuickPick) return;

    const multiRepo = mode?.label === MULTI_REPO_LABEL;
    outputChannel.show(true);
    outputChannel.appendLine(
      `\n=== Copilot Architect setup (${multiRepo ? "multi-repo" : "single repo"}) ===`
    );

    const failed: string[] = [];
    const track = async (label: string, args: string[]): Promise<void> => {
      if (!(await runSetupStep(label, args))) failed.push(label);
    };

    let repoRoots: string[] = [workspaceRoot];

    if (multiRepo) {
      const uris = await vscode.window.showOpenDialog?.({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "Select Repos Folder",
        title: "Select the folder whose immediate sub-directories are your repositories"
      });
      const reposDir = uris?.[0]?.fsPath;
      if (!reposDir) return;

      const registered = await registerSubRepos(reposDir);
      if (registered.length === 0) {
        vscode.window.showErrorMessage(
          "No repos could be registered. Check the Output channel for details."
        );
        return;
      }
      repoRoots = registered;
      vscode.window.showInformationMessage(
        `Registered ${registered.length} repos — setting each one up, please wait…`
      );
    }

    // Per-repo steps: artifacts, repo map, symbol graph, readiness assessment.
    // The graph is what powers graph-signal search ranking and "why relevant"
    // plan citations. Assessment is per-repo because it reports on one repo's
    // languages/tests/risks — running it only on a parent container folder in
    // multi-repo mode would report on a folder that usually isn't a repo.
    for (const repoRoot of repoRoots) {
      const name = path.basename(repoRoot);
      await track(`Initialize artifacts (${name})`, ["init", "--path", repoRoot]);
      await track(`Analyze repo (${name})`, ["analyze", "--path", repoRoot]);
      await track(`Build symbol graph (${name})`, ["graph", "--path", repoRoot]);
      await track(`Repo assessment (${name})`, ["diagnostics", "--path", repoRoot]);
    }

    // Index: one combined workspace index for multi-repo, per-repo otherwise.
    if (multiRepo) {
      await track("Build workspace index", [
        "workspace",
        "index",
        "--path",
        workspaceRoot
      ]);

      // A workspace-wide graph is what lets search surface a shared library a
      // service actually calls. It only pays off when the repos share code, so
      // the first build records what it found and a workspace that shares none
      // stops rebuilding it — see shouldBuildWorkspaceGraph.
      const repoNames = repoRoots.map((repoRoot) => path.basename(repoRoot));
      if (await shouldBuildWorkspaceGraph(workspaceRoot, repoNames)) {
        await track("Build workspace symbol graph", ["graph", "--path", workspaceRoot]);
      } else {
        outputChannel.appendLine(
          "Skipped workspace symbol graph: the last build found no code shared " +
            "between these repos. Delete .copilot-architect/graph-workspace.json " +
            "to force a rebuild."
        );
      }
    } else {
      await track("Build index", ["index", "--path", workspaceRoot]);
    }

    await track("Configure MCP server", ["mcp", "config", "--path", workspaceRoot]);

    startMcpServer();

    if (multiRepo) {
      // Surface the registered repos in the Explorer — otherwise the scan only
      // updates workspace.json and the file tree keeps showing the original repo.
      addWorkspaceFolders(vscode, repoRoots);
    }

    state.lastCommand = `setup repo (${multiRepo ? `${repoRoots.length} repos` : "single"})`;
    state.lastExitCode = failed.length === 0 ? 0 : 1;
    dashboard.refresh();

    outputChannel.appendLine(
      failed.length === 0
        ? "\n=== Setup complete. MCP server started. ==="
        : `\n=== Setup finished with ${failed.length} failed step(s): ${failed.join(", ")} ===`
    );

    if (failed.length === 0) {
      vscode.window.showInformationMessage(
        `Setup complete for ${multiRepo ? `${repoRoots.length} repos` : "this repo"} — MCP server started. Use @architect to plan a feature.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Setup finished with ${failed.length} failed step(s): ${failed.join(", ")}. Retry them from the dashboard or check the Output channel.`
      );
    }
  };

  for (const command of COPILOT_ARCHITECT_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command.id, () => runWorkflowCommand(command.id))
    );
  }

  const chatSessions = new SessionService();

  if (vscode.workspace.registerTextDocumentContentProvider) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(STAGED_SCHEME, {
        // Read-only and in memory: the diff's right-hand side is content that
        // has deliberately not been written yet.
        provideTextDocumentContent: (uri) => {
          const parsed = parseStagedUri(uri.toString());

          if (!parsed || parsed.side === "empty") {
            return "";
          }

          const staged = stagedWrites.get(parsed.workspaceRoot);
          const change = staged?.changes.find(
            (candidate) => candidate.relativePath === parsed.relativePath
          );

          return change?.afterText ?? "";
        }
      })
    );
  }

  context.subscriptions.push(
    /**
     * Approval is a command, not a phrase. It is the gate that authorizes
     * writing code and promotes a draft to a plan on disk, so it must not rest
     * on a model deciding that "looks good to me" meant yes.
     */
    vscode.commands.registerCommand(APPROVE_PLAN_COMMAND, async (...args) => {
      const version = Number(args[0]);
      const approved = await chatSessions.approvePlan({ workspaceRoot }, version);
      const plan = chatSessions.latestApprovedPlan(approved);

      if (plan) {
        // Only now does it leave the session. The session stores plan bodies
        // opaquely — it owns versioning and approval, the planner owns shape.
        await writeApprovedPlan(workspaceRoot, plan.content as unknown as PlanContract);
      }

      dashboard.refresh();
      vscode.window.showInformationMessage(
        `Plan v${version} approved — run \`/implement\` when ready.`
      );
    }),
    vscode.commands.registerCommand(OPEN_FILE_COMMAND, async (...args) => {
      const relativePath = String(args[0] ?? "");
      const fileUri = vscode.Uri?.file;

      if (!relativePath || !fileUri) {
        return;
      }

      // The whole file, not the excerpt: the excerpt is what implementation
      // sees, and a developer checking whether it is the right window needs
      // what is around it.
      await vscode.commands.executeCommand?.(
        "vscode.open",
        fileUri(path.join(workspaceRoot, relativePath))
      );
    }),
    vscode.commands.registerCommand(RUN_VALIDATION_COMMAND, async () => {
      const channel = outputChannel;
      channel.appendLine("$ validation");
      channel.show?.(true);

      try {
        const result = await new ValidationService().validate({
          startPath: workspaceRoot,
          categories: ["test", "lint"],
          onOutput: (event) => channel.appendLine(`[${event.stream}] ${event.text}`)
        });

        const { passed, failed, blocked, timedOut } = summarizeValidation(result);
        state.lastCommand = "validation";
        state.lastExitCode = failed + blocked + timedOut > 0 ? 1 : 0;
        dashboard.refresh();

        vscode.window.showInformationMessage(
          `Validation: ${passed} passed, ${failed} failed, ${blocked} blocked, ${timedOut} timed out.`
        );
      } catch (error) {
        // Reported rather than swallowed: "no validation ran" and "validation
        // passed" must not look the same.
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[error] ${message}`);
        vscode.window.showErrorMessage(`Validation could not run: ${message}`);
      }
    }),
    vscode.commands.registerCommand(SHOW_DIFF_COMMAND, async (...args) => {
      const relativePath = String(args[0] ?? "");
      const staged = stagedWrites.get(workspaceRoot);
      const change = staged?.changes.find(
        (candidate) => candidate.relativePath === relativePath
      );

      if (!change) {
        vscode.window.showErrorMessage(
          `\`${relativePath}\` is no longer staged. Run \`/implement\` again to regenerate it.`
        );
        return;
      }

      const parseUri = vscode.Uri?.parse;
      const fileUri = vscode.Uri?.file;
      if (!parseUri || !fileUri) {
        vscode.window.showErrorMessage("This VS Code build cannot open a diff view.");
        return;
      }

      // Left is what is on disk now; right is what would replace it. For an
      // add the left side is an empty staged document rather than a missing
      // file, so the diff opens instead of failing on a path that is not
      // there yet.
      const onDisk =
        change.kind === "add"
          ? parseUri(stagedUri(workspaceRoot, relativePath, "empty"))
          : fileUri(path.join(workspaceRoot, relativePath));
      const proposed =
        change.kind === "delete"
          ? parseUri(stagedUri(workspaceRoot, relativePath, "empty"))
          : parseUri(stagedUri(workspaceRoot, relativePath));

      await vscode.commands.executeCommand?.(
        "vscode.diff",
        onDisk,
        proposed,
        `${relativePath} — staged (not yet written)`
      );
    }),
    vscode.commands.registerCommand(APPLY_CHANGES_COMMAND, async (...args) => {
      const version = Number(args[0]);
      const channel = outputChannel;
      // The chat turn that staged these is over, so a stream at this point
      // reaches only the output channel. The detail belongs there; the result
      // has to reach the developer where they are looking, which is the
      // editor — clicking Apply and seeing nothing change is the same
      // experience as clicking a button that does not work.
      const sink: ChatResponseStreamLike = {
        markdown: (value: string) => channel.appendLine(value.trimEnd())
      };

      const outcome = await applyStagedWrites(
        vscode,
        chatSessions,
        workspaceRoot,
        version,
        sink
      );
      dashboard.refresh();

      if (outcome.blocked) {
        channel.show?.(true);
        vscode.window.showErrorMessage(outcome.blocked);
        return;
      }

      await reportApplied(vscode, outcome, channel);
    }),
    vscode.commands.registerCommand(CONFIRM_DECISION_COMMAND, async (...args) => {
      const proposal = args[0] as ProposedDecision | undefined;

      if (!proposal?.statement) {
        return;
      }

      // Through current(), not peek(): this writes, so a session whose branch
      // moved should be parked rather than quietly extended.
      const session = await chatSessions.current({ workspaceRoot });

      if (!session) {
        vscode.window.showErrorMessage(
          "No active session — that decision has nowhere to be recorded. Start with `/create-plan`."
        );
        return;
      }

      // Re-checked against the session as it is now, not as it was when the
      // button was rendered. A chat turn can sit on screen for a long time,
      // and recordDecision throws on an id it cannot find — which would lose
      // the developer's click over a stale button.
      const replaced = proposal.replaces
        ? session.decisions.find((decision) => decision.id === proposal.replaces)
        : undefined;

      await chatSessions.recordDecision(
        { workspaceRoot },
        {
          kind: proposal.kind,
          statement: proposal.statement,
          ...(proposal.rejected ? { rejected: proposal.rejected } : {}),
          ...(replaced ? { supersedes: replaced.id } : {})
        }
      );

      dashboard.refresh();
      vscode.window.showInformationMessage(
        replaced
          ? `Replaced "${truncate(replaced.statement, 40)}" with "${truncate(proposal.statement, 40)}"`
          : `Recorded: ${truncate(proposal.statement, 60)}`
      );
    }),
    vscode.commands.registerCommand(END_SESSION_COMMAND, async () => {
      await chatSessions.end({ workspaceRoot });
      dashboard.refresh();
      vscode.window.showInformationMessage("Session ended.");
    }),
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

      outputChannel.show(true);
      const registeredDirs = await registerSubRepos(reposDir);

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
    }),
    vscode.commands.registerCommand("copilotArchitect.setupRepo", () => setupRepo()),
    vscode.commands.registerCommand("copilotArchitect.startAndSetupMcp", async () => {
      outputChannel.show(true);
      const configured = await runSetupStep("Configure MCP server", [
        "mcp",
        "config",
        "--path",
        workspaceRoot
      ]);
      startMcpServer();
      vscode.window.showInformationMessage(
        configured
          ? "MCP server configured and started."
          : "MCP server started, but writing the Copilot Chat config failed — see the Output channel."
      );
    }),
    vscode.commands.registerCommand("copilotArchitect.stopMcp", () => {
      if (!activeMcpProcess) {
        vscode.window.showInformationMessage(
          "No MCP server is running from this window."
        );
        state.mcpStatus = "stopped";
        dashboard.refresh();
        return;
      }

      activeMcpProcess.dispose();
      activeMcpProcess = undefined;
      state.mcpStatus = "stopped";
      state.lastCommand = "mcp stop";
      outputChannel.appendLine("\n[mcp] server stopped.");
      dashboard.refresh();
      vscode.window.showInformationMessage("Copilot Architect MCP server stopped.");
    }),
    vscode.commands.registerCommand("copilotArchitect.moreActions", async () => {
      const picked = await vscode.window.showQuickPick?.(
        COPILOT_ARCHITECT_SECONDARY_ACTIONS.map((action) => ({
          label: action.label,
          description: action.description
        })),
        {
          title: "Copilot Architect",
          placeHolder: "Pick an action"
        }
      );

      if (!picked) return;

      const action = COPILOT_ARCHITECT_SECONDARY_ACTIONS.find(
        (candidate) => candidate.label === picked.label
      );

      if (action) {
        await vscode.commands.executeCommand?.(action.id);
      }
    })
  );

  if (vscode.chat) {
    const sessions = new SessionService();

    /**
     * One door. Four phases, named explicitly rather than guessed.
     *
     * The previous handler ran `classifyIntent` over the prompt to decide
     * whether you wanted a question answered or a feature planned. Guessing
     * that from wording meant the same sentence could route two ways on two
     * days. A bare prompt now means `/analyze` — a stated rule rather than an
     * inference — and everything else is asked for by name.
     */
    const chatHandler: ChatRequestHandlerLike = async (
      request,
      context,
      stream,
      token
    ) => {
      const prompt = request.prompt.trim();
      const command = request.command ?? "analyze";

      if (command === "help" || (!request.command && !prompt)) {
        stream.markdown(getChatHelpText());
        return;
      }

      const phase = CHAT_PHASES[command];
      if (!phase) {
        stream.markdown(
          `Unknown command \`/${command}\`. Use \`/help\` to see what @architect can do.`
        );
        return;
      }

      try {
        switch (phase) {
          case "analyze":
            await runAnalyzePhase(
              vscode,
              sessions,
              workspaceRoot,
              prompt,
              context,
              stream,
              token
            );
            break;
          case "plan":
            await runPlanPhase(vscode, sessions, workspaceRoot, prompt, stream, token);
            break;
          case "implement":
            await runImplementPhase(vscode, sessions, workspaceRoot, stream, token);
            break;
          case "review":
            await runReviewPhase(vscode, sessions, workspaceRoot, stream, token);
            break;
        }
      } catch (error) {
        // Never a bare failure: the developer should know which step broke.
        stream.markdown(
          `\n**${phase} failed** — ${error instanceof Error ? error.message : String(error)}`
        );
      }
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
      const [exe, cliArgs] = resolveCliSpawn(request.args);
      const child = spawn(exe, cliArgs, {
        cwd: request.cwd,
        shell: false,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          // VS Code's own binary runs as Node with this set, so an installed
          // extension does not depend on the user having Node on PATH.
          ELECTRON_RUN_AS_NODE: "1"
        }
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
        cwd: request.cwd,
        // The command below is VS Code's own binary. Without this it would
        // launch another editor window instead of running the CLI.
        env: { ELECTRON_RUN_AS_NODE: "1" }
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
    const [exe, cliArgs] = resolveCliSpawn(request.args);
    const child = spawn(exe, cliArgs, {
      cwd: request.cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" }
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

    try {
      this.state.session = await loadDashboardSession(this.state.workspaceRoot);
    } catch {
      // Same: a session that cannot be read is not a session that ended.
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

/**
 * The session as a card.
 *
 * Idle is a real state with real content, not a blank panel: a developer with
 * no session open should be told what to type, not left guessing whether the
 * extension is working.
 */
export function formatSession(session: DashboardSession | undefined): string {
  if (!session) {
    return [
      "<em>No session open.</em>",
      "Start one in Copilot Chat with <code>@architect /create-plan &lt;what you want&gt;</code>,",
      "or ask a question with <code>@architect /analyze</code>."
    ].join(" ");
  }

  const lines = [
    `<strong>${escapeHtml(session.title)}</strong>`,
    `Phase: ${escapeHtml(session.phase)}`
  ];

  if (session.staleBranch) {
    lines.push(
      "<em>The branch has moved since this session opened — the next phase will park it.</em>"
    );
  }

  lines.push(formatSessionPlans(session.plans));
  lines.push(formatSessionDecisions(session.decisions));

  return lines.join("<br>");
}

function formatSessionPlans(plans: DashboardSession["plans"]): string {
  if (plans.length === 0) {
    return "Plans: none drafted yet";
  }

  const latest = plans[plans.length - 1];
  const implemented = plans.filter((plan) => plan.implemented).map((p) => p.version);
  const approved = plans.filter((plan) => plan.status === "approved").length;

  const parts = [
    `Plans: v${latest.version} ${latest.status}`,
    `${approved} of ${plans.length} approved`
  ];

  // Which version is running matters more than how many exist: it is what
  // /review compares against.
  parts.push(
    implemented.length > 0
      ? `implemented v${implemented.join(", v")}`
      : "none implemented"
  );

  return escapeHtml(parts.join(" · "));
}

function formatSessionDecisions(decisions: DashboardSession["decisions"]): string {
  if (decisions.length === 0) {
    return "Decisions: none recorded — <code>/create-plan</code> proposes them to confirm";
  }

  // Joined with <br> rather than a <ul>: each section body is rendered inside
  // a <p>, and a list nested in a paragraph is invalid and lays out badly.
  const rows = decisions
    .map(
      (decision) =>
        `&nbsp;&nbsp;· ${escapeHtml(decision.kind)} — ${escapeHtml(decision.statement)}`
    )
    .join("<br>");

  return `Decisions (${decisions.length}):<br>${rows}`;
}

export function createDashboardHtml(state: ExtensionState): string {
  const artifacts = state.artifacts;
  const sections = [
    {
      // First, because it is the answer to "where am I?" — the question the
      // dashboard exists to answer and previously could not.
      title: "Current work",
      body: formatSession(state.session)
    },
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
    },
    {
      // So a developer re-testing a fix can see which build is running
      // without having to deduce it from behaviour.
      title: "Build",
      body: escapeHtml(EXTENSION_VERSION)
    },
    {
      title: "Agent insights",
      body: escapeHtml(formatAgentInsights(artifacts))
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
    `<div class="actions">${DASHBOARD_PRIMARY_ACTIONS.map(renderActionLink).join("")}<a href="command:copilotArchitect.moreActions">More actions…</a></div>`,
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

/**
 * The command line, as it will actually be run.
 *
 * It is both what the output channel echoes and what the MCP terminal
 * executes, so it cannot be a friendly approximation: `npm run cli --` only
 * resolves inside this monorepo, and an installed extension has no monorepo
 * to resolve it against.
 */
export function createCliCommandLine(args: string[]): string {
  const [exe, cliArgs] = resolveCliSpawn(args);
  return [exe, ...cliArgs].map(quoteCliArg).join(" ");
}

// --- Dashboard artifact loading + formatting ---

/**
 * Reads the session for display.
 *
 * Deliberately `peek` and not `current`: `current` parks a session whose
 * branch has moved, and a dashboard repaint must never end the developer's
 * session as a side effect of being looked at. Staleness is reported instead,
 * and the next phase — which does act — parks it.
 */
export async function loadDashboardSession(
  workspaceRoot: string,
  sessions: SessionService = new SessionService()
): Promise<DashboardSession | undefined> {
  const peeked = await sessions.peek({ workspaceRoot }).catch(() => undefined);

  if (!peeked) {
    return undefined;
  }

  const { session, staleBranch } = peeked;

  return {
    title: session.title,
    phase: session.phase,
    decisions: sessions.activeDecisions(session).map((decision) => ({
      kind: decision.kind,
      statement: decision.statement
    })),
    plans: session.plans.map((plan) => ({
      version: plan.version,
      status: plan.status,
      implemented: Boolean(plan.implementedAt)
    })),
    staleBranch
  };
}

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
    relevantFiles?: Array<{ filePath?: string }>;
  }>(path.join(root, "plans", "latest-plan.json"));
  if (plan) {
    artifacts.latestPlan = {
      title: plan.title ?? plan.task ?? "Untitled plan",
      status: plan.status,
      generatedAt: plan.generatedAt
    };
  }

  artifacts.contextInsights = await loadContextInsights(root, plan);

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

// Roughly 4 characters per token. Kept in sync with packages/measurement's own
// CHARS_PER_TOKEN by value rather than by import: the extension ships
// standalone and deliberately depends on no workspace package at runtime.
const CHARS_PER_TOKEN = 4;

/**
 * Compares the whole indexed repo against what the latest plan selected, using
 * file sizes the indexer already recorded — no filesystem walk on refresh.
 * Returns undefined when there is no index to measure against.
 */
async function loadContextInsights(
  artifactRoot: string,
  plan: { task?: string; relevantFiles?: Array<{ filePath?: string }> } | undefined
): Promise<ContextInsights | undefined> {
  const index = await readJsonSafe<{
    documents?: Array<{ relativePath?: string; fileSizeBytes?: number }>;
  }>(path.join(artifactRoot, "index", "index.json"));
  const documents = index?.documents ?? [];

  if (documents.length === 0) {
    return undefined;
  }

  const repoBytes = documents.reduce(
    (total, doc) => total + (doc.fileSizeBytes ?? 0),
    0
  );
  const selectedPaths = new Set(
    (plan?.relevantFiles ?? [])
      .map((file) => file.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
  );
  const selected = documents.filter(
    (doc) => doc.relativePath && selectedPaths.has(doc.relativePath)
  );
  const selectedBytes = selected.reduce(
    (total, doc) => total + (doc.fileSizeBytes ?? 0),
    0
  );
  const repoEstimatedTokens = Math.round(repoBytes / CHARS_PER_TOKEN);
  const selectedEstimatedTokens = Math.round(selectedBytes / CHARS_PER_TOKEN);

  return {
    repoFileCount: documents.length,
    repoEstimatedTokens,
    selectedFileCount: selected.length,
    selectedEstimatedTokens,
    reductionPercent:
      repoEstimatedTokens > 0
        ? Math.round((1 - selectedEstimatedTokens / repoEstimatedTokens) * 1000) / 10
        : 0,
    request: plan?.task
  };
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
    : "Roles are built in — nothing to install.";
}

export function formatAgentInsights(artifacts: DashboardArtifacts | undefined): string {
  const insights = artifacts?.contextInsights;

  if (!insights) {
    return "No index yet — run Setup Repo to measure context usage.";
  }

  const without = `Without Copilot Architect: ${formatFileCount(insights.repoFileCount)} · ~${formatTokens(insights.repoEstimatedTokens)} tokens`;

  if (insights.selectedFileCount === 0) {
    return `${without}. No plan yet — run Generate Plan to compare.`;
  }

  const withArchitect = `With Copilot Architect: ${formatFileCount(insights.selectedFileCount)} · ~${formatTokens(insights.selectedEstimatedTokens)} tokens`;
  const saved = insights.repoEstimatedTokens - insights.selectedEstimatedTokens;
  const savings = `Sends ${insights.reductionPercent}% less (~${formatTokens(saved)} tokens) per request`;
  const request = insights.request ? ` for "${truncate(insights.request, 48)}"` : "";

  return [
    without,
    withArchitect,
    `${savings}${request}.`,
    // "Without" means the whole repo — the fallback when an agent has no plan
    // to go on. It is not a measurement of what Copilot itself sends (Copilot
    // does its own retrieval), and chars÷4 is not a real tokenizer, so the
    // caveat spells out the baseline. See docs/benchmarks/AFTER.md.
    "Estimate only (chars÷4), measured against whole-repo context — not a Copilot bill."
  ].join(" · ");
}

function formatFileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
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
/**
 * How to run the CLI.
 *
 * It used to spawn `npm run cli --`, which resolves only when the working
 * directory is this monorepo — so a packaged extension on a teammate's machine
 * could not run a single command. The bundled CLI sits beside the extension and
 * is invoked by absolute path: no npm, no monorepo, nothing to resolve on the
 * user's disk.
 *
 * Falls back to the monorepo's CLI when the bundle is absent, which is the
 * case while developing the extension from source.
 */
function resolveCliSpawn(args: string[]): [string, string[]] {
  return [process.execPath, [resolveBundledCli(), ...args]];
}

function resolveBundledCli(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "cli.mjs");

  if (existsSync(bundled)) {
    return bundled;
  }

  // Development: running from source, where the built CLI lives in the workspace.
  return path.resolve(here, "..", "..", "cli", "dist", "index.js");
}

/**
 * Rebuilds the symbol graph after implementation.
 *
 * Through the CLI rather than by importing the graph package: that pulls in the
 * TypeScript compiler, 9.5 MB that every extension activation would carry for a
 * step which runs once per implementation.
 */
async function rebuildSymbolGraph(workspaceRoot: string): Promise<boolean> {
  try {
    const result = await new NodeCliRunner().run({
      args: ["graph", "--path", workspaceRoot],
      cwd: workspaceRoot
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
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

/** Slash command to session phase. The only routing table there is. */
const CHAT_PHASES: Record<string, SessionPhase | undefined> = {
  analyze: "analyze",
  "create-plan": "plan",
  implement: "implement",
  review: "review"
};

/**
 * How many search hits to offer the selection step. Wider than the plan will
 * use: retrieval is local and free, and the model can only reject a file it
 * was shown.
 */
const PLAN_CANDIDATE_LIMIT = 16;

/**
 * Proposing decisions for the developer to confirm.
 *
 * The session model rests on recorded decisions — they are what stops
 * `/implement` re-asking what `/create-plan` already settled. Until now
 * nothing produced them: `recordDecision` existed and was tested, but no code
 * path called it, so the Decisions block rendered empty forever.
 *
 * The model proposes; the developer confirms. Only a confirmed proposal is
 * recorded, because a decision nobody agreed to is worse than no decision —
 * it would bind implementation to a choice the developer never made.
 */
export interface ProposedDecision {
  kind: DecisionKind;
  statement: string;
  rejected?: string;
  /**
   * The id of a recorded decision this replaces, when the developer has
   * changed their mind. Shown before it is acted on: superseding the wrong
   * decision silently would be worse than the contradiction it fixes, so the
   * developer sees what they are replacing and the id is re-checked against
   * the live session before anything is written.
   */
  replaces?: string;
}

const DECISION_KINDS: DecisionKind[] = ["design", "scope", "constraint", "fact"];

/** The shape `SessionService.recordDecision` mints: `d1`, `d2`, … */
const DECISION_ID = /^d\d+$/;

/** How many proposals to show. More than this is a wall of buttons nobody reads. */
const MAX_PROPOSED_DECISIONS = 4;

export const CONFIRM_DECISION_COMMAND = "copilotArchitect.confirmDecision";

export const OPEN_FILE_COMMAND = "copilotArchitect.openPlannedFile";

export const RUN_VALIDATION_COMMAND = "copilotArchitect.runValidation";

export const SHOW_DIFF_COMMAND = "copilotArchitect.showStagedDiff";

/**
 * The scheme staged content is served under.
 *
 * A diff needs a URI for each side, and the staged side is not on disk. A
 * temp file would be writing before the write was agreed — the exact thing
 * the preview exists to prevent — so it is served from memory instead.
 */
export const STAGED_SCHEME = "copilot-architect-staged";

/**
 * Builds the URI for one staged file.
 *
 * The path is carried in the query rather than the path component so a file
 * that is being added shows its real name in the diff editor's title, which
 * is the only place the developer can tell which file they are looking at.
 */
export function stagedUri(
  workspaceRoot: string,
  relativePath: string,
  side: "staged" | "empty" = "staged"
): string {
  const query = new URLSearchParams({ root: workspaceRoot, side });
  // The path keeps its real name so the diff editor's title says which file
  // is being looked at; everything else rides in the query.
  return `${STAGED_SCHEME}:/${relativePath}?${query.toString()}`;
}

/** Reads back what `stagedUri` encoded, or `undefined` if it was not one. */
export function parseStagedUri(
  value: string
):
  | { workspaceRoot: string; relativePath: string; side: "staged" | "empty" }
  | undefined {
  if (!value.startsWith(`${STAGED_SCHEME}:/`)) {
    return undefined;
  }

  const withoutScheme = value.slice(`${STAGED_SCHEME}:/`.length);
  const split = withoutScheme.indexOf("?");

  if (split < 0) {
    return undefined;
  }

  const query = new URLSearchParams(withoutScheme.slice(split + 1));
  const root = query.get("root");

  if (!root) {
    return undefined;
  }

  return {
    relativePath: withoutScheme.slice(0, split),
    workspaceRoot: root,
    side: query.get("side") === "empty" ? "empty" : "staged"
  };
}

export const APPLY_CHANGES_COMMAND = "copilotArchitect.applyChanges";

/**
 * Changes generated by `/implement` and waiting for the developer to look at
 * them, keyed by workspace.
 *
 * In memory on purpose. Staging to disk would mean writing before the write
 * was agreed, and would leave stale content behind for every implement run
 * that was never applied. The cost is that a window reload loses the staging,
 * which the apply command says plainly rather than writing content whose
 * preview the developer can no longer see.
 */
const stagedWrites = new Map<
  string,
  {
    plan: PlanContract;
    version: number;
    changes: ApplyChangeInput[];
    unenforceable: UnenforceableConstraint[];
  }
>();

export const APPROVE_PLAN_COMMAND = "copilotArchitect.approvePlan";
export const END_SESSION_COMMAND = "copilotArchitect.endSession";

/**
 * What the answer was based on, on every response.
 *
 * Without it, a thin answer and a broken index look identical from the outside
 * — which is how "the repo is empty" read as a finding rather than a failure.
 * Stating the basis turns a silent gap into something a developer can question.
 */
async function buildReceipts(workspaceRoot: string): Promise<string> {
  const inventory = await new IndexingService()
    .listFiles({ startPath: workspaceRoot, limit: 1 })
    .catch(() => undefined);

  if (!inventory) {
    return "_No index yet — run **Setup Repo**, or just ask again and one will be built._";
  }

  const repos = inventory.repos?.length ?? 1;
  return `_Looked at ${inventory.totalFiles} files across ${repos} repo${repos === 1 ? "" : "s"}. ${buildLabel()}_`;
}

/**
 * Which build produced this answer.
 *
 * Every VSIX shipped as 0.1.0, so a developer re-testing a fix could not tell
 * whether the extension running was the one they had just built. A fix
 * verified in the repository looked broken in the editor, twice, because the
 * old bundle was still installed and nothing said so.
 */
export function buildLabel(): string {
  return `Build ${EXTENSION_VERSION}.`;
}

/**
 * Read from the manifest beside the bundled extension, which the packaging
 * script stamps with the commit count. Unknown when running from source,
 * where the manifest still carries the base version.
 */
const EXTENSION_VERSION = readExtensionVersion();

function readExtensionVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(path.join(here, "package.json"), "utf8")
    ) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    // Running from source, where the bundle's manifest is not beside this
    // file. Saying so beats printing a version that means nothing.
    return "from source";
  }
}

/** Opens a session on first use rather than making setup a separate step. */
async function ensureSession(
  sessions: SessionService,
  workspaceRoot: string,
  title: string,
  phase: SessionPhase
): Promise<ReturnType<SessionService["open"]>> {
  const current = await sessions.current({ workspaceRoot });

  if (!current) {
    return sessions.open({ workspaceRoot, title, phase });
  }

  return current.phase === phase
    ? Promise.resolve(current)
    : sessions.setPhase({ workspaceRoot }, phase);
}

/** Decisions on screen while planning, so a misreading is caught in seconds. */
function renderDecisions(
  sessions: SessionService,
  session: Awaited<ReturnType<SessionService["open"]>>
): string {
  const decisions = sessions.activeDecisions(session);

  if (decisions.length === 0) {
    return "";
  }

  const rows = decisions
    .map((decision) => {
      const rejected = decision.rejected ? ` _(over ${decision.rejected})_` : "";
      return `- **${decision.kind}** — ${decision.statement}${rejected}`;
    })
    .join("\n");

  return `\n**Decisions so far**\n${rows}\n`;
}

async function runAnalyzePhase(
  vscode: VscodeApiLike,
  sessions: SessionService,
  workspaceRoot: string,
  prompt: string,
  context: { history?: ChatHistoryTurnLike[] },
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<void> {
  stream.progress?.("Searching your codebase…");
  await ensureSession(sessions, workspaceRoot, prompt || "Repo analysis", "analyze");

  const repoResult = await buildRepoContext(workspaceRoot, prompt);
  const userTerms = [...new Set(tokenize(prompt))];
  let fileContext = await readFilesForLmContext(
    workspaceRoot,
    repoResult.fileAnchors,
    userTerms
  );

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeRelPath = path.relative(workspaceRoot, activeEditor.document.fileName);
    if (
      !repoResult.fileAnchors.some((anchor) => anchor.relativePath === activeRelPath)
    ) {
      fileContext += `\n\n=== Currently open in editor: ${activeRelPath} ===\n${activeEditor.document.getText().slice(0, 3_000)}`;
    }
  }

  let repoContext = repoResult.contextText;
  if (!repoContext.trim() && repoResult.fileAnchors.length === 0) {
    const diagnosis = await diagnoseEmptyContext(workspaceRoot);
    stream.markdown(`> ⚠️ ${diagnosis}\n\n`);
    repoContext =
      `NO REPOSITORY CONTEXT IS AVAILABLE. ${diagnosis}\n` +
      "Tell the user this and name that step. Do not infer what the " +
      "repository does or does not contain — you have not seen it.";
  }

  let answer = "";
  if (vscode.lm) {
    stream.progress?.("Generating answer…");
    const lmPrompt = buildCommandLmPrompt(
      "question",
      prompt,
      renderRolePrompt("analyze"),
      repoContext,
      fileContext,
      formatChatHistory(context.history ?? [])
    );
    if (lmPrompt) {
      // Streamed to the user and captured, so the same text can be checked
      // against the index without asking the model a second time.
      const captured: string[] = [];
      const tee: ChatResponseStreamLike = {
        markdown: (value: string) => {
          captured.push(value);
          stream.markdown(value);
        },
        progress: stream.progress?.bind(stream)
      };
      await streamLmResponse(vscode, lmPrompt, tee, token);
      answer = captured.join("");
    }
  }

  // Verification is local and costs no tokens. An unverifiable claim is
  // flagged, never removed — the developer decides what to do with it.
  const grounding = await new GroundingService()
    .verify(answer, { startPath: workspaceRoot })
    .catch(() => undefined);
  const warning = grounding ? summarizeGrounding(grounding) : undefined;
  if (warning) {
    stream.markdown(`\n\n${warning}`);
  }

  stream.markdown(`\n\n${await buildReceipts(workspaceRoot)}`);
  stream.markdown("\n\nReady to plan a change? Use `/create-plan <what you want>`.");
}

/**
 * Drafts a plan into the session. Nothing is written to disk until Approve,
 * which reverses the old order where a plan was written first and marked
 * approved afterwards.
 */
async function runPlanPhase(
  vscode: VscodeApiLike,
  sessions: SessionService,
  workspaceRoot: string,
  prompt: string,
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<void> {
  if (!prompt) {
    stream.markdown(
      "Tell me what to plan — `/create-plan Add invoice approval workflow`."
    );
    return;
  }

  stream.progress?.("Finding the files this touches…");
  const session = await ensureSession(sessions, workspaceRoot, prompt, "plan");

  // The request's own premise, checked before anything is planned on it.
  // A request to fix `authenticationManager()` in a repository with no Spring
  // Security is a request about code that is not there — usually because an
  // earlier answer invented it. Planning proceeds anyway, because naming
  // something that does not exist yet is how a new feature is asked for; but
  // the developer is told, before they read a plan built on it.
  const premise = await new GroundingService()
    .verify(prompt, { startPath: workspaceRoot })
    .catch(() => undefined);
  const absent = premise?.unverified.filter((result) => result.claim.kind === "symbol");

  if (absent && absent.length > 0) {
    stream.markdown(
      `⚠️ Your request names ${absent
        .map((result) => `\`${result.claim.text}\``)
        .join(
          ", "
        )}, which ${absent.length === 1 ? "is" : "are"} not in this workspace. ` +
        "If you meant something that already exists, the name may be wrong, or an earlier answer may have invented it. " +
        "If you are asking for it to be created, this is expected.\n\n"
    );
  }

  const indexing = new IndexingService();
  // Wider than the plan will use: these are candidates to choose from, and
  // retrieval is local and cheap. Narrowing happens in the selection step,
  // where a reason can be given for each file.
  const response = await indexing
    .search({ startPath: workspaceRoot, query: prompt, limit: PLAN_CANDIDATE_LIMIT })
    .catch(() => undefined);
  const results = response?.results ?? [];

  if (results.length === 0) {
    stream.markdown(
      `I could not find anything in this repo matching that request, so I will not guess at a plan.\n\n${await buildReceipts(workspaceRoot)}`
    );
    return;
  }

  stream.progress?.("Working out which of them have to change…");
  const { selection, selectedByModel } = await selectPlanChanges(
    vscode,
    indexing,
    workspaceRoot,
    prompt,
    results,
    token
  );

  if (selection.length === 0) {
    stream.markdown(
      `I found ${results.length} related file(s) but could not judge which of them need changing, so I will not guess at a plan.\n\n${await buildReceipts(workspaceRoot)}`
    );
    return;
  }

  const anchors = new Map(
    results.map((result) => [
      path.relative(workspaceRoot, result.filePath),
      result.anchor?.line
    ])
  );

  const addPaths = new Set(
    selection
      .filter((choice) => choice.kind === "add")
      .map((choice) => choice.relativePath)
  );
  const outlines =
    addPaths.size > 0
      ? await requestAddOutlines(
          vscode,
          indexing,
          workspaceRoot,
          prompt,
          selection,
          token
        )
      : new Map<string, PlannedOutline>();

  stream.progress?.("Working out what the change actually does…");
  const approach = await requestPlanApproach(
    vscode,
    prompt,
    selection,
    outlines,
    token
  );

  // Snapshots are read from disk by buildPlannedChange — never written by the
  // model, which paraphrases existing code and corrupts the patch.
  const changes: PlannedChange[] = [];
  for (const choice of selection) {
    const intent = approach?.intents.get(choice.relativePath);
    changes.push(
      await buildPlannedChange({
        repoRoot: workspaceRoot,
        relativePath: choice.relativePath,
        kind: choice.kind,
        rationale: choice.rationale,
        anchorLine: anchors.get(choice.relativePath),
        ...(intent && intent.length > 0 ? { intent } : {}),
        ...(outlines.has(choice.relativePath)
          ? { outline: outlines.get(choice.relativePath) }
          : {})
      })
    );
  }

  const version = session.plans.length + 1;
  const plan = createPlanContract({
    request: prompt,
    version,
    decisions: sessions.activeDecisions(session),
    changes,
    ...(approach && approach.summary.length > 0 ? { approach: approach.summary } : {}),
    // What the plan commits to running afterwards, taken from what the repo
    // already has. Approving a plan should mean agreeing to the checks too.
    validation: planValidationCommands(
      await readJsonSafe<unknown>(
        path.join(workspaceRoot, ".copilot-architect", "repo-map.json")
      )
    )
  });
  const withDraft = await sessions.addPlanVersion({ workspaceRoot }, { ...plan });

  stream.markdown(`## Plan v${version} — draft\n\n**${prompt}**\n`);
  stream.markdown(renderDecisions(sessions, withDraft));

  // What the change is, before which files it lands in. A plan that opens on
  // a file list asks the developer to reconstruct the intent from the paths,
  // which is exactly the guessing this tool exists to remove.
  if (approach === undefined) {
    stream.markdown(
      "\n_No language model was available, so this draft says which files are involved and what is in them today — not what the change would do. That is a file list, not a plan: read it as one._\n"
    );
  } else if (approach.summary.length > 0) {
    stream.markdown("\n**What this does**\n");
    for (const line of approach.summary) {
      stream.markdown(`- ${line}\n`);
    }
  } else {
    stream.markdown(
      "\n_The model named no overall approach for this change. The per-file steps below are all there is._\n"
    );
  }

  stream.markdown("\n**Files this would touch**\n");
  const verdicts = new Map(selection.map((choice) => [choice.relativePath, choice]));

  for (const change of changes) {
    const quoted =
      change.kind === "add"
        ? "new file"
        : change.before
          ? `lines ${change.before.startLine}–${change.before.endLine} of ${change.before.fileLines}`
          : "no snapshot — file could not be read";
    // A reason that did not check out is marked, not hidden and not dropped:
    // it may still be the right file, and the developer decides.
    const verdict = verdicts.get(change.relativePath);
    const flag = verdict?.evidence === "unverified" ? " ⚠️" : "";

    stream.markdown(
      `- **${change.kind}** \`${change.relativePath}\` — ${change.rationale}${flag} _(${quoted})_\n`
    );

    // What will be done to this file, next to the file. The rationale above
    // says why it is in scope; without this the developer has no statement of
    // the change at all, only the code it would be made to.
    if (change.intent && change.intent.length > 0) {
      for (const step of change.intent) {
        stream.markdown(`  - ↳ ${step}\n`);
      }
    } else if (approach !== undefined && change.kind !== "delete") {
      // Said, not hidden: a file with no step is one the plan chose and then
      // did not say what to do with, and approving it is approving a guess.
      stream.markdown(
        "  - ↳ _no step given for this file — the plan does not say what changes here_\n"
      );
    }

    if (change.kind === "add") {
      const outline = renderOutline(change.outline);
      // A new file with no outline is a sentence the developer is being asked
      // to approve. Saying so is the difference between an admitted gap and a
      // hidden one.
      stream.markdown(
        outline
          ? `  ↳ ${outline}\n`
          : "  ↳ _no outline — you would be approving this description alone_\n"
      );
      continue;
    }

    // The code as it stands, shown rather than described. The plan has
    // carried this excerpt since it was built — it is what implementation
    // will work from — and until now the draft only said how many lines it
    // covered. Approving a file list is not the same as approving a change
    // to code you have read.
    //
    // It also makes the excerpt window visible: if the lines that actually
    // need changing are outside it, that is something to see now rather than
    // discover when the edit cannot be produced.
    if (change.before) {
      stream.markdown(
        `\n\`\`\`${languageHint(change.relativePath)}\n${change.before.text}\n\`\`\`\n`
      );
      stream.button?.({
        command: OPEN_FILE_COMMAND,
        title: `Open ${truncate(change.relativePath, 40)}`,
        arguments: [change.relativePath]
      });
    } else {
      stream.markdown(
        "\n  ↳ _no snapshot — this file could not be read, so implementation would have nothing to work from_\n"
      );
    }
  }

  stream.markdown(
    "\n_The steps are what this plan intends; the code blocks are the files as they stand today. The code that replaces them is written at `/implement`, where every change is diffed against your files before anything lands._\n"
  );

  const unverified = selection.filter((choice) => choice.evidence === "unverified");
  if (unverified.length > 0) {
    const rows = unverified
      .map((choice) => `\`${choice.relativePath}\` (${choice.evidenceReason})`)
      .join(", ");
    stream.markdown(
      `\n⚠️ The reason given for ${rows} does not check out against the index. The file may still be right — the explanation is not.\n`
    );
  }

  if (!selectedByModel) {
    // The fallback is a worse plan and is not presented as a considered one.
    stream.markdown(
      `\n_These are the top ${changes.length} search matches, not a judged selection: no language model was available to work out which files actually need changing. Expect files here that do not need editing, and files missing that do._\n`
    );
  }
  stream.progress?.("Looking for choices worth confirming…");
  const recorded = sessions.activeDecisions(withDraft);
  const proposals = await proposeDecisions(vscode, prompt, changes, recorded, token);
  renderProposedDecisions(proposals, recorded, stream);

  if (plan.validation.length > 0) {
    stream.markdown(
      `\n**Checks this plan commits to** — ${plan.validation.map((entry) => `\`${entry.command}\``).join(", ")}\n`
    );
  } else {
    // Stated, because a plan that quietly commits to nothing looks the same
    // as one whose checks all passed.
    stream.markdown(
      "\n_No test or lint command was detected, so this plan commits to no automated check. Run `analyze` first if that looks wrong._\n"
    );
  }

  stream.markdown(`\n${await buildReceipts(workspaceRoot)}\n`);
  stream.markdown(
    "\nThis is a draft. Nothing is written until you approve it — tell me what to change, or:\n"
  );
  stream.button?.({
    command: APPROVE_PLAN_COMMAND,
    title: `Approve plan v${version}`,
    arguments: [version]
  });
}

/**
 * Renders proposals as buttons, one per decision.
 *
 * Confirming is a click; rejecting is not clicking; amending is saying what is
 * wrong, which lands in the next draft. Only the first has a button, because
 * only the first writes anything.
 */
function renderProposedDecisions(
  proposals: ProposedDecision[] | undefined,
  recorded: Decision[],
  stream: ChatResponseStreamLike
): void {
  if (proposals === undefined) {
    // Not the same as "no choices worth confirming", and not shown as if it
    // were: no model was reachable, so nothing was even asked.
    stream.markdown(
      "\n**Decisions to confirm** — none proposed: no language model was available to ask.\n"
    );
    return;
  }

  if (proposals.length === 0) {
    return;
  }

  stream.markdown(
    "\n**Decisions to confirm** — these shape the plan. Confirm the ones you agree with; say so if any are wrong.\n"
  );

  for (const proposal of proposals) {
    const rejected = proposal.rejected ? ` _(over ${proposal.rejected})_` : "";
    stream.markdown(`\n- **${proposal.kind}** — ${proposal.statement}${rejected}\n`);

    // Named, not just referenced by id. "Replaces d2" tells the developer
    // nothing they can check; replacing the wrong decision silently would be
    // worse than the contradiction this exists to fix.
    const replaced = proposal.replaces
      ? recorded.find((decision) => decision.id === proposal.replaces)
      : undefined;

    if (replaced) {
      stream.markdown(`  ↳ replaces: _${replaced.statement}_\n`);
    }

    stream.button?.({
      command: CONFIRM_DECISION_COMMAND,
      title: `${replaced ? "Replace with" : "Confirm"}: ${truncate(proposal.statement, 44)}`,
      arguments: [proposal]
    });
  }
}

/**
 * Applies the approved plan.
 *
 * Four gates before anything is written, in order of what they protect:
 * approval (no draft may authorize code), freshness (a file that moved since
 * the plan quoted it must not be patched blind), constraints the developer
 * confirmed, and finally the workspace boundary enforced inside
 * applyPlanChanges. The checkpoint is captured before the first write, so
 * review can tell this feature's changes from everything else in the tree.
 */
async function runImplementPhase(
  vscode: VscodeApiLike,
  sessions: SessionService,
  workspaceRoot: string,
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<void> {
  const session = await sessions.current({ workspaceRoot });

  if (!session) {
    stream.markdown("No active session. Start with `/create-plan <what you want>`.");
    return;
  }

  const approved = sessions.latestApprovedPlan(session);
  if (!approved) {
    stream.markdown(
      "No approved plan. A draft is not authorization to write code — approve one first."
    );
    return;
  }

  const plan = approved.content as unknown as PlanContract;
  await sessions.setPhase({ workspaceRoot }, "implement");

  stream.progress?.("Checking the plan still fits the code…");
  const freshness = await verifyPlanFreshness(plan, workspaceRoot);
  if (!freshness.ok) {
    stream.markdown("**Stopping — the code moved since this plan was written.**\n\n");
    if (freshness.drifted.length > 0) {
      stream.markdown(`Changed since planning: ${list(freshness.drifted)}\n`);
    }
    if (freshness.missing.length > 0) {
      stream.markdown(`No longer present: ${list(freshness.missing)}\n`);
    }
    stream.markdown(
      "\nPatching these against a stale snapshot would corrupt them. Re-plan with `/create-plan`.\n"
    );
    return;
  }

  const constraints = checkConstraints(
    sessions.activeDecisions(session),
    plannedPaths(plan)
  );
  if (constraints.violations.length > 0) {
    stream.markdown("**Stopping — this plan breaks a constraint you set.**\n\n");
    for (const violation of constraints.violations) {
      stream.markdown(
        `- ${violation.statement} — would touch ${list(violation.paths)}\n`
      );
    }
    return;
  }

  // Before the first write, so review has a baseline.
  await sessions.captureCheckpoint(
    { workspaceRoot },
    await new IndexingService().fileHashes({ startPath: workspaceRoot })
  );

  stream.progress?.("Writing the changes…");
  const changes: ApplyChangeInput[] = [];
  const editRefusals = new Map<string, string>();

  for (const change of plan.changes) {
    if (change.kind === "delete") {
      changes.push({ relativePath: change.relativePath, kind: "delete" });
      continue;
    }

    if (change.kind === "add") {
      const afterText = await requestLmText(
        vscode,
        [
          renderRolePrompt("implement"),
          "",
          `Write this file to satisfy: ${plan.request}`,
          `Reason this file is in scope: ${change.rationale}`,
          // What the developer approved this file as, not just why it is
          // here. Implementation that does not receive the approved steps is
          // free to build something else and call it the plan.
          ...renderApprovedSteps(change),
          "",
          "Return ONLY the complete file contents. No explanation, no fences.",
          "",
          describeNewFile(change)
        ].join("\n"),
        token
      );

      changes.push({
        relativePath: change.relativePath,
        kind: "add",
        // Refused by applyPlanChanges rather than written as an empty file.
        ...(afterText?.trim() ? { afterText: unfence(afterText) } : {})
      });
      continue;
    }

    const edited = await editExistingFile(vscode, plan, change, workspaceRoot, token);

    if (edited.reason) {
      editRefusals.set(change.relativePath, edited.reason);
    }

    changes.push({
      relativePath: change.relativePath,
      kind: "update",
      ...(edited.text !== undefined ? { afterText: edited.text } : {})
    });
  }

  // Staged rather than written. Approving a plan authorized the change it
  // described — a file list, reasons, an outline. What comes back from the
  // model is code nobody has seen, and this is the one moment where showing
  // it costs nothing: it is already generated.
  stagedWrites.set(workspaceRoot, {
    plan,
    version: approved.version,
    changes,
    unenforceable: constraints.unenforceable
  });

  const previews = previewWrites(plan, changes);
  stream.markdown(`## Plan v${approved.version} — ready to write\n\n`);

  // One line and one button per file rather than a summary then a wall of
  // buttons: the action belongs next to the thing it acts on.
  for (const preview of previews) {
    stream.markdown(`${summarizeWrites([preview])}\n`);

    const refusal = editRefusals.get(preview.relativePath);
    if (refusal) {
      // Named precisely rather than reported as a generic failure: which edit
      // did not apply, and why, is the difference between a developer who can
      // correct the plan and one who can only re-run it and hope.
      stream.markdown(`  ↳ _not edited: ${refusal}_\n`);
      continue;
    }

    stream.button?.({
      command: SHOW_DIFF_COMMAND,
      title: `Show diff: ${truncate(preview.relativePath, 44)}`,
      arguments: [preview.relativePath]
    });
  }

  if (previews.some((preview) => preview.suspectTruncation)) {
    stream.markdown(
      "\n⚠️ A replacement much shorter than the file it replaces is usually an answer that stopped early, not an edit. Open that diff before applying.\n"
    );
  }

  stream.markdown("\nNothing has been written yet.\n");
  stream.button?.({
    command: APPLY_CHANGES_COMMAND,
    title: `Apply ${changes.length} change(s)`,
    arguments: [approved.version]
  });
}

/**
 * What the apply produced, for the caller to surface.
 *
 * Returned rather than only streamed: the chat turn that staged these is
 * over, so everything written to a stream at this point lands in the output
 * channel — a panel the developer has no reason to be looking at. Clicking
 * Apply and seeing the chat unchanged is indistinguishable from clicking a
 * button that does nothing.
 */
export interface ApplyOutcome {
  written: string[];
  deleted: string[];
  refused: number;
  /** Set when nothing was applied, with the reason a developer can act on. */
  blocked?: string;
  /** Checks the approved plan committed to, if any. */
  validationCommands: number;
}

/**
 * Writes the changes staged by `/implement`.
 *
 * Separate from generating them so the developer sees what an approved plan
 * turned into before it reaches their working tree. Not a second approval of
 * the same decision — the plan was approved, and this is the code that plan
 * became.
 */
async function applyStagedWrites(
  vscode: VscodeApiLike,
  sessions: SessionService,
  workspaceRoot: string,
  version: number,
  stream: ChatResponseStreamLike
): Promise<ApplyOutcome> {
  const staged = stagedWrites.get(workspaceRoot);

  if (!staged || staged.version !== version) {
    // Staged in memory, so a reload loses it. Saying so beats writing
    // something the developer can no longer see the preview for.
    const blocked =
      "Those changes are no longer staged — the window was reloaded, or a newer plan replaced them. Run `/implement` again to regenerate and preview.";
    stream.markdown(`${blocked}\n`);
    return { written: [], deleted: [], refused: 0, blocked, validationCommands: 0 };
  }

  // Re-checked here, not only before generating. Between the preview and
  // this click the developer may have edited one of these files themselves —
  // and the staged content is a *complete* replacement computed from the
  // version they had before, so writing it would silently destroy their work.
  const { plan } = staged;
  const freshness = await verifyPlanFreshness(plan, workspaceRoot);

  if (!freshness.ok) {
    const moved = [...freshness.drifted, ...freshness.missing];
    const blocked = `Nothing written — ${moved.join(", ")} changed since the preview was built. Applying now would overwrite it.`;
    stream.markdown(
      `**Nothing written — ${list(moved)} changed since the preview was built.**\n\n` +
        "Applying now would overwrite whatever changed. Run `/implement` again to regenerate against the current files.\n"
    );
    return { written: [], deleted: [], refused: 0, blocked, validationCommands: 0 };
  }

  stagedWrites.delete(workspaceRoot);
  const { changes, unenforceable } = staged;
  const applied = await applyPlanChanges({ workspaceRoot, changes });

  if (applied.written.length > 0 || applied.deleted.length > 0) {
    await sessions.markImplemented({ workspaceRoot }, version);

    // The file index refreshes itself on read; the call graph cannot, and a
    // full re-parse has no incremental path. This used to be a line of
    // markdown asking three agents to remember — now it simply happens.
    stream.progress?.("Rebuilding the call graph…");
    // Through the CLI rather than by import: building the graph needs the
    // TypeScript compiler, which is 9.5 MB and would be carried by every
    // extension activation for a step that runs once per implementation. Still
    // a function call in code, not a line of markdown asking a model to
    // remember.
    const graphRun = await rebuildSymbolGraph(workspaceRoot);
    if (!graphRun) {
      stream.markdown(
        "_The call graph could not be rebuilt; later searches may cite stale call edges._\n\n"
      );
    }
  }

  stream.markdown(`## Implemented plan v${version}\n\n`);
  if (applied.written.length > 0) {
    stream.markdown(`**Written** — ${list(applied.written)}\n\n`);
  }
  if (applied.deleted.length > 0) {
    stream.markdown(`**Deleted** — ${list(applied.deleted)}\n\n`);
  }
  if (applied.refused.length > 0) {
    stream.markdown("**Not applied**\n");
    for (const refused of applied.refused) {
      stream.markdown(`- \`${refused.relativePath}\` — ${refused.reason}\n`);
    }
    stream.markdown("\n");
  }
  if (unenforceable.length > 0) {
    // Honest degradation: not verified is not the same as honoured.
    stream.markdown(
      `_${unenforceable.length} constraint(s) could not be checked automatically: ` +
        `${unenforceable.map((c) => c.statement).join("; ")}._\n\n`
    );
  }

  await reportOutlineDivergence(plan, workspaceRoot, applied.written, stream);

  const outcome: ApplyOutcome = {
    written: applied.written,
    deleted: applied.deleted,
    refused: applied.refused.length,
    validationCommands: applied.written.length > 0 ? plan.validation.length : 0
  };

  if (plan.validation.length > 0 && applied.written.length > 0) {
    // A button, not automatic. The plan named these checks and the developer
    // approved the plan — but approving a plan that mentions a command is not
    // agreeing to execute it this second, and validation runs real repo
    // commands.
    // Named here for the record; offered as a notification action by the
    // caller, because a chat button cannot be rendered outside a chat turn
    // and this one was being dropped in silence.
    stream.markdown(
      `This plan committed to ${plan.validation.map((entry) => `\`${entry.command}\``).join(", ")}.\n`
    );
  }

  stream.markdown("\nRun `/review` to compare this against the approved plan.\n");

  return outcome;
}

/**
 * Compares what changed against what was approved.
 *
 * Reads the checkpoint rather than git, so it works in a workspace with no
 * repository — and says plainly what it cannot see rather than presenting a
 * partial review as a complete one.
 */
async function runReviewPhase(
  vscode: VscodeApiLike,
  sessions: SessionService,
  workspaceRoot: string,
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<void> {
  const session = await sessions.current({ workspaceRoot });

  if (!session) {
    stream.markdown("No active session to review.");
    return;
  }

  await sessions.setPhase({ workspaceRoot }, "review");

  const approved = sessions.latestApprovedPlan(session);
  if (!session.checkpoint || !approved) {
    stream.markdown(
      "Nothing to review yet — a checkpoint is captured when `/implement` runs, " +
        "and there must be an approved plan to compare against."
    );
    return;
  }

  stream.progress?.("Comparing against the approved plan…");
  const diff = diffCheckpoint(
    session.checkpoint,
    await new IndexingService().fileHashes({ startPath: workspaceRoot })
  );
  const plan = approved.content as unknown as PlanContract;
  const comparison = compareAgainstPlan(plan, diff);

  stream.markdown(`## Review against plan v${approved.version}\n\n`);

  if (comparison.asPlanned.length > 0) {
    stream.markdown(`**Changed as planned** — ${list(comparison.asPlanned)}\n\n`);
  }
  if (comparison.untouched.length > 0) {
    stream.markdown(
      `**Planned but unchanged** — ${list(comparison.untouched)}\n` +
        "_The work may be incomplete._\n\n"
    );
  }
  if (comparison.unplanned.length > 0) {
    stream.markdown(
      `**Changed but not in the plan** — ${list(comparison.unplanned)}\n` +
        "_Was that deliberate? This is the part a review reading only the plan would miss._\n\n"
    );
  }
  if (comparison.deleted.length > 0) {
    stream.markdown(`**Deleted** — ${list(comparison.deleted)}\n\n`);
  }
  if (
    comparison.asPlanned.length === 0 &&
    comparison.unplanned.length === 0 &&
    comparison.deleted.length === 0
  ) {
    stream.markdown("Nothing has changed since the checkpoint.\n\n");
  }

  const unplannedWithoutSnapshot = comparison.unplanned.length;
  if (unplannedWithoutSnapshot > 0) {
    stream.markdown(
      `_I can tell you those ${unplannedWithoutSnapshot} file(s) changed but not what changed inside them: ` +
        "only files the plan quoted carry a before-snapshot._\n\n"
    );
  }

  await reportReviewFindings(vscode, plan, workspaceRoot, stream, token);

  stream.markdown(await buildReceipts(workspaceRoot));
  stream.button?.({ command: END_SESSION_COMMAND, title: "End session" });
}

/**
 * The half of review that looks at the code rather than the file list.
 *
 * Comparing paths against the plan says what moved. It does not say whether
 * what landed is any good — missing tests, a touched security-sensitive file,
 * a dependency change, a validation failure. `ReviewService` already detects
 * all of those and was, until now, reachable only from the CLI: the chat
 * phase that calls itself review made no model call and read no diff.
 */
async function reportReviewFindings(
  vscode: VscodeApiLike,
  plan: PlanContract,
  workspaceRoot: string,
  stream: ChatResponseStreamLike,
  token: unknown
): Promise<void> {
  stream.progress?.("Looking at what changed…");

  const result = await new ReviewService()
    .review({
      startPath: workspaceRoot,
      // From the contract, not a FeaturePlan on disk: without them every
      // changed file would be reported as unexpected.
      expectedFiles: plannedPaths(plan)
    })
    .catch(() => undefined);

  if (!result) {
    stream.markdown(
      "_No findings: the diff could not be read, so nothing was inspected. This is not a clean review._\n\n"
    );
    return;
  }

  const open = result.report.findings.filter((finding) => finding.status === "open");

  if (open.length > 0) {
    stream.markdown("**Findings**\n");
    for (const finding of open) {
      const where = finding.filePath
        ? ` — \`${finding.filePath}${finding.line ? `:${finding.line}` : ""}\``
        : "";
      stream.markdown(`- **${finding.severity}** ${finding.title}${where}\n`);
    }
    stream.markdown("\n");
  }

  stream.markdown(`_Report: ${path.relative(workspaceRoot, result.markdownPath)}_\n\n`);

  // The role prompt exists and, until now, nothing sent it: /review made no
  // model call at all, so it could never give a line, a severity or a
  // remediation the way the role says it must.
  const assessment = await requestLmText(
    vscode,
    [
      renderRolePrompt("review"),
      "",
      `The developer asked for: ${plan.request}`,
      "",
      ...(plan.approach && plan.approach.length > 0
        ? [
            "What the approved plan set out to do:",
            ...plan.approach.map((line) => `- ${line}`),
            ""
          ]
        : []),
      // The approved steps, not only the file list. "Was this built as
      // approved" is the question /review exists to answer, and it cannot be
      // asked against a list of paths.
      "The plan approved these files:",
      ...plan.changes.flatMap((change) => [
        `- ${change.kind} ${change.relativePath} — ${change.rationale}`,
        ...(change.intent ?? []).map((step) => `    - approved step: ${step}`)
      ]),
      "",
      ...(open.length > 0
        ? [
            "Automated checks raised these:",
            ...open.map(
              (finding) => `- ${finding.severity}: ${finding.title} ${finding.details}`
            ),
            ""
          ]
        : ["Automated checks raised nothing.", ""]),
      "Diff summary:",
      result.report.diffSummary ?? "(none)",
      "",
      "Say what blocks a merge and what is worth a follow-up. Be specific about",
      "the file. Say what you could not inspect rather than implying you read",
      "everything — you were given a summary, not the full diff."
    ].join("\n"),
    token
  );

  if (assessment === undefined) {
    stream.markdown(
      "_No language model was available, so the findings above are the automated checks only — nothing read the change itself._\n\n"
    );
    return;
  }

  stream.markdown(`${assessment.trim()}\n\n`);
}

/** Counts by outcome, for a one-line result the developer can act on. */
function summarizeValidation(result: { report: { results?: { status?: string }[] } }): {
  passed: number;
  failed: number;
  blocked: number;
  timedOut: number;
} {
  const results = result.report.results ?? [];
  const count = (status: string) =>
    results.filter((entry) => entry.status === status).length;

  return {
    passed: count("passed"),
    failed: count("failed"),
    blocked: count("blocked"),
    timedOut: count("timed-out")
  };
}

/**
 * The fence language for a path, so a quoted excerpt is highlighted rather
 * than shown as plain text. Unknown extensions get no hint, which renders as
 * a plain block instead of the wrong colours.
 */
export function languageHint(relativePath: string): string {
  const byExtension: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".java": "java",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".cs": "csharp",
    ".kt": "kotlin",
    ".php": "php",
    ".sql": "sql",
    ".sh": "bash",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".md": "markdown"
  };

  return byExtension[path.extname(relativePath).toLowerCase()] ?? "";
}

function list(paths: string[]): string {
  return paths.map((item) => `\`${item}\``).join(", ");
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

interface RepoMapEntry {
  name?: string;
  displayName?: string;
  languages?: Array<{ name: string }>;
  frameworks?: Array<{ name: string }>;
  entryPoints?: Array<{ filePath: string }>;
  commands?: { test?: Array<{ command: string }> };
}

/**
 * Why a context came back empty, in terms the user can act on. Distinguishes
 * "never indexed" (a setup step is missing) from "indexed but nothing matched"
 * (the question found nothing) — collapsing those two is what made a missing
 * index look like an empty repository.
 */
export async function diagnoseEmptyContext(workspaceRoot: string): Promise<string> {
  const registered = await getRegisteredRepoRoots(workspaceRoot);
  const repoRoots = registered.length > 0 ? registered : [workspaceRoot];
  const indexed: string[] = [];
  const missing: string[] = [];

  for (const repoRoot of repoRoots) {
    try {
      await readFile(
        path.join(repoRoot, ".copilot-architect", "index", "index.json"),
        "utf8"
      );
      indexed.push(path.basename(repoRoot));
    } catch {
      missing.push(path.basename(repoRoot));
    }
  }

  if (indexed.length === 0) {
    const scope =
      registered.length > 0
        ? `none of the ${repoRoots.length} registered repos (${missing.join(", ")}) has an index`
        : "this workspace has no index";
    return `No searchable index — ${scope}. Run **Setup Repo** from the Copilot Architect dashboard first.`;
  }

  const unindexed =
    missing.length > 0
      ? ` Note that ${missing.length} registered repo(s) are still unindexed: ${missing.join(", ")}.`
      : "";
  return `Searched ${indexed.length} indexed repo(s) and nothing matched this question.${unindexed}`;
}

/**
 * Whether a workspace-wide symbol graph is worth building this run.
 *
 * It is, unless a previous build already established that these exact repos
 * share no code — a graph over them would find nothing to connect, and on a
 * large workspace that is a full extra parse of every file for no gain.
 *
 * Rebuilds whenever the registered repo set changes, since a new repo can
 * introduce the first shared dependency. A cross-repo dependency added to an
 * UNCHANGED set of repos is the gap in this heuristic: deleting
 * graph-workspace.json forces the rebuild that picks it up.
 */
export async function shouldBuildWorkspaceGraph(
  workspaceRoot: string,
  repoNames: string[]
): Promise<boolean> {
  let state: { repos?: string[]; crossRepoEdgeCount?: number };

  try {
    state = JSON.parse(
      await readFile(
        path.join(workspaceRoot, ".copilot-architect", "graph-workspace.json"),
        "utf8"
      )
    );
  } catch {
    // Never built, or the marker was deleted to force a rebuild.
    return true;
  }

  if (state.crossRepoEdgeCount !== 0) return true;

  const learned = [...(state.repos ?? [])].sort();
  const current = [...repoNames].sort();
  return learned.length !== current.length
    ? true
    : learned.some((name, position) => name !== current[position]);
}

interface RepoContextResult {
  contextText: string;
  /** Top-ranked files with symbol anchor lines for targeted excerpt extraction. */
  fileAnchors: FileAnchor[];
}

// ─── Claude-inspired retrieval mechanisms ────────────────────────────────────

/**
 * Repo facts plus the files most relevant to a request.
 *
 * Retrieval is delegated to `IndexingService`, the same path the MCP tools and
 * CLI use. It used to be re-implemented here — its own tokenizer, its own RRF,
 * query expansion and embedding reranking — which meant `@architect` and the
 * agents could give different answers to the same question and neither was
 * wrong. One engine is the fix; the shell asks, it does not rank.
 */
export async function buildRepoContext(
  workspaceRoot: string,
  request?: string
): Promise<RepoContextResult> {
  const lines: string[] = [];
  let fileAnchors: FileAnchor[] = [];

  try {
    const mapPath = path.join(workspaceRoot, ".copilot-architect", "repo-map.json");
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const repos = (map.repos as RepoMapEntry[]) ?? [];
    // Every repo, not just repos[0]: on a multi-repo workspace describing only
    // the first one told the model the other repos did not exist.
    const multi = repos.length > 1;

    for (const repo of repos) {
      const label = multi ? `${repo.displayName ?? repo.name ?? "repo"}: ` : "";
      const langs = repo.languages?.map((l) => l.name).join(", ");
      const fws = repo.frameworks?.map((f) => f.name).join(", ");
      const testCmd = repo.commands?.test?.[0]?.command;
      const entry = repo.entryPoints?.[0]?.filePath;
      if (langs) lines.push(`${label}Languages: ${langs}`);
      if (fws) lines.push(`${label}Frameworks: ${fws}`);
      if (entry) lines.push(`${label}Entry point: ${entry}`);
      if (testCmd) lines.push(`${label}Test command: ${testCmd}`);
    }
  } catch {
    /* no repo-map yet */
  }

  if (!request?.trim()) {
    return { contextText: lines.join("\n"), fileAnchors };
  }

  const response = await new IndexingService()
    .search({ startPath: workspaceRoot, query: request, limit: 25 })
    // A failed search must not take the repo facts down with it.
    .catch(() => undefined);
  const results = response?.results ?? [];

  // Paths relative to the WORKSPACE root, since that is what
  // readFilesForLmContext resolves against. Derived from the absolute path so a
  // repo registered outside the workspace (`../billing-service`) still opens.
  const relativeToWorkspace = (filePath: string): string =>
    path.relative(workspaceRoot, filePath);

  fileAnchors = results.slice(0, 8).map((result) => ({
    relativePath: relativeToWorkspace(result.filePath),
    anchorLine: result.anchor?.line
  }));

  if (results.length > 0) {
    lines.push("\nSource files:");
    for (const result of results) {
      const symbols = result.symbols
        .slice(0, 6)
        .map((symbol) => symbol.name)
        .join(", ");
      const hint = result.anchor?.line ? `:${result.anchor.line}` : "";
      lines.push(
        `- ${relativeToWorkspace(result.filePath)}${hint}${symbols ? ` [${symbols}]` : ""}`
      );
    }

    lines.push("\nExisting code (index previews):");
    let totalChars = 0;
    for (const result of results.slice(0, 5)) {
      if (totalChars >= 6_000) break;
      const preview = result.textPreview.slice(0, 2_000);
      if (!preview) continue;
      lines.push(`\n--- ${relativeToWorkspace(result.filePath)} ---`);
      lines.push(preview);
      totalChars += preview.length;
    }
  }

  return { contextText: lines.join("\n"), fileAnchors };
}

export function buildCommandLmPrompt(
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
        // The role was computed and dropped here for every /analyze answer.
        // Phase 5 replaced the .agent.md files with roles invoked by code, on
        // the argument that a role invoked by code cannot skip its steps —
        // and then this branch skipped it.
        body,
        "",
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

/**
 * Asks the model for text and returns it, rather than streaming it to chat.
 *
 * Implementation needs the replacement code in hand so it can be checked and
 * written; showing it to the user is a separate decision.
 */
/**
 * Reads decision proposals out of a model response.
 *
 * Deliberately strict. A malformed line is dropped rather than guessed at:
 * a proposal that becomes a recorded decision on one click must be something
 * the model actually said, not something this parser reconstructed.
 */
export function parseProposedDecisions(text: string): ProposedDecision[] {
  const proposals: ProposedDecision[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed) continue;

    // kind | statement | optional rejected alternative | optional id replaced
    const parts = trimmed.split("|").map((part) => part.trim());
    if (parts.length < 2) continue;

    const kind = parts[0].toLowerCase() as DecisionKind;
    if (!DECISION_KINDS.includes(kind)) continue;

    const statement = parts[1];
    // A one-word "decision" is noise, and a whole paragraph is not a decision.
    if (statement.length < 8 || statement.length > 300) continue;

    const key = `${kind}:${statement.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rejected = parts[2];
    // Only an id in the shape the session actually mints. Anything else is
    // the model narrating, and would name a decision that does not exist.
    const replaces = parts[3] && DECISION_ID.test(parts[3]) ? parts[3] : undefined;

    proposals.push({
      kind,
      statement,
      ...(rejected && rejected.length > 1 && rejected.length <= 300
        ? { rejected }
        : {}),
      ...(replaces ? { replaces } : {})
    });

    if (proposals.length === MAX_PROPOSED_DECISIONS) break;
  }

  return proposals;
}

/**
 * Turns search candidates into a judged file selection.
 *
 * Search answers "what is related"; a plan needs "what has to change". A test
 * that mentions the term and a README describing the feature both rank
 * highly and need no edit, and no amount of ranking will ever surface a file
 * that does not exist yet — which is most of what a new feature needs.
 *
 * `selectedByModel` is false when this fell back to relevance, and the caller
 * says so. A worse plan presented as a considered one is the failure this
 * whole design exists to avoid.
 */
async function selectPlanChanges(
  vscode: VscodeApiLike,
  indexing: IndexingService,
  workspaceRoot: string,
  request: string,
  results: SearchResult[],
  token: unknown
): Promise<{ selection: VerifiedChange[]; selectedByModel: boolean }> {
  const candidates = results.map((result) =>
    path.relative(workspaceRoot, result.filePath)
  );
  const signalsFor = new Map(
    results.map((result) => [
      path.relative(workspaceRoot, result.filePath),
      result.signals
    ])
  );
  // The fallback has no cited symbol to check, which is reported as unchecked
  // rather than passed off as verified.
  const fallback = () => ({
    selection: verifySelectedChanges(
      selectByRelevance(candidates, (file) => signalsFor.get(file) ?? []),
      new Map<string, Set<string>>()
    ),
    selectedByModel: false
  });

  const inventory = await indexing
    .listFiles({ startPath: workspaceRoot, limit: Number.MAX_SAFE_INTEGER })
    .catch(() => undefined);

  // Without the inventory there is no way to tell an invented path from a
  // real one, and an `add` from an `update`. Relevance is the honest answer.
  if (!inventory || inventory.totalFiles === 0) {
    return fallback();
  }

  const indexedPaths = new Set(
    inventory.files.map((file) =>
      file.repoName ? `${file.repoName}/${file.relativePath}` : file.relativePath
    )
  );

  const listing = results
    .map((result, index) => {
      const file = candidates[index];
      const tags = [
        result.isTestFile ? "test" : "",
        result.isConfigFile ? "config" : "",
        result.isDocFile ? "docs" : ""
      ].filter(Boolean);
      const symbols = result.symbols
        .slice(0, 4)
        .map((symbol) => symbol.name)
        .join(", ");
      return [
        file,
        tags.length > 0 ? ` [${tags.join(", ")}]` : "",
        symbols ? ` — declares ${symbols}` : ""
      ].join("");
    })
    .join("\n");

  const text = await requestLmText(
    vscode,
    [
      "A developer asked for this change:",
      request,
      "",
      "A search of their repository found these related files:",
      listing,
      "",
      "Decide which files actually have to change, and how. Being related is",
      "not a reason to change: leave out a test, doc or config that merely",
      "mentions the subject. Include a new file where the feature needs one.",
      "",
      "One per line, pipe-separated, nothing else — no prose, no numbering:",
      "kind | repo-relative path | why this file changes | a symbol in that file",
      "",
      "kind is one of: add, update, delete",
      "Use a path from the list above for update and delete.",
      "For add, give the path the new file should have and leave the symbol empty.",
      "The symbol must be one the file declares — it is checked against the",
      "index, and it is how your reason is shown to be about that file and not",
      "another. Leave it empty rather than guessing.",
      `At most ${DEFAULT_MAX_CHANGES} files.`,
      "",
      "Example:",
      "update | src/billing/InvoiceService.ts | holds the invoice lifecycle this hooks into | InvoiceService",
      "add | src/billing/ApprovalPolicy.ts | new rules deciding who may approve |",
      "",
      "If none of these files need to change, answer with nothing at all."
    ].join("\n"),
    token
  );

  if (text === undefined) {
    return fallback();
  }

  const selection = parseSelectedChanges(text, { candidates, indexedPaths });

  // Nothing survived validation. That is not the same as "nothing needs
  // changing" — it usually means the answer was malformed — so relevance is
  // the honest fallback rather than an empty plan.
  if (selection.length === 0) {
    return fallback();
  }

  const symbolsByFile = await indexing
    .symbolsByFile({ startPath: workspaceRoot })
    .catch(() => new Map<string, Set<string>>());

  return {
    selection: verifySelectedChanges(selection, symbolsByFile),
    selectedByModel: true
  };
}

/**
 * Edits an existing file by quoting what to replace.
 *
 * Reads the file from disk rather than working from the plan's excerpt: the
 * excerpt is a window for the model to reason in, and an edit has to apply to
 * the whole file. Freshness was already checked against the plan's hash
 * before this ran, so what is read here is what the plan quoted.
 *
 * Every failure path leaves the file untouched and says which edit failed and
 * why. Producing a half-edited file, or falling back to rewriting it whole,
 * would both hide exactly the information the developer needs to correct the
 * plan.
 */
async function editExistingFile(
  vscode: VscodeApiLike,
  plan: PlanContract,
  change: PlannedChange,
  workspaceRoot: string,
  token: unknown
): Promise<{ text?: string; reason?: string }> {
  let original: string;
  try {
    original = await readFile(path.join(workspaceRoot, change.relativePath), "utf8");
  } catch {
    return { reason: "the file could not be read" };
  }

  const response = await requestLmText(
    vscode,
    [
      renderRolePrompt("implement"),
      "",
      `Edit this file to satisfy: ${plan.request}`,
      `Reason this file is in scope: ${change.rationale}`,
      ...renderApprovedSteps(change),
      "",
      "Return only search/replace blocks, in this exact form:",
      "",
      "<<<<<<< SEARCH",
      "the existing lines to replace, copied exactly",
      "=======",
      "what they become",
      ">>>>>>> REPLACE",
      "",
      "Rules that decide whether your edit can be applied at all:",
      "- Copy the searched text character for character from the file below.",
      "- Include enough surrounding lines to make it unique in the file. An",
      "  edit matching twice is ambiguous and will be refused.",
      "- One block per change. Leave everything else alone.",
      "- To delete code, leave the replacement side empty.",
      "",
      change.before
        ? `The file (lines ${change.before.startLine}-${change.before.endLine} of ${change.before.fileLines}):\n${change.before.text}`
        : "The file could not be quoted when the plan was built."
    ].join("\n"),
    token
  );

  if (response === undefined) {
    return { reason: "no language model was available" };
  }

  const edits = parseFileEdits(response);

  if (edits.length === 0) {
    return { reason: "no usable edits were produced" };
  }

  const result = applyFileEdits(original, edits);
  const refusal = describeRefusals(result.refused);

  return refusal ? { reason: refusal } : { text: result.text };
}

/**
 * What implementation is told about a file that does not exist yet.
 *
 * The outline was approved, so it is a contract rather than a suggestion: the
 * developer said yes to a file exporting these names, and a file exporting
 * something else is not the file they approved.
 */
function describeNewFile(change: PlannedChange): string {
  if (!change.outline) {
    return "This is a new file. No outline was approved for it, so keep it minimal and focused on the stated reason.";
  }

  const lines = [
    "This is a new file. The developer approved this outline for it — treat it as the contract:",
    "- Must export:",
    ...change.outline.exports.map((entry) => {
      const called = entry.signature ? `, called as ${entry.signature}` : "";
      const why = entry.purpose ? ` — ${entry.purpose}` : "";
      return `  - ${entry.name}${called}${why}`;
    })
  ];

  if (change.outline.dependsOn.length > 0) {
    lines.push(`- Expected to import: ${change.outline.dependsOn.join(", ")}`);
  }

  if (change.outline.estimatedLines !== undefined) {
    lines.push(
      `- Roughly ${change.outline.estimatedLines} lines. Substantially more than that means scope the developer did not approve.`
    );
  }

  return lines.join("\n");
}

/**
 * Tells the developer what the apply did, in the editor.
 *
 * A chat button cannot be offered from here — the turn is over — so the
 * checks the plan committed to are a notification action instead. They were
 * previously offered as `stream.button` on a sink that implements only
 * `markdown`, so the call was silently dropped and validation was
 * unreachable from the normal flow.
 */
export async function reportApplied(
  vscode: VscodeApiLike,
  outcome: ApplyOutcome,
  channel: OutputChannelLike
): Promise<void> {
  const touched = outcome.written.length + outcome.deleted.length;

  if (touched === 0) {
    channel.show?.(true);
    vscode.window.showErrorMessage(
      outcome.refused > 0
        ? `Nothing was written: all ${outcome.refused} change(s) were refused. See the Copilot Architect output for why.`
        : "Nothing was written. See the Copilot Architect output for details."
    );
    return;
  }

  const parts = [`Applied ${touched} change(s)`];
  if (outcome.refused > 0) {
    parts.push(`${outcome.refused} refused`);
  }

  const RUN_CHECKS = "Run checks";
  const DETAILS = "Show details";
  const actions = outcome.validationCommands > 0 ? [RUN_CHECKS, DETAILS] : [DETAILS];

  const choice = await vscode.window.showInformationMessage(
    `${parts.join(", ")}. Run /review to compare against the approved plan.`,
    ...actions
  );

  if (choice === RUN_CHECKS) {
    await vscode.commands.executeCommand?.(RUN_VALIDATION_COMMAND);
  } else if (choice === DETAILS) {
    channel.show?.(true);
  }
}

/**
 * Compares each new file against the outline it was approved under.
 *
 * The outline was a contract, and until this ran it bound by persuasion: the
 * developer approved a file exporting particular names, and nothing checked
 * whether the file that landed exports them. Both halves were already
 * recorded — the plan says what was promised, the index says what was
 * written.
 *
 * Reported, never reverted. The file is on disk and the developer decides
 * what to do about it; silently rewriting what they can see would be a
 * worse surprise than the divergence.
 */
async function reportOutlineDivergence(
  plan: PlanContract,
  workspaceRoot: string,
  written: string[],
  stream: ChatResponseStreamLike
): Promise<void> {
  const hasOutlinedAdd = plan.changes.some(
    (change) =>
      change.kind === "add" && change.outline && written.includes(change.relativePath)
  );

  if (!hasOutlinedAdd) {
    return;
  }

  const symbolsByFile = await new IndexingService()
    .symbolsByFile({ startPath: workspaceRoot })
    .catch(() => undefined);

  if (!symbolsByFile) {
    stream.markdown(
      "_The new files could not be checked against their approved outlines: the index could not be read._\n\n"
    );
    return;
  }

  const checks = checkOutlines(plan, symbolsByFile);
  const summary = summarizeOutlineChecks(checks);

  if (summary) {
    stream.markdown(`${summary}\n\n`);
  }

  // "Could not check" is not "checked and fine", and saying nothing would
  // read as the latter.
  const unchecked = checks.filter((check) => check.status === "not-checked");
  if (unchecked.length > 0) {
    const rows = unchecked
      .map((check) => `\`${check.relativePath}\` (${check.reason})`)
      .join(", ");
    stream.markdown(`_Outline not checked for ${rows}._\n\n`);
  }
}

/**
 * The steps this file's change was approved as, for the implement prompt.
 *
 * Empty when the plan carries none — an older plan, or a draft built with no
 * model available. Implementation then works from the request and the
 * rationale as it always did, rather than being handed an empty heading that
 * reads as "there is nothing to do here".
 */
export function renderApprovedSteps(change: PlannedChange): string[] {
  if (!change.intent || change.intent.length === 0) {
    return [];
  }

  return [
    "",
    "What the developer approved for this file — do this and not more:",
    ...change.intent.map((step) => `- ${step}`)
  ];
}

/**
 * Asks what the plan actually does.
 *
 * Selection answers "which files", and the rationale answers "why this file".
 * Neither answers "what is the change", and a draft made only of those is a
 * file list next to the code as it stands — which is what a developer read
 * before approving the writing of code they had no description of.
 *
 * The code itself is deliberately not asked for here. It is produced at
 * `/implement`, diffed against the real files, and written on a click;
 * generating it twice would double the cost of every redraft and move the
 * expensive step to the side of the gate where nothing has been approved yet.
 *
 * Returns `undefined` when no model was available, which the draft reports
 * rather than presenting a file list as a considered plan.
 */
async function requestPlanApproach(
  vscode: VscodeApiLike,
  request: string,
  selection: VerifiedChange[],
  outlines: Map<string, PlannedOutline>,
  token: unknown
): Promise<ParsedApproach | undefined> {
  const text = await requestLmText(
    vscode,
    [
      "A developer asked for this change:",
      request,
      "",
      "A plan has already chosen the files. For each one:",
      ...selection.map((choice) => {
        const outline = renderOutline(outlines.get(choice.relativePath));
        return `${choice.kind} ${choice.relativePath} — ${choice.rationale}${
          outline ? ` (will contain: ${outline})` : ""
        }`;
      }),
      "",
      "Say what the change does. The developer is about to authorize writing",
      "code and can currently see only which files are involved and what is",
      "in them today — not what it will become.",
      "",
      "Do not write the code. Say what the code will do, concretely enough",
      "to be disagreed with: what gets added, what it is called from, what",
      "is left alone.",
      "",
      "Two record kinds, pipe-separated, nothing else — no prose, no headings.",
      "",
      "approach | one line of what the change does overall",
      "step | path | what changes in that file",
      "",
      "Two to four `approach` lines. One `step` line per distinct edit, using",
      "a path exactly as written above — do not invent files, and do not",
      "describe a file that is not in the list.",
      "",
      "Example:",
      "approach | Hash passwords on write and verify on login, instead of comparing them in plain text.",
      "approach | Existing rows stay readable: verification falls back to the old comparison once, then rewrites the hash.",
      "step | src/users/UserService.java | add hashPassword(String) and verifyPassword(String, String), both delegating to BCrypt",
      "step | src/users/UserService.java | call hashPassword from create(), leaving the rest of the method as it is",
      "step | src/users/LoginResource.java | replace the equals() comparison in authenticate() with verifyPassword"
    ].join("\n"),
    token
  );

  if (text === undefined) {
    return undefined;
  }

  return parsePlanApproach(text, {
    plannedPaths: new Set(selection.map((choice) => choice.relativePath))
  });
}

/**
 * Asks what each new file will contain.
 *
 * An `update` shows the developer real code before they approve it. An `add`
 * has nothing to show, so without this they approve a sentence — "new rules
 * deciding who may approve" could be forty lines or eight hundred, exporting
 * anything at all. The outline is the nearest equivalent to a snapshot for a
 * file that does not exist yet, and it is what implementation is then held to.
 *
 * Returns an empty map when no model was available, which the plan reports as
 * a missing outline rather than passing the add off as fully specified.
 */
async function requestAddOutlines(
  vscode: VscodeApiLike,
  indexing: IndexingService,
  workspaceRoot: string,
  request: string,
  selection: VerifiedChange[],
  token: unknown
): Promise<Map<string, PlannedOutline>> {
  const adds = selection.filter((choice) => choice.kind === "add");

  if (adds.length === 0) {
    return new Map();
  }

  const existing = selection
    .filter((choice) => choice.kind !== "add")
    .map((choice) => choice.relativePath);

  const text = await requestLmText(
    vscode,
    [
      "A developer asked for this change:",
      request,
      "",
      "The plan adds these new files:",
      ...adds.map((add) => `${add.relativePath} — ${add.rationale}`),
      "",
      ...(existing.length > 0
        ? ["It also changes these existing files:", ...existing, ""]
        : []),
      "Say what each new file will contain, so the developer can approve",
      "something concrete rather than a description. They need to be able to",
      "tell a correct implementation from a merely plausible one, so say what",
      "each export takes, returns and is for — not just its name.",
      "",
      "Two record kinds, pipe-separated, nothing else — no prose, no numbering.",
      "One `file` line per new file, then one `export` line per thing it exposes:",
      "",
      "file | path | repo files it imports | rough line count",
      "export | path | name | how it is called | what it is for",
      "",
      "Import only files that already exist in this repository; leave that",
      "field empty rather than guessing at a path.",
      "Give the line count as a number — an honest estimate, not a target.",
      "Keep the signature loose: it is agreed before the code exists, so an",
      "exact one would be a guess dressed as a contract.",
      "",
      "Example:",
      "file | src/billing/ApprovalPolicy.ts | src/billing/InvoiceService.ts | 80",
      "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide(invoice, approver): ApprovalDecision | applies the approval rules to one invoice",
      "export | src/billing/ApprovalPolicy.ts | ApprovalDecision | { approved, reason } | the outcome, with why it was reached"
    ].join("\n"),
    token
  );

  if (text === undefined) {
    return new Map();
  }

  const inventory = await indexing
    .listFiles({ startPath: workspaceRoot, limit: Number.MAX_SAFE_INTEGER })
    .catch(() => undefined);

  const indexedPaths = new Set(
    (inventory?.files ?? []).map((file) =>
      file.repoName ? `${file.repoName}/${file.relativePath}` : file.relativePath
    )
  );

  return parseAddOutlines(text, {
    addPaths: new Set(adds.map((add) => add.relativePath)),
    indexedPaths
  });
}

/**
 * Asks the model which choices this plan is quietly making.
 *
 * Returns `undefined` when no model was available, which the caller reports
 * rather than papering over: "no decisions proposed" and "could not ask" are
 * different states, and showing the first when the second is true is the
 * silent-empty-context failure again in a new place.
 */
async function proposeDecisions(
  vscode: VscodeApiLike,
  request: string,
  changes: PlannedChange[],
  alreadyRecorded: Decision[],
  token: unknown
): Promise<ProposedDecision[] | undefined> {
  const files = changes.map((change) => change.relativePath).join("\n");
  // With ids, so a proposal can say which one it replaces when the developer
  // has changed their mind. Without them the model can only restate, and two
  // contradictory decisions both stay active.
  const settled = alreadyRecorded
    .map((decision) => `${decision.id} | ${decision.kind} | ${decision.statement}`)
    .join("\n");

  const prompt = [
    "A developer asked for this change:",
    request,
    "",
    "A plan proposes touching these files:",
    files,
    "",
    ...(settled ? ["Already decided in this session:", settled, ""] : []),
    "Name the choices this plan is making that a developer should confirm",
    "before any code is written. A choice is worth naming when a reasonable",
    `engineer could pick differently. At most ${MAX_PROPOSED_DECISIONS}.`,
    "",
    "One per line, pipe-separated, nothing else — no prose, no numbering:",
    "kind | what is being decided | what it was chosen over | id it replaces",
    "",
    "kind is one of: design, scope, constraint, fact",
    "Leave a field empty if it does not apply, but keep the pipes.",
    "",
    ...(settled
      ? [
          "Do not repeat a decision above. Propose one only if this plan",
          "contradicts it — then put that decision's id in the last field, so",
          "the developer can replace it rather than hold both.",
          ""
        ]
      : []),
    "Example:",
    "design | Approvals are recorded per invoice, not per batch | a batch-level approval table |",
    "scope | Changes stay inside the billing service | touching the orders service too |",
    ...(settled
      ? [
          "design | Approvals are recorded per batch after all | per-invoice approval | d1"
        ]
      : []),
    "",
    "If the plan makes no choice worth confirming, answer with nothing at all."
  ].join("\n");

  const text = await requestLmText(vscode, prompt, token);
  return text === undefined ? undefined : parseProposedDecisions(text);
}

async function requestLmText(
  vscode: VscodeApiLike,
  prompt: string,
  token: unknown
): Promise<string | undefined> {
  const collected: string[] = [];
  const sink: ChatResponseStreamLike = {
    markdown: (value: string) => collected.push(value)
  };

  const ok = await streamLmResponse(vscode, prompt, sink, token);
  return ok ? collected.join("") : undefined;
}

/**
 * Strips a fenced code block, which models add even when told not to. Writing
 * the fence into the file would corrupt it.
 */
function unfence(text: string): string {
  const fenced = /^\s*```[a-zA-Z0-9+-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim() + "\n";
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
    "One place to work, four steps. Each one carries what you decided into the next.",
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `/analyze <question>` | Explore the repo — use before planning a change |",
    "| `/create-plan <what you want>` | Draft a plan you approve before any code is written |",
    "| `/implement` | Apply the approved plan |",
    "| `/review` | Compare what was built against what was approved |",
    "",
    "**Example:** `@architect /create-plan Add invoice approval workflow`",
    "",
    "No slash command means `/analyze` — a stated rule, not a guess about your wording.",
    "",
    "Approving a plan and ending a session are buttons, not phrases: the step that",
    "authorizes writing code should never depend on how a sentence was read.",
    "",
    "Setup, MCP and agent commands live in the Command Palette and the dashboard."
  ].join("\n");
}

function renderActionLink(action: { id: string; label: string }): string {
  return `<a href="command:${action.id}">${escapeHtml(action.label)}</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
