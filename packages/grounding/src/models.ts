/**
 * Verifying a model's claims about a repository against what is actually
 * indexed.
 *
 * The failure this exists for is not bad code — reviewers catch bad code. It
 * is the confident wrong answer: a class described by a name it no longer has,
 * a file cited that does not exist, a call asserted between two things that
 * never touch. None of those look wrong on the page, which is what makes them
 * expensive.
 *
 * The design constraint is precision, not recall. A false "unverified" on
 * something real teaches a developer to ignore the warnings, and a warning
 * nobody reads is worse than no warning. So this checks only what it can check
 * confidently, and says what it did not check.
 */

export type ClaimKind = "file" | "citation" | "symbol" | "relation";

export interface Claim {
  kind: ClaimKind;
  /** The text as the model wrote it, for quoting back. */
  text: string;
  /** File path, for `file`, `citation` and `symbol` claims. */
  path?: string;
  /** Line number, for a `file:line` citation. */
  line?: number;
  /** Symbol name, for `symbol` and `relation` claims. */
  symbol?: string;
  /** The other end of a `relation` claim. */
  target?: string;
}

export type ClaimStatus = "verified" | "unverified";

export interface ClaimResult {
  claim: Claim;
  status: ClaimStatus;
  /** Why it did not verify, in terms a developer can act on. */
  reason?: string;
}

export interface GroundingReport {
  /** Claims that resolved against the index or symbol graph. */
  verified: ClaimResult[];
  /** Claims that did not. Shown to the developer, never silently dropped. */
  unverified: ClaimResult[];
  /**
   * What this pass deliberately did not check, so a clean report is not
   * mistaken for a complete one.
   */
  notChecked: string[];
}

export interface VerifyOptions {
  startPath: string;
  /**
   * Check `A calls B` style claims against the symbol graph. Off by default:
   * the graph is only as current as its last build, and asserting a claim is
   * wrong on stale data is exactly the mistake this module exists to prevent.
   */
  useSymbolGraph?: boolean;
}
