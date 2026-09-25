/**
 * Editing a file by quoting what to replace, rather than rewriting it whole.
 *
 * Asking a model for complete replacement contents has two costs. Every
 * untouched line is paid for twice — once in the prompt, once in the response
 * — and every untouched line is one the model can quietly paraphrase on its
 * way past. The failure that actually bites is neither: it is an answer that
 * runs out partway and silently deletes the rest of the file.
 *
 * Unified diffs do not fix this. They carry line numbers a model gets wrong,
 * and applying them fuzzily is how a patch lands in the wrong place. Quoting
 * the text to be replaced needs no line numbers and, more importantly, can be
 * *verified* before it is applied: text that does not appear, or appears
 * twice, is detectable rather than silently resolved.
 *
 * So nothing here guesses. An edit that does not match exactly once is
 * refused with a reason, and a file whose edits do not all apply is left
 * untouched — a half-edited file is worse than an unedited one, because it
 * compiles about as often and reviews much worse.
 */

export interface FileEdit {
  /** Text that must appear exactly once in the file. */
  search: string;
  /** What replaces it. Empty means the searched text is deleted. */
  replace: string;
}

export type EditRefusalReason =
  | { kind: "not-found" }
  /** The searched text is ambiguous: it appears more than once. */
  | { kind: "ambiguous"; occurrences: number };

export interface EditRefusal {
  /** The text that was searched for, in full. Shortened only for display. */
  search: string;
  reason: EditRefusalReason;
}

export interface EditApplication {
  /** The new contents. Absent when any edit was refused. */
  text?: string;
  refused: EditRefusal[];
  /** How many edits applied. Zero alongside an empty `refused` means none were offered. */
  applied: number;
}

// The rest of the marker line is ignored rather than required to be blank:
// models routinely add a label ("SEARCH:", "SEARCH (existing)") to a marker
// they were told to leave bare, and requiring an exact line breaks every
// block in the response over one habit, not the ones that actually mismatch.
const BLOCK =
  /<{5,9}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9}\s*REPLACE/g;

/** How much of a searched string to quote back when an edit is refused. */
const REFUSAL_EXCERPT = 60;

/**
 * Reads search/replace blocks out of a model response.
 *
 * The fence lengths are loose because models vary them, and text outside the
 * blocks is ignored rather than treated as an error: a model that explains
 * itself before answering has still answered.
 */
export function parseFileEdits(response: string): FileEdit[] {
  const edits: FileEdit[] = [];

  for (const match of response.matchAll(BLOCK)) {
    const search = match[1];

    // An empty search matches everywhere and nowhere useful. Inserting at an
    // unspecified position is not an edit this can verify, so it is not one
    // it accepts.
    if (search.trim().length === 0) continue;

    edits.push({ search, replace: match[2] });
  }

  return edits;
}

/**
 * Applies edits in order, or refuses and changes nothing.
 *
 * Each edit is applied to the result of the previous one, so a later edit can
 * quote text an earlier one produced. Uniqueness is checked against that
 * running text for the same reason: what matters is whether the edit is
 * ambiguous when it is applied, not when it was written.
 */
export function applyFileEdits(original: string, edits: FileEdit[]): EditApplication {
  const refused: EditRefusal[] = [];
  let text = original;
  let applied = 0;

  for (const edit of edits) {
    const occurrences = countOccurrences(text, edit.search);

    if (occurrences === 0) {
      refused.push({ search: edit.search, reason: { kind: "not-found" } });
      continue;
    }

    if (occurrences > 1) {
      refused.push({
        search: edit.search,
        reason: { kind: "ambiguous", occurrences }
      });
      continue;
    }

    text = text.replace(edit.search, () => edit.replace);
    applied += 1;
  }

  // All or nothing per file. A file with three of four edits applied is not a
  // partial success — it is a file in a state nobody designed.
  return refused.length > 0 ? { refused, applied: 0 } : { text, refused: [], applied };
}

/** One line a developer can act on, or `undefined` when everything applied. */
export function describeRefusals(refusals: EditRefusal[]): string | undefined {
  if (refusals.length === 0) {
    return undefined;
  }

  return refusals
    .map((refusal) => {
      const why =
        refusal.reason.kind === "not-found"
          ? "no longer in the file"
          : `appears ${refusal.reason.occurrences} times, so the edit is ambiguous`;
      return `"${excerpt(refusal.search)}" — ${why}`;
    })
    .join("; ");
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);

  while (index !== -1) {
    count += 1;
    if (count > 1) return count;
    index = text.indexOf(search, index + search.length);
  }

  return count;
}

/**
 * The opening of a searched string, for naming which edit failed.
 *
 * Shortening happens here rather than where the refusal is recorded, so the
 * refusal keeps the full text and every caller gets the same bounded display
 * without having to remember to trim it.
 */
function excerpt(value: string): string {
  const firstLine = value.trim().split("\n")[0];
  return firstLine.length > REFUSAL_EXCERPT
    ? `${firstLine.slice(0, REFUSAL_EXCERPT - 1)}…`
    : firstLine;
}
