import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The raw contents of `.git/HEAD`, trimmed — `ref: refs/heads/main` on a
 * branch, or a bare sha when detached. `undefined` when there is no git
 * repository, which is a supported way to work rather than an error.
 *
 * Read directly rather than shelling out to `git`: it is a single small file,
 * costs about a millisecond, and works on a machine where git is not on PATH.
 *
 * Note what this does and does not detect. It changes when the branch changes,
 * and not when a commit lands on the branch you are already on — the ref file
 * moves, HEAD does not. Commits and pulls are caught by file timestamps
 * instead; the two signals are complementary.
 */
export async function readGitHead(repoRoot: string): Promise<string | undefined> {
  try {
    const head = await readFile(path.join(repoRoot, ".git", "HEAD"), "utf8");
    return head.trim() || undefined;
  } catch {
    return undefined;
  }
}
