import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { collectSessionChangeStats } from "@copilot-architect/core";
import { readSearchActivitySince } from "@copilot-architect/indexer";
import {
  SessionService,
  type Decision,
  type DecisionKind,
  type Session,
  type SessionPhase
} from "@copilot-architect/session";

/**
 * The dashboard's render+load logic, shared by every shell that shows it.
 *
 * This used to live inside `packages/vscode-extension` — the only shell that
 * existed. It moved here when a second shell (the IntelliJ plugin, via the
 * CLI's `dashboard` command) needed the identical output: same Core Rule the
 * rest of the product follows, just for this one screen. Nothing in this
 * package knows about VS Code, IntelliJ, or any other host — `ExtensionState`
 * is deliberately host-agnostic despite the name (kept to limit churn in the
 * VS Code extension, which originated it).
 *
 * The one shell-specific seam is the action row at the top: VS Code renders
 * it as `command:` URIs, other hosts render it differently or not at all, so
 * `createDashboardHtml` takes it as pre-rendered HTML rather than owning it.
 */

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
  /** This shell's own build/version string, shown in the Build card. Falls back to "unknown" when omitted. */
  buildVersion?: string;
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
  /** Management-facing rollups for the running session. Undefined only when the session itself could not be read. */
  activity?: SessionActivityInsights;
}

/**
 * Session-scoped numbers for the Agent Insights card — the "what actually
 * happened" counterpart to {@link ContextInsights}' "what this saves".
 *
 * Every field is derived from data the tool already tracks for its own
 * purposes (the session record, the search-activity log, git itself) rather
 * than estimated or invented for display. `changeStats` and the index counts
 * degrade to `undefined`/`0` rather than a guess when the underlying source
 * has nothing to report — see {@link collectSessionChangeStats} and
 * {@link readSearchActivitySince}.
 */
export interface SessionActivityInsights {
  /** Minutes since the session opened, rounded. */
  durationMinutes: number;
  /** Confirmed, active (non-superseded) decisions this session, by kind. */
  decisionsByKind: Record<DecisionKind, number>;
  planRevisionCount: number;
  planApprovedCount: number;
  /** Versions actually implemented — what `/review` compares against. */
  planImplementedVersions: number[];
  /** Confirmed `constraint` decisions that carry enforcement the tool can check, vs. ones it cannot. */
  constraintsEnforced: number;
  constraintsUnenforceable: number;
  /** Tracked-file diff since the session opened. Undefined when no git history reaches back that far. */
  changeStats?: { filesChanged: number; linesAdded: number; linesRemoved: number };
  /** Distinct files the index actually returned to a search this session, and how many searches ran. */
  filesReferredFromIndex: number;
  searchCount: number;
}

/** Live values read from `.copilot-architect/` artifacts to populate the dashboard. */
export interface DashboardArtifacts {
  languages?: string[];
  frameworks?: string[];
  latestPlan?: {
    title: string;
    status?: string;
    generatedAt?: string;
    /** The revision currently in `plans/latest-plan.json` — required to approve it (`plan approve` never infers "whatever is newest"). */
    revision?: number;
    revisionCount?: number;
  };
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

  lines.push(formatSessionDecisions(session.decisions));

  return lines.join("<br>");
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

function formatMcpStatusAccent(status: ExtensionState["mcpStatus"]): string {
  switch (status) {
    case "running":
      return "var(--vscode-charts-green)";
    case "starting":
      return "var(--vscode-charts-yellow)";
    default:
      return "var(--vscode-charts-red)";
  }
}

/**
 * One small hand-drawn glyph per card, inlined as raw SVG markup — never a
 * fetched icon font or image, so the dashboard renders identically offline
 * and needs no webview resource root. Each is a 16x16 viewBox, white on the
 * card's own accent color, sized for the ~12px circle it sits in.
 */
const DASHBOARD_ICONS = {
  currentWork: '<polygon points="4,3 4,13 13,8" fill="white"/>',
  repoSummary:
    '<path d="M2 4a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" fill="white"/>',
  languages:
    '<path d="M5 3L1.5 8 5 13M11 3l3.5 5L11 13" stroke="white" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  validation:
    '<path d="M3 8.5l3 3 7-7.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  review:
    '<circle cx="6.5" cy="6.5" r="4" stroke="white" stroke-width="1.6" fill="none"/><line x1="9.8" y1="9.8" x2="14" y2="14" stroke="white" stroke-width="1.8" stroke-linecap="round"/>',
  agentStatus:
    '<rect x="3" y="5" width="10" height="8" rx="2" stroke="white" stroke-width="1.4" fill="none"/><circle cx="6" cy="9" r="1" fill="white"/><circle cx="10" cy="9" r="1" fill="white"/><line x1="8" y1="5" x2="8" y2="2.5" stroke="white" stroke-width="1.4"/><circle cx="8" cy="2" r="1" fill="white"/>',
  mcpStatus:
    '<path d="M5 2v4M11 2v4M4 6h8v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6zM8 12v3" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  build:
    '<path d="M8 2v7m0 0L5 6m3 3l3-3M3 12h10" stroke="white" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  agentInsights:
    '<rect x="2" y="9" width="3" height="5" fill="white"/><rect x="6.5" y="5" width="3" height="9" fill="white"/><rect x="11" y="2" width="3" height="12" fill="white"/>',
  lastCommand:
    '<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="white" stroke-width="1.4" fill="none"/><path d="M4.5 6.5l2 2-2 2M8.5 10.5h3" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
} as const;

function renderIconCircle(accent: string, iconInner: string): string {
  return `<span class="icon-circle" style="background:${accent}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">${iconInner}</svg></span>`;
}

export interface CreateDashboardHtmlOptions {
  /**
   * Pre-rendered HTML for the action row at the top of the dashboard. Each
   * host renders its own — VS Code as `command:` URIs, others differently or
   * not at all — so this package never bakes in one host's link scheme.
   * Omitted or empty renders an empty (but valid) action row.
   */
  actionsHtml?: string;
}

export function createDashboardHtml(
  state: ExtensionState,
  options: CreateDashboardHtmlOptions = {}
): string {
  const artifacts = state.artifacts;
  const sections = [
    {
      // First, because it is the answer to "where am I?" — the question the
      // dashboard exists to answer and previously could not.
      title: "Current work",
      body: formatSession(state.session),
      accent: "var(--vscode-charts-blue)",
      icon: DASHBOARD_ICONS.currentWork
    },
    {
      title: "Repo summary",
      body: escapeHtml(
        artifacts?.repoCount
          ? `${state.workspaceRoot} · ${artifacts.repoCount} registered repo(s)`
          : state.workspaceRoot
      ),
      accent: "var(--vscode-charts-purple)",
      icon: DASHBOARD_ICONS.repoSummary
    },
    {
      title: "Languages/frameworks",
      body: escapeHtml(formatLanguagesFrameworks(artifacts)),
      accent: "var(--vscode-charts-orange)",
      icon: DASHBOARD_ICONS.languages
    },
    {
      title: "Validation runs",
      body: escapeHtml(formatValidation(artifacts)),
      accent: "var(--vscode-charts-yellow)",
      icon: DASHBOARD_ICONS.validation
    },
    {
      title: "Review reports",
      body: escapeHtml(formatReview(artifacts)),
      accent: "var(--vscode-charts-red)",
      icon: DASHBOARD_ICONS.review
    },
    {
      title: "Agent status",
      body: escapeHtml(formatAgents(artifacts)),
      accent: "var(--vscode-charts-purple)",
      icon: DASHBOARD_ICONS.agentStatus
    },
    {
      title: "MCP status",
      body: state.mcpStatus,
      accent: formatMcpStatusAccent(state.mcpStatus),
      icon: DASHBOARD_ICONS.mcpStatus
    },
    {
      // So a developer re-testing a fix can see which build is running
      // without having to deduce it from behaviour.
      title: "Build",
      body: escapeHtml(state.buildVersion ?? "unknown"),
      accent: "var(--vscode-charts-blue)",
      icon: DASHBOARD_ICONS.build
    },
    {
      title: "Agent insights",
      body: formatAgentInsights(artifacts, state.session),
      accent: "var(--vscode-charts-green)",
      icon: DASHBOARD_ICONS.agentInsights
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
    ".grid{display:flex;flex-direction:column;gap:10px;}",
    "section{border:1px solid var(--vscode-panel-border);border-left:4px solid var(--accent, var(--vscode-panel-border));border-radius:6px;padding:10px;background:var(--vscode-sideBar-background);}",
    "h2{display:flex;align-items:center;font-size:13px;font-weight:600;margin:0 0 8px;color:var(--accent, var(--vscode-foreground));}",
    ".icon-circle{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:20px;height:20px;border-radius:50%;margin-right:6px;}",
    "p{font-size:12px;line-height:1.4;margin:0;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere;}",
    ".actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;}",
    "a{font-size:12px;color:var(--vscode-textLink-foreground);text-decoration:none;}",
    "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;}",
    "</style>",
    "</head>",
    "<body>",
    "<h1>Copilot Architect</h1>",
    `<div class="actions">${options.actionsHtml ?? ""}</div>`,
    '<div class="grid">',
    ...sections.map(
      (section) =>
        `<section style="--accent:${section.accent}"><h2>${renderIconCircle(section.accent, section.icon)}${section.title}</h2><p>${section.body}</p></section>`
    ),
    "</div>",
    '<section style="margin-top:10px;--accent:var(--vscode-charts-blue)">',
    `<h2>${renderIconCircle("var(--vscode-charts-blue)", DASHBOARD_ICONS.lastCommand)}Last command</h2>`,
    `<p>${escapeHtml(state.lastCommand ?? "None")}</p>`,
    `<p>Exit code: ${state.lastExitCode ?? "n/a"}</p>`,
    state.lastStdout ? `<pre>${escapeHtml(state.lastStdout)}</pre>` : "",
    state.lastStderr ? `<pre>${escapeHtml(state.lastStderr)}</pre>` : "",
    "</section>",
    "</body>",
    "</html>"
  ].join("");
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
  const activeDecisions = sessions.activeDecisions(session);

  return {
    title: session.title,
    phase: session.phase,
    decisions: activeDecisions.map((decision) => ({
      kind: decision.kind,
      statement: decision.statement
    })),
    plans: session.plans.map((plan) => ({
      version: plan.version,
      status: plan.status,
      implemented: Boolean(plan.implementedAt)
    })),
    staleBranch,
    activity: await loadSessionActivity(workspaceRoot, session, activeDecisions)
  };
}

/**
 * Assembles {@link SessionActivityInsights} from data the tool already
 * tracks: the session record itself for decisions and plan revisions, git
 * for the tracked-file diff since the session opened, and the search-activity
 * log for what the index actually handed back. Never throws — a source that
 * fails degrades to zero/undefined rather than losing the whole card.
 */
async function loadSessionActivity(
  workspaceRoot: string,
  session: Session,
  activeDecisions: Decision[]
): Promise<SessionActivityInsights> {
  const decisionsByKind: Record<DecisionKind, number> = {
    design: 0,
    scope: 0,
    constraint: 0,
    fact: 0
  };
  let constraintsEnforced = 0;
  let constraintsUnenforceable = 0;

  for (const decision of activeDecisions) {
    decisionsByKind[decision.kind] += 1;
    if (decision.kind === "constraint") {
      if (decision.enforcement) {
        constraintsEnforced += 1;
      } else {
        constraintsUnenforceable += 1;
      }
    }
  }

  const [changeStats, searchActivity] = await Promise.all([
    collectSessionChangeStats(workspaceRoot, session.createdAt).catch(() => undefined),
    readSearchActivitySince(workspaceRoot, session.createdAt).catch(() => ({
      filesReferred: 0,
      searchCount: 0
    }))
  ]);

  return {
    durationMinutes: Math.max(
      0,
      Math.round((Date.now() - new Date(session.createdAt).getTime()) / 60_000)
    ),
    decisionsByKind,
    planRevisionCount: session.plans.length,
    planApprovedCount: session.plans.filter((plan) => plan.status === "approved")
      .length,
    planImplementedVersions: session.plans
      .filter((plan) => plan.implementedAt)
      .map((plan) => plan.version),
    constraintsEnforced,
    constraintsUnenforceable,
    changeStats,
    filesReferredFromIndex: searchActivity.filesReferred,
    searchCount: searchActivity.searchCount
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
    revision?: number;
    revisions?: unknown[];
  }>(path.join(root, "plans", "latest-plan.json"));
  if (plan) {
    artifacts.latestPlan = {
      title: plan.title ?? plan.task ?? "Untitled plan",
      status: plan.status,
      generatedAt: plan.generatedAt,
      revision: plan.revision,
      revisionCount: plan.revisions?.length
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

/** Reads and parses a JSON file, returning `undefined` on any failure — missing file, bad JSON, anything. */
export async function readJsonSafe<T>(filePath: string): Promise<T | undefined> {
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
// CHARS_PER_TOKEN by value rather than by import: this package ships inside
// two independent shells (VS Code extension, IntelliJ plugin via the CLI) and
// deliberately depends on no other workspace package for this one constant.
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

const COLOR_BLUE = "var(--vscode-charts-blue)";
const COLOR_GREEN = "var(--vscode-charts-green)";
const COLOR_RED = "var(--vscode-charts-red)";
const COLOR_ORANGE = "var(--vscode-charts-orange)";
const COLOR_PURPLE = "var(--vscode-charts-purple)";
const COLOR_YELLOW = "var(--vscode-charts-yellow)";

/** A single colored, bold figure — the "stat" look management rollups use throughout this card. */
function stat(value: string | number, colorVar: string): string {
  return `<span style="color:${colorVar};font-weight:600">${escapeHtml(String(value))}</span>`;
}

/**
 * Management-facing rollup: context savings (existing), plus what actually
 * happened this session — files the index handed back, lines changed,
 * decisions, plan/approval cycle, constraint coverage, and the latest
 * validation/review standing. Every figure traces to real data (see
 * {@link SessionActivityInsights}, {@link ContextInsights}); nothing here is
 * estimated except where the source line says so.
 *
 * Returns safe HTML directly — callers must not re-escape it, matching
 * {@link formatSession}.
 */
export function formatAgentInsights(
  artifacts: DashboardArtifacts | undefined,
  session: DashboardSession | undefined
): string {
  const lines: string[] = [];
  const insights = artifacts?.contextInsights;

  if (!insights) {
    lines.push("No index yet — run Setup Repo to measure context usage.");
  } else {
    const without = `Without Copilot Architect: ${formatFileCount(insights.repoFileCount)} · ~${stat(formatTokens(insights.repoEstimatedTokens), COLOR_BLUE)} tokens`;

    if (insights.selectedFileCount === 0) {
      lines.push(`${without}. No plan yet — run Generate Plan to compare.`);
    } else {
      const withArchitect = `With Copilot Architect: ${formatFileCount(insights.selectedFileCount)} · ~${stat(formatTokens(insights.selectedEstimatedTokens), COLOR_BLUE)} tokens`;
      const saved = insights.repoEstimatedTokens - insights.selectedEstimatedTokens;
      const request = insights.request
        ? ` for "${escapeHtml(truncate(insights.request, 48))}"`
        : "";

      lines.push(without);
      lines.push(withArchitect);
      lines.push(
        `Sends ${stat(`${insights.reductionPercent}%`, COLOR_GREEN)} less (~${formatTokens(saved)} tokens) per request${request}.`
      );
      // "Without" means the whole repo — the fallback when an agent has no plan
      // to go on. It is not a measurement of what Copilot itself sends (Copilot
      // does its own retrieval), and chars÷4 is not a real tokenizer, so the
      // caveat spells out the baseline. See docs/benchmarks/AFTER.md.
      lines.push(
        "Estimate only (chars÷4), measured against whole-repo context — not a Copilot bill."
      );
    }
  }

  const activity = session?.activity;
  if (activity) {
    lines.push(
      `Files referred from index this session: ${stat(activity.filesReferredFromIndex, COLOR_PURPLE)} across ${activity.searchCount} search${activity.searchCount === 1 ? "" : "es"}.`
    );
    lines.push(formatChangeStatsLine(activity.changeStats));
    lines.push(
      `Session duration: ${stat(formatDuration(activity.durationMinutes), COLOR_BLUE)}.`
    );
    lines.push(formatDecisionsByKindLine(activity.decisionsByKind));
    lines.push(formatPlanRollupLine(activity));
    lines.push(formatConstraintsLine(activity));
  }

  const validation = artifacts?.latestValidation;
  if (validation && typeof validation.total === "number" && validation.total > 0) {
    const passed = validation.passed ?? 0;
    const color = passed === validation.total ? COLOR_GREEN : COLOR_ORANGE;
    lines.push(
      `Latest validation pass rate: ${stat(`${passed}/${validation.total}`, color)}.`
    );
  }

  const review = artifacts?.latestReview;
  if (review && typeof review.findingCount === "number") {
    const color = review.findingCount === 0 ? COLOR_GREEN : COLOR_RED;
    lines.push(`Latest review findings open: ${stat(review.findingCount, color)}.`);
  }

  return lines.join("<br>");
}

function formatChangeStatsLine(
  changeStats: SessionActivityInsights["changeStats"]
): string {
  if (!changeStats) {
    return "Lines changed this session: no git history to compare against.";
  }
  const { filesChanged, linesAdded, linesRemoved } = changeStats;
  if (filesChanged === 0 && linesAdded === 0 && linesRemoved === 0) {
    return "Lines changed this session: none yet.";
  }
  return `Lines changed this session: ${stat(`+${linesAdded}`, COLOR_GREEN)} / ${stat(`-${linesRemoved}`, COLOR_RED)} across ${filesChanged} tracked file(s).`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatDecisionsByKindLine(byKind: Record<DecisionKind, number>): string {
  const total = Object.values(byKind).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return "Decisions recorded this session: none yet.";
  }
  const breakdown = (Object.keys(byKind) as DecisionKind[])
    .filter((kind) => byKind[kind] > 0)
    .map((kind) => `${byKind[kind]} ${kind}`)
    .join(", ");
  return `Decisions recorded this session: ${stat(total, COLOR_PURPLE)} (${escapeHtml(breakdown)}).`;
}

function formatPlanRollupLine(activity: SessionActivityInsights): string {
  if (activity.planRevisionCount === 0) {
    return "Plan revisions this session: none drafted yet.";
  }
  const implemented =
    activity.planImplementedVersions.length > 0
      ? `implemented v${activity.planImplementedVersions.join(", v")}`
      : "none implemented";
  return `Plan revisions this session: ${stat(activity.planRevisionCount, COLOR_YELLOW)} (${activity.planApprovedCount} approved, ${escapeHtml(implemented)}).`;
}

function formatConstraintsLine(activity: SessionActivityInsights): string {
  const total = activity.constraintsEnforced + activity.constraintsUnenforceable;
  if (total === 0) {
    return "Constraints recorded this session: none.";
  }
  return `Constraints recorded this session: ${stat(activity.constraintsEnforced, COLOR_GREEN)} enforced, ${stat(activity.constraintsUnenforceable, COLOR_ORANGE)} unenforceable.`;
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

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
