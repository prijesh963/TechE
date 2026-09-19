/**
 * The work session: one feature, from first question to finished review.
 *
 * Its job is to make a conversation reproducible. Without it, what a developer
 * decided while planning lives only in chat scrollback, gets re-derived by the
 * model on every turn, and drifts. A session records the decisions instead, so
 * a plan can be defended rather than merely remembered.
 */
export interface Session {
  schemaVersion: string;
  id: string;
  /** Workspace, not repo: a feature can legitimately span several repos. */
  workspaceRoot: string;
  title: string;
  status: SessionStatus;
  phase: SessionPhase;
  /**
   * `.git/HEAD` when the session opened. A session belongs to the work on a
   * branch; switching branches parks it rather than letting Tuesday's plan
   * quietly shape Thursday's answer.
   */
  gitHead?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  /** Why the session stopped being active, for a developer who returns to it. */
  closedReason?: string;
  decisions: Decision[];
  plans: PlanVersion[];
  checkpoint?: Checkpoint;
}

/**
 * `parked` is the important one: it means "no longer active" without meaning
 * "gone". A developer pulled onto a production issue mid-plan gets their
 * thinking back, and an abandoned session can never contaminate a later one.
 */
export type SessionStatus = "active" | "parked" | "ended";

export type SessionPhase = "analyze" | "plan" | "implement" | "review";

/**
 * Something the developer settled that the tool would not have chosen itself.
 *
 * Only deviations are recorded — never defaults. If the tool proposed Kafka and
 * the developer said nothing, that is the tool's suggestion, not their decision.
 * Recording defaults would grow the list past the point where anyone reads it,
 * and a confirmation nobody reads is worse than no confirmation at all.
 */
export interface Decision {
  id: string;
  kind: DecisionKind;
  /** What was decided, in the developer's terms. */
  statement: string;
  /** What it was chosen over, when there was a rejected alternative. */
  rejected?: string;
  /** Decision this replaces, so a change of mind keeps its history. */
  supersedes?: string;
  /**
   * Only confirmed decisions are stored. The model proposes; the developer
   * confirms; what lands here is what they agreed to.
   */
  confirmedAt: string;
  /**
   * Present only on a `constraint` the tool can actually check. A constraint
   * without this is still recorded and still shown — it simply cannot be
   * enforced, and `checkConstraints` reports it as unenforceable rather than
   * letting it look protected.
   */
  enforcement?: ConstraintEnforcement;
}

/**
 * - `design` — an approach: Kafka rather than synchronous REST
 * - `scope` — a location: svc-billing rather than svc-orders
 * - `constraint` — a boundary that still binds during implementation
 * - `fact` — a correction to what the tool believes about the repo, such as
 *   "OrderService is deprecated". Session-scoped in v1: it will need saying
 *   again next time, which is a known cost of not guessing when a correction
 *   stops being true.
 */
export type DecisionKind = "design" | "scope" | "constraint" | "fact";

export interface ConstraintEnforcement {
  /**
   * Repo-relative paths that must not be modified. Matched exactly or as a
   * directory prefix — deliberately not globs, because a constraint a
   * developer cannot predict the behaviour of is not one they can rely on.
   */
  forbidPaths?: string[];
}

/**
 * A plan revision. The body is opaque here on purpose: the session owns
 * versioning and approval state, and the planner owns what a plan says.
 */
export interface PlanVersion {
  version: number;
  status: PlanStatus;
  createdAt: string;
  approvedAt?: string;
  implementedAt?: string;
  content: PlanContent;
}

/** `draft` until the developer approves it. Nothing is written from a draft. */
export type PlanStatus = "draft" | "approved";

export type PlanContent = Record<string, unknown>;

/**
 * What the workspace looked like when implementation began, so review can tell
 * this feature's changes from everything else in the tree.
 *
 * Taken from the index's per-file content hashes rather than from git: it costs
 * nothing extra, it covers files git does not track, and it works in a
 * workspace with no repository at all.
 */
export interface Checkpoint {
  capturedAt: string;
  gitHead?: string;
  /** Repo-relative path to content hash, as the index recorded it. */
  fileHashes: Record<string, string>;
}

/** What changed since the checkpoint, split by whether the plan expected it. */
export interface CheckpointDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface ConstraintViolation {
  decisionId: string;
  statement: string;
  /** Paths that breached it. */
  paths: string[];
}

/**
 * Constraints that could not be checked because no enforcement was recorded.
 * Reported alongside violations so a caller can say what it did not verify,
 * rather than implying every constraint was honoured.
 */
export interface UnenforceableConstraint {
  decisionId: string;
  statement: string;
}

export interface ConstraintCheck {
  violations: ConstraintViolation[];
  unenforceable: UnenforceableConstraint[];
}

export interface OpenSessionOptions {
  workspaceRoot: string;
  title: string;
  /** Defaults to `analyze`. */
  phase?: SessionPhase;
}

export interface SessionQuery {
  workspaceRoot: string;
}

/** What {@link SessionService.peek} reports, without changing anything. */
export interface SessionPeek {
  session: Session;
  /**
   * `.git/HEAD` has moved since the session opened. The session is still
   * active here — peeking never parks it. A caller about to act on the
   * session should go through `current()`, which does.
   */
  staleBranch: boolean;
}

export interface RecordDecisionInput {
  kind: DecisionKind;
  statement: string;
  rejected?: string;
  supersedes?: string;
  enforcement?: ConstraintEnforcement;
}
