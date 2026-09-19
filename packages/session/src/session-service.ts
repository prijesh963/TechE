import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  getArtifactDirectoryPath,
  readGitHead
} from "@copilot-architect/shared";

import type {
  Checkpoint,
  CheckpointDiff,
  ConstraintCheck,
  ConstraintViolation,
  Decision,
  OpenSessionOptions,
  PlanContent,
  PlanVersion,
  RecordDecisionInput,
  Session,
  SessionPeek,
  SessionPhase,
  SessionQuery,
  UnenforceableConstraint
} from "./models.js";

/**
 * Reads and writes work sessions under `.copilot-architect/sessions/`.
 *
 * On disk rather than in memory because developers reload VS Code constantly,
 * and losing a half-built plan to a window reload would make the feature
 * useless. On disk also means a session can be inspected when something looks
 * wrong, which chat scrollback never allows.
 */
export class SessionService {
  /**
   * Starts a session, parking any session already active in this workspace.
   *
   * One at a time is a deliberate v1 constraint: it removes session-switching
   * from the interface entirely. Parking rather than discarding is what makes
   * that constraint acceptable — a developer interrupted by a production issue
   * keeps their work.
   */
  async open(options: OpenSessionOptions): Promise<Session> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const existing = await this.readActive(workspaceRoot);

    if (existing) {
      await this.write(workspaceRoot, park(existing, "superseded by a new session"));
    }

    const now = new Date().toISOString();
    const session: Session = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: createSessionId(options.title, now),
      workspaceRoot,
      title: options.title.trim(),
      status: "active",
      phase: options.phase ?? "analyze",
      gitHead: await readGitHead(workspaceRoot),
      createdAt: now,
      updatedAt: now,
      decisions: [],
      plans: []
    };

    await this.write(workspaceRoot, session);
    return session;
  }

  /**
   * The active session, or `undefined` when there is none.
   *
   * Parks the session first if the branch has moved since it opened. That is a
   * write inside a read, which is normally worth avoiding — but the alternative
   * is answering from a session that belongs to a branch the developer has
   * left, and a check every caller must remember is a check that gets
   * forgotten. Enforcing it here means it cannot be.
   */
  async current(query: SessionQuery): Promise<Session | undefined> {
    const peeked = await this.peek(query);

    if (!peeked) {
      return undefined;
    }

    if (peeked.staleBranch) {
      await this.write(
        path.resolve(query.workspaceRoot),
        park(
          peeked.session,
          `branch changed from ${describeHead(peeked.session.gitHead)}`
        )
      );
      return undefined;
    }

    return peeked.session;
  }

  /**
   * The active session without touching it.
   *
   * `current()` parks a session whose branch moved, which is correct when a
   * phase is about to act on it and wrong for anything that merely displays
   * it: a dashboard repaint must not end the developer's session as a side
   * effect of being looked at. This reports the same staleness and leaves the
   * decision to the caller.
   */
  async peek(query: SessionQuery): Promise<SessionPeek | undefined> {
    const workspaceRoot = path.resolve(query.workspaceRoot);
    const session = await this.readActive(workspaceRoot);

    if (!session) {
      return undefined;
    }

    return {
      session,
      staleBranch: session.gitHead !== (await readGitHead(workspaceRoot))
    };
  }

  /** Every session in this workspace, newest first. */
  async list(query: SessionQuery): Promise<Session[]> {
    const workspaceRoot = path.resolve(query.workspaceRoot);
    const directory = sessionsDirectory(workspaceRoot);
    let names: string[];

    try {
      names = await readdir(directory);
    } catch {
      return [];
    }

    const sessions: Session[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const session = await readSessionFile(path.join(directory, name));
      if (session) sessions.push(session);
    }

    return sessions.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  async setPhase(query: SessionQuery, phase: SessionPhase): Promise<Session> {
    return this.mutate(query, (session) => ({ ...session, phase }));
  }

  /**
   * Appends a decision the developer has confirmed.
   *
   * Nothing here proposes or infers: a decision reaches this method only after
   * a human agreed to it. Superseding keeps the replaced decision rather than
   * overwriting it, because "why did we change our mind" is usually the
   * question worth answering later.
   */
  async recordDecision(
    query: SessionQuery,
    input: RecordDecisionInput
  ): Promise<Session> {
    return this.mutate(query, (session) => {
      if (
        input.supersedes &&
        !session.decisions.some((d) => d.id === input.supersedes)
      ) {
        throw new Error(`No decision to supersede: ${input.supersedes}`);
      }

      const decision: Decision = {
        id: `d${session.decisions.length + 1}`,
        kind: input.kind,
        statement: input.statement.trim(),
        ...(input.rejected ? { rejected: input.rejected.trim() } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        ...(input.enforcement ? { enforcement: input.enforcement } : {}),
        confirmedAt: new Date().toISOString()
      };

      return { ...session, decisions: [...session.decisions, decision] };
    });
  }

  /** Decisions still in force — those nothing later replaced. */
  activeDecisions(session: Session): Decision[] {
    const superseded = new Set(
      session.decisions.map((decision) => decision.supersedes).filter(Boolean)
    );
    return session.decisions.filter((decision) => !superseded.has(decision.id));
  }

  /** Adds a draft plan version. Drafts are never written outside the session. */
  async addPlanVersion(query: SessionQuery, content: PlanContent): Promise<Session> {
    return this.mutate(query, (session) => {
      const version: PlanVersion = {
        version: session.plans.length + 1,
        status: "draft",
        createdAt: new Date().toISOString(),
        content
      };
      return { ...session, plans: [...session.plans, version] };
    });
  }

  /**
   * Approves a plan version — the gate that authorizes writing code.
   *
   * A method call rather than anything inferred from conversation. If approval
   * depended on a model reading sentiment, the most consequential step in the
   * product would rest on the least reliable mechanism in it.
   */
  async approvePlan(query: SessionQuery, version: number): Promise<Session> {
    return this.mutate(query, (session) => ({
      ...session,
      plans: session.plans.map((plan) =>
        plan.version === version
          ? {
              ...plan,
              status: "approved" as const,
              approvedAt: new Date().toISOString()
            }
          : plan
      )
    }));
  }

  async markImplemented(query: SessionQuery, version: number): Promise<Session> {
    return this.mutate(query, (session) => {
      const plan = session.plans.find((candidate) => candidate.version === version);

      if (!plan) {
        throw new Error(`No plan version ${version}`);
      }
      if (plan.status !== "approved") {
        throw new Error(`Plan version ${version} is not approved`);
      }

      return {
        ...session,
        plans: session.plans.map((candidate) =>
          candidate.version === version
            ? { ...candidate, implementedAt: new Date().toISOString() }
            : candidate
        )
      };
    });
  }

  /**
   * The plan implementation should apply: the highest **approved** version.
   * A newer draft does not count — that is the point of the approval gate.
   */
  latestApprovedPlan(session: Session): PlanVersion | undefined {
    return [...session.plans]
      .filter((plan) => plan.status === "approved")
      .sort((left, right) => right.version - left.version)[0];
  }

  /** True when an approved plan has not been implemented yet. */
  hasPendingWork(session: Session): boolean {
    const latest = this.latestApprovedPlan(session);
    return Boolean(latest && !latest.implementedAt);
  }

  async captureCheckpoint(
    query: SessionQuery,
    fileHashes: Record<string, string>
  ): Promise<Session> {
    const workspaceRoot = path.resolve(query.workspaceRoot);
    const checkpoint: Checkpoint = {
      capturedAt: new Date().toISOString(),
      gitHead: await readGitHead(workspaceRoot),
      fileHashes
    };
    return this.mutate(query, (session) => ({ ...session, checkpoint }));
  }

  async park(query: SessionQuery, reason: string): Promise<Session> {
    return this.mutate(query, (session) => park(session, reason));
  }

  /** Ends the session. Explicit, like approval — never inferred from "thanks". */
  async end(query: SessionQuery, reason = "finished"): Promise<Session> {
    return this.mutate(query, (session) => ({
      ...session,
      status: "ended" as const,
      endedAt: new Date().toISOString(),
      closedReason: reason
    }));
  }

  private async mutate(
    query: SessionQuery,
    change: (session: Session) => Session
  ): Promise<Session> {
    const workspaceRoot = path.resolve(query.workspaceRoot);
    const session = await this.readActive(workspaceRoot);

    if (!session) {
      throw new Error("No active session in this workspace.");
    }

    const updated = { ...change(session), updatedAt: new Date().toISOString() };
    await this.write(workspaceRoot, updated);
    return updated;
  }

  private async readActive(workspaceRoot: string): Promise<Session | undefined> {
    const all = await this.list({ workspaceRoot });
    return all.find((session) => session.status === "active");
  }

  private async write(workspaceRoot: string, session: Session): Promise<void> {
    const directory = sessionsDirectory(workspaceRoot);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${session.id}.json`),
      `${JSON.stringify(session, null, 2)}\n`,
      "utf8"
    );
  }
}

/**
 * What changed since the checkpoint.
 *
 * Hash comparison rather than git, so it works without a repository. What it
 * cannot do without git is show the lines that changed in a file the plan
 * never quoted — a caller should say so rather than imply a full review.
 */
export function diffCheckpoint(
  checkpoint: Checkpoint,
  currentHashes: Record<string, string>
): CheckpointDiff {
  const added: string[] = [];
  const modified: string[] = [];

  for (const [relativePath, hash] of Object.entries(currentHashes)) {
    const before = checkpoint.fileHashes[relativePath];
    if (before === undefined) added.push(relativePath);
    else if (before !== hash) modified.push(relativePath);
  }

  const deleted = Object.keys(checkpoint.fileHashes).filter(
    (relativePath) => currentHashes[relativePath] === undefined
  );

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort()
  };
}

/**
 * Checks touched paths against the constraints the developer confirmed.
 *
 * This is what a confirmed constraint buys that prompt text cannot: "do not
 * modify InvoiceController" stops being a sentence a model may overlook and
 * becomes a rule with an answer. Constraints carrying no enforcement are
 * reported separately rather than counted as passing.
 */
export function checkConstraints(
  decisions: Decision[],
  touchedPaths: string[]
): ConstraintCheck {
  const violations: ConstraintViolation[] = [];
  const unenforceable: UnenforceableConstraint[] = [];

  for (const decision of decisions.filter((entry) => entry.kind === "constraint")) {
    const forbidden = decision.enforcement?.forbidPaths ?? [];

    if (forbidden.length === 0) {
      unenforceable.push({ decisionId: decision.id, statement: decision.statement });
      continue;
    }

    const breached = touchedPaths.filter((touched) =>
      forbidden.some((forbid) => touched === forbid || touched.startsWith(`${forbid}/`))
    );

    if (breached.length > 0) {
      violations.push({
        decisionId: decision.id,
        statement: decision.statement,
        paths: breached.sort()
      });
    }
  }

  return { violations, unenforceable };
}

function park(session: Session, reason: string): Session {
  return { ...session, status: "parked", closedReason: reason };
}

function describeHead(head: string | undefined): string {
  return head ?? "no git repository";
}

function sessionsDirectory(workspaceRoot: string): string {
  return getArtifactDirectoryPath(workspaceRoot, "sessions");
}

async function readSessionFile(filePath: string): Promise<Session | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Session;
  } catch {
    // A malformed session file must not take down the whole list.
    return undefined;
  }
}

/**
 * Sortable, and readable at a glance in a directory listing — a developer
 * returning to a parked session should recognize it without opening it.
 */
function createSessionId(title: string, isoTimestamp: string): string {
  const stamp = isoTimestamp.replace(/[:.]/g, "-").replace(/Z$/, "");
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "session";
  return `${stamp}-${slug}`;
}
