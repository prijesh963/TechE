import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderRolePrompt } from "@copilot-architect/agents";
import { IndexingService, type SearchResult } from "@copilot-architect/indexer";
import { SessionService, type Session } from "@copilot-architect/session";
import { getArtifactFilePath, getArtifactRoot } from "@copilot-architect/shared";

import {
  DEFAULT_MAX_CHANGES,
  parseAddOutlines,
  parseSelectedChanges,
  verifySelectedChanges
} from "./change-selection.js";
import { parsePlanApproach } from "./plan-approach.js";
import {
  buildPlannedChange,
  createPlanContract,
  extractExcerpt,
  planValidationCommands,
  plannedPaths,
  verifyPlanFreshness,
  writeApprovedPlan,
  type PlanContract,
  type PlannedChange
} from "./plan-contract.js";

/**
 * The `@architect` workflow for a host that has GitHub Copilot Chat but no
 * way to call a model itself and no MCP — the IntelliJ edition inside an
 * organization whose Copilot policy blocks MCP servers.
 *
 * VS Code's `@architect` asks the model several narrow questions per phase
 * (which files, what the change does, what each new file contains) and
 * parses each answer. Here the only channel to the model is the developer
 * pasting into Copilot Chat, so each phase becomes exactly one prompt, and
 * the plan phase asks for all of its record kinds in one reply. The record
 * formats are the ones `parseSelectedChanges`, `parsePlanApproach` and
 * `parseAddOutlines` already read — each parser skips lines that are not its
 * own — so an imported reply produces the same `PlanContract` a VS Code
 * `/create-plan` would, stored in the same session, approved the same way.
 *
 * What a model says is never trusted further than the parsers trust it: an
 * update naming a file the index does not have is dropped, a cited symbol is
 * checked against the index, and file snapshots are read from disk, never
 * taken from the reply.
 */

/** Candidates offered to the model; the same width `/create-plan` searches. */
export const COPILOT_PLAN_CANDIDATE_LIMIT = 16;

/** Files quoted into an Ask prompt, and the lines either side of each anchor. */
const ASK_RESULT_LIMIT = 8;
const ASK_CONTEXT_LINES = 20;

/**
 * A pasted prompt that runs to hundreds of kilobytes is one Copilot Chat may
 * truncate or refuse. Excerpts are dropped from the end once this is reached
 * — and the prompt says how many were left out.
 */
const ASK_EXCERPT_BUDGET = 24_000;

export type CopilotPromptKind = "ask" | "plan" | "implement";

export interface CopilotPrompt {
  kind: CopilotPromptKind;
  /** The text to paste into Copilot Chat. */
  prompt: string;
  /** One line for the developer: what was prepared and what to do next. */
  message: string;
  /** Repo-relative paths the prompt is grounded in. */
  files: string[];
}

export interface PendingCopilotPlan {
  request: string;
  createdAt: string;
  candidates: { path: string; anchorLine?: number }[];
}

export interface ImportedCopilotPlan {
  version: number;
  request: string;
  plan: PlanContract;
  /** Selections whose cited symbol does not check out against the index. */
  unverified: string[];
  message: string;
}

export interface CopilotPlanSummary {
  version: number;
  status: "draft" | "approved";
  implemented: boolean;
  request: string;
  approach: string[];
  changes: {
    kind: PlannedChange["kind"];
    path: string;
    rationale: string;
    steps: string[];
  }[];
}

/** Everything a panel needs to show where the developer is in the flow. */
export interface CopilotWorkflowState {
  /** A plan prompt has been handed out and no reply imported for it yet. */
  pendingRequest?: string;
  /** The newest plan version in the active session, draft or approved. */
  latestPlan?: CopilotPlanSummary;
  /** The newest approved version — what Implement works from. */
  approvedVersion?: number;
}

export interface CopilotHandoffOptions {
  indexing?: IndexingService;
  sessions?: SessionService;
}

export class CopilotHandoffService {
  private readonly indexing: IndexingService;
  private readonly sessions: SessionService;

  constructor(options: CopilotHandoffOptions = {}) {
    this.indexing = options.indexing ?? new IndexingService();
    this.sessions = options.sessions ?? new SessionService();
  }

  /**
   * A question about the repo, with the files the index finds for it quoted
   * in. The excerpts are what make the answer grounded: Copilot Chat in Ask
   * mode sees only what is pasted, and without them it answers from what
   * projects like this usually look like.
   */
  async askPrompt(options: {
    workspaceRoot: string;
    question: string;
  }): Promise<CopilotPrompt> {
    const question = requireText(options.question, "Type a question first.");
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const results = await this.search(workspaceRoot, question, ASK_RESULT_LIMIT);

    if (results.length === 0) {
      throw new Error(
        "The index found nothing for that question. Try the words your code uses (a class or function name), or run Setup Repo if the index is missing."
      );
    }

    const excerpts: string[] = [];
    const files: string[] = [];
    let used = 0;
    let omitted = 0;

    for (const result of results) {
      const relativePath = toRelative(workspaceRoot, result.filePath);
      const block = await renderExcerpt(result, relativePath);

      if (!block || used + block.length > ASK_EXCERPT_BUDGET) {
        omitted += 1;
        continue;
      }

      excerpts.push(block);
      files.push(relativePath);
      used += block.length;
    }

    const prompt = [
      renderRolePrompt("analyze"),
      "",
      "Question:",
      question,
      "",
      `A local index of this repository found these ${files.length} file excerpt(s) for it:`,
      "",
      ...excerpts,
      ...(omitted > 0
        ? [
            `(${omitted} further match(es) were left out to keep this prompt short. If the answer needs them, say which file you would need to see.)`,
            ""
          ]
        : []),
      "Answer from these excerpts. Cite `path:line` for each claim."
    ].join("\n");

    return {
      kind: "ask",
      prompt,
      message: `Prompt ready, grounded in ${files.length} file(s). Paste it into Copilot Chat.`,
      files
    };
  }

  /**
   * The planning prompt: candidate files from the index, and the three
   * record kinds `/create-plan` asks for separately, asked for at once. The
   * request and candidates are remembered so {@link importPlan} can hold the
   * reply to them — an update to a file that was never offered, or that the
   * index does not have, is not accepted.
   */
  async planPrompt(options: {
    workspaceRoot: string;
    request: string;
  }): Promise<CopilotPrompt> {
    const request = requireText(options.request, "Describe the change first.");
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const results = await this.search(
      workspaceRoot,
      request,
      COPILOT_PLAN_CANDIDATE_LIMIT
    );

    if (results.length === 0) {
      throw new Error(
        "The index found nothing related to that change, so there is nothing to plan against. Try the words your code uses, or run Setup Repo if the index is missing."
      );
    }

    const candidates = results.map((result) => ({
      path: toRelative(workspaceRoot, result.filePath),
      ...(result.anchor?.line ? { anchorLine: result.anchor.line } : {})
    }));

    await writePending(workspaceRoot, {
      request,
      createdAt: new Date().toISOString(),
      candidates
    });

    const listing = results.map((result, index) =>
      describeCandidate(result, candidates[index].path)
    );

    const prompt = [
      renderRolePrompt("plan"),
      "",
      "A developer asked for this change:",
      request,
      "",
      "A search of their repository found these related files:",
      ...listing,
      "",
      "Read the files you need, then decide which ones actually have to change,",
      "and how. Being related is not a reason to change: leave out a test, doc or",
      "config that merely mentions the subject. Include a new file where the",
      "feature needs one.",
      "",
      "Reply with ONLY the records below, one per line, pipe-separated, inside a",
      "single code block — no prose, no headings, no numbering. The reply is read",
      "by a program: lines in any other shape are ignored.",
      "",
      "1. Which files change (at most " + DEFAULT_MAX_CHANGES + "):",
      "   kind | repo-relative path | why this file changes | a symbol that file declares",
      "   kind is add, update or delete. Use a path from the list above for update",
      "   and delete. For add, give the new file's path and leave the symbol empty.",
      "   The symbol is checked against the index — leave it empty rather than guess.",
      "",
      "2. What the change does:",
      "   approach | one line of what the change does overall   (two to four of these)",
      "   step | path | what changes in that file               (one per distinct edit)",
      "",
      "3. For each new (add) file, what it will contain:",
      "   file | path | repo files it imports | rough line count",
      "   export | path | name | how it is called | what it is for",
      "",
      "Example:",
      "```",
      "update | src/billing/InvoiceService.ts | holds the invoice lifecycle this hooks into | InvoiceService",
      "add | src/billing/ApprovalPolicy.ts | new rules deciding who may approve |",
      "approach | Invoices above a threshold need a second approver before they are paid.",
      "step | src/billing/InvoiceService.ts | call ApprovalPolicy.decide from approve() before marking paid",
      "step | src/billing/ApprovalPolicy.ts | new class holding the threshold rule",
      "file | src/billing/ApprovalPolicy.ts | src/billing/InvoiceService.ts | 80",
      "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide(invoice, approver): ApprovalDecision | applies the approval rules to one invoice",
      "```",
      "",
      "Do not write any code yet. If I ask for changes to this plan, reply again with",
      "the complete set of records, not only the lines that changed."
    ].join("\n");

    return {
      kind: "plan",
      prompt,
      message: `Planning prompt ready with ${candidates.length} candidate file(s). Paste it into Copilot Chat, then copy Copilot's reply and click Import plan.`,
      files: candidates.map((candidate) => candidate.path)
    };
  }

  /**
   * Turns a pasted Copilot reply into a draft plan version, the same way
   * `/create-plan` turns its model answers into one. A reply with no valid
   * selection is refused rather than replaced with a relevance guess: the
   * developer asked to import Copilot's plan, and a different plan under
   * that name would be a quiet substitution.
   */
  async importPlan(options: {
    workspaceRoot: string;
    response: string;
  }): Promise<ImportedCopilotPlan> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const pending = await readPending(workspaceRoot);

    if (!pending) {
      throw new Error(
        "There is no plan to import into. Describe the change and click Plan first."
      );
    }

    const response = requireText(
      options.response,
      "Nothing to import — the clipboard is empty. Click Copy on Copilot's reply first."
    );

    const inventory = await this.indexing
      .listFiles({ startPath: workspaceRoot, limit: Number.MAX_SAFE_INTEGER })
      .catch(() => undefined);
    const indexedPaths = new Set(
      (inventory?.files ?? []).map((file) =>
        file.repoName ? `${file.repoName}/${file.relativePath}` : file.relativePath
      )
    );

    const selection = parseSelectedChanges(response, {
      candidates: pending.candidates.map((candidate) => candidate.path),
      indexedPaths
    });

    if (selection.length === 0) {
      throw new Error(
        "No plan lines were found in the copied text. Copy Copilot's whole reply (the lines starting with add, update or delete) and try again."
      );
    }

    const symbolsByFile = await this.indexing
      .symbolsByFile({ startPath: workspaceRoot })
      .catch(() => new Map<string, Set<string>>());
    const verified = verifySelectedChanges(selection, symbolsByFile);

    const addPaths = new Set(
      verified
        .filter((choice) => choice.kind === "add")
        .map((choice) => choice.relativePath)
    );
    const outlines =
      addPaths.size > 0
        ? parseAddOutlines(response, { addPaths, indexedPaths })
        : new Map();
    const approach = parsePlanApproach(response, {
      plannedPaths: new Set(verified.map((choice) => choice.relativePath))
    });
    const anchors = new Map(
      pending.candidates.map((candidate) => [candidate.path, candidate.anchorLine])
    );

    const changes: PlannedChange[] = [];
    for (const choice of verified) {
      const intent = approach.intents.get(choice.relativePath);
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

    const session = await this.sessionFor(workspaceRoot, pending.request);
    const version = session.plans.length + 1;
    const plan = createPlanContract({
      request: pending.request,
      version,
      decisions: this.sessions.activeDecisions(session),
      changes,
      ...(approach.summary.length > 0 ? { approach: approach.summary } : {}),
      validation: planValidationCommands(
        await readJson(getArtifactFilePath(workspaceRoot, "repoMap"))
      )
    });

    await this.sessions.addPlanVersion({ workspaceRoot }, { ...plan });

    const unverified = verified
      .filter((choice) => choice.evidence === "unverified")
      .map((choice) => choice.relativePath);

    return {
      version,
      request: pending.request,
      plan,
      unverified,
      message:
        `Imported plan v${version} (${changes.length} file(s)). Review it, then approve it or ask Copilot for changes and import again.` +
        (unverified.length > 0
          ? ` The reason given for ${unverified.join(", ")} does not check out against the index.`
          : "")
    };
  }

  /**
   * Approval: a click, never a phrase. Promotes the draft in the session and
   * writes it to `plans/approved/`, as VS Code's Approve button does.
   */
  async approvePlan(options: {
    workspaceRoot: string;
    version: number;
  }): Promise<{ version: number; planPath: string }> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const session = await this.sessions.current({ workspaceRoot });
    const target = session?.plans.find((plan) => plan.version === options.version);

    if (!session || !target) {
      throw new Error(`There is no plan v${options.version} in the current session.`);
    }
    if (target.status === "approved") {
      throw new Error(`Plan v${options.version} is already approved.`);
    }

    const approved = await this.sessions.approvePlan(
      { workspaceRoot },
      options.version
    );
    const plan = this.sessions.latestApprovedPlan(approved);
    const written = await writeApprovedPlan(
      workspaceRoot,
      plan!.content as unknown as PlanContract
    );
    await clearPending(workspaceRoot);

    return { version: options.version, planPath: written.planPath };
  }

  /**
   * The implementation prompt for the newest approved version. Refused when
   * a planned file has changed since the plan quoted it: the steps were
   * agreed against code that is no longer there.
   */
  async implementPrompt(options: { workspaceRoot: string }): Promise<CopilotPrompt> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const session = await this.sessions.current({ workspaceRoot });
    const approved = session ? this.sessions.latestApprovedPlan(session) : undefined;

    if (!session || !approved) {
      throw new Error(
        "There is no approved plan to implement. Plan the change and approve it first."
      );
    }

    const plan = approved.content as unknown as PlanContract;
    const freshness = await verifyPlanFreshness(plan, workspaceRoot);

    if (!freshness.ok) {
      const moved = [...freshness.drifted, ...freshness.missing].join(", ");
      throw new Error(
        `These files changed after plan v${plan.version} was made: ${moved}. Plan again so the steps match the code as it is now.`
      );
    }

    await this.sessions.setPhase({ workspaceRoot }, "implement");

    const files = plannedPaths(plan);
    const prompt = [
      renderRolePrompt("implement"),
      "",
      `Implement this approved plan (v${plan.version}) in Agent mode, editing the files directly.`,
      "",
      "Request:",
      plan.request,
      "",
      ...(plan.approach && plan.approach.length > 0
        ? ["What the change does:", ...plan.approach.map((line) => `- ${line}`), ""]
        : []),
      "Files — change these and no others:",
      ...plan.changes.flatMap((change) => renderChangeForImplement(change)),
      "",
      ...(plan.decisions.length > 0
        ? [
            "Decisions already made — follow them:",
            ...plan.decisions.map((decision) => `- ${decision.statement}`),
            ""
          ]
        : []),
      "Rules:",
      "- Read each file before editing it; change only what its steps describe.",
      "- If the plan turns out to need a file that is not listed, stop and say which and why instead of editing it.",
      ...(plan.validation.length > 0
        ? [
            `- When done, run: ${plan.validation.map((command) => command.command).join(", ")} and report the results.`
          ]
        : []),
      "- Finish with a short list of what you changed in each file."
    ].join("\n");

    return {
      kind: "implement",
      prompt,
      message: `Implementation prompt for plan v${plan.version} ready. Paste it into Copilot Chat in Agent mode.`,
      files
    };
  }

  /** Read-only: never opens, parks or changes a session. */
  async state(options: { workspaceRoot: string }): Promise<CopilotWorkflowState> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const [pending, peeked] = await Promise.all([
      readPending(workspaceRoot),
      this.sessions.peek({ workspaceRoot }).catch(() => undefined)
    ]);
    const session = peeked && !peeked.staleBranch ? peeked.session : undefined;
    const latest = session?.plans[session.plans.length - 1];
    const approved = session ? this.sessions.latestApprovedPlan(session) : undefined;

    return {
      ...(pending ? { pendingRequest: pending.request } : {}),
      ...(latest ? { latestPlan: summarizePlan(latest) } : {}),
      ...(approved ? { approvedVersion: approved.version } : {})
    };
  }

  /**
   * The session this request's plans belong to. A different request is a
   * different feature: it opens a new session (parking, not deleting, the
   * old one) rather than stacking an unrelated plan onto it as a revision.
   */
  private async sessionFor(workspaceRoot: string, request: string): Promise<Session> {
    const current = await this.sessions.current({ workspaceRoot });

    if (current && current.title === request.trim()) {
      return current.phase === "plan"
        ? current
        : this.sessions.setPhase({ workspaceRoot }, "plan");
    }

    return this.sessions.open({ workspaceRoot, title: request, phase: "plan" });
  }

  private async search(
    workspaceRoot: string,
    query: string,
    limit: number
  ): Promise<SearchResult[]> {
    const response = await this.indexing
      .search({ startPath: workspaceRoot, query, limit })
      .catch(() => undefined);
    return response?.results ?? [];
  }
}

function summarizePlan(version: Session["plans"][number]): CopilotPlanSummary {
  const plan = version.content as unknown as PlanContract;

  return {
    version: version.version,
    status: version.status,
    implemented: Boolean(version.implementedAt),
    request: plan.request ?? "",
    approach: plan.approach ?? [],
    changes: (plan.changes ?? []).map((change) => ({
      kind: change.kind,
      path: change.repoName
        ? `${change.repoName}/${change.relativePath}`
        : change.relativePath,
      rationale: change.rationale,
      steps: change.intent ?? []
    }))
  };
}

function renderChangeForImplement(change: PlannedChange): string[] {
  const lines = [`- ${change.kind} ${change.relativePath} — ${change.rationale}`];

  for (const step of change.intent ?? []) {
    lines.push(`    - ${step}`);
  }

  if (change.kind === "add" && change.outline) {
    for (const entry of change.outline.exports) {
      lines.push(
        `    - export ${entry.name}${entry.signature ? ` — ${entry.signature}` : ""}${entry.purpose ? `: ${entry.purpose}` : ""}`
      );
    }
    if (change.outline.dependsOn.length > 0) {
      lines.push(`    - imports ${change.outline.dependsOn.join(", ")}`);
    }
  }

  return lines;
}

function describeCandidate(result: SearchResult, relativePath: string): string {
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
    relativePath,
    tags.length > 0 ? ` [${tags.join(", ")}]` : "",
    symbols ? ` — declares ${symbols}` : ""
  ].join("");
}

async function renderExcerpt(
  result: SearchResult,
  relativePath: string
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(result.filePath, "utf8");
  } catch {
    return undefined;
  }

  const excerpt = extractExcerpt(text, result.anchor?.line, ASK_CONTEXT_LINES);
  return [
    `--- ${relativePath} (lines ${excerpt.startLine}–${excerpt.endLine} of ${excerpt.fileLines})`,
    "```",
    excerpt.text,
    "```",
    ""
  ].join("\n");
}

function toRelative(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

function requireText(value: string | undefined, message: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function pendingPath(workspaceRoot: string): string {
  return path.join(getArtifactRoot(workspaceRoot), "copilot", "pending-plan.json");
}

async function writePending(
  workspaceRoot: string,
  pending: PendingCopilotPlan
): Promise<void> {
  const file = pendingPath(workspaceRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
}

async function readPending(
  workspaceRoot: string
): Promise<PendingCopilotPlan | undefined> {
  return readJson<PendingCopilotPlan>(pendingPath(workspaceRoot));
}

async function clearPending(workspaceRoot: string): Promise<void> {
  await rm(pendingPath(workspaceRoot), { force: true });
}

async function readJson<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
