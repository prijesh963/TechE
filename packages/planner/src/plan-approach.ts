/**
 * What a plan intends to do, as opposed to which files it touches.
 *
 * A draft used to carry a file list, a sentence of reasoning per file, and
 * the code as it stands today. That is enough to see *where* a change lands
 * and nothing at all about *what it is* — so a developer was asked to
 * authorize writing code with no statement of what the code would do. The
 * approval gate is the point the whole design turns on; approving a file list
 * is not approving a change.
 *
 * This is deliberately not the code. The code is produced at `/implement`,
 * where it is diffed against the real files before anything is written.
 * What belongs in a draft is the intent — concrete enough to disagree with,
 * cheap enough to redraft.
 */

const MAX_SUMMARY_LINES = 6;

/** Per file, so one runaway file cannot crowd out the rest of the plan. */
const MAX_INTENTS_PER_FILE = 6;

/** Long enough for a real sentence, short enough to stay a plan. */
const MAX_INTENT_LENGTH = 300;

export interface ParseApproachOptions {
  /**
   * The paths this plan actually proposes to change. An intent naming
   * anything else is dropped: it describes work the plan never selected, so
   * showing it would promise a change nothing is going to make.
   */
  plannedPaths: Set<string>;
}

export interface ParsedApproach {
  /** What the change does overall, a line at a time. */
  summary: string[];
  /** Per planned path, what changes in it. */
  intents: Map<string, string[]>;
}

/**
 * Reads an approach from the model's reply.
 *
 * Pipe-separated records rather than prose, for the same reason outlines are:
 * a heading the model chose is not parseable, and an intent that cannot be
 * attached to a file cannot be rendered next to that file's code.
 *
 * `approach | <line>`     — what the change does overall
 * `step | <path> | <what changes there>`
 */
export function parsePlanApproach(
  text: string,
  options: ParseApproachOptions
): ParsedApproach {
  const summary: string[] = [];
  const intents = new Map<string, string[]>();

  for (const line of text.split("\n")) {
    // Numbering and bullets are what a model reaches for when asked for a
    // list, and stripping them is cheaper than a reply thrown away for it.
    const trimmed = line.trim().replace(/^(?:[-*]|\d+[.)])\s*/, "");
    if (!trimmed) continue;

    const parts = trimmed.split("|").map((part) => part.trim());
    const record = parts[0].toLowerCase();

    if (record === "approach") {
      const value = clean(parts.slice(1).join(" | "));
      if (value && summary.length < MAX_SUMMARY_LINES) {
        summary.push(value);
      }
      continue;
    }

    if (record !== "step") continue;

    const relativePath = parts[1]?.trim();
    // Matched exactly against what was selected — a near-miss path is the
    // model describing a file the plan does not touch, which is worse than
    // silence because it reads as a commitment.
    if (!relativePath || !options.plannedPaths.has(relativePath)) continue;

    const value = clean(parts.slice(2).join(" | "));
    if (!value) continue;

    const existing = intents.get(relativePath) ?? [];
    if (existing.length >= MAX_INTENTS_PER_FILE) continue;

    existing.push(value);
    intents.set(relativePath, existing);
  }

  return { summary, intents };
}

/**
 * Trims one record's text, or rejects it.
 *
 * A record that says nothing — an empty field, a lone dash, a restatement of
 * the word "step" — is dropped rather than rendered, because an empty intent
 * next to a file looks like the file was thought about when it was not.
 */
function clean(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/^[-–—:]\s*/, "")
    .trim();
  if (trimmed.length < 3) return undefined;
  if (/^(step|approach|n\/?a|none|tbd)$/i.test(trimmed)) return undefined;
  return trimmed.length > MAX_INTENT_LENGTH
    ? `${trimmed.slice(0, MAX_INTENT_LENGTH).trimEnd()}…`
    : trimmed;
}
