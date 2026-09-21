import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SessionChangeStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Lines/files changed in the tracked working tree since `sinceIso`.
 *
 * The diff base is the commit that was `HEAD` at `sinceIso`
 * (`git rev-list --before`), not `Session.gitHead`: that field only moves
 * when the branch itself changes (see `readGitHead` in
 * `packages/shared/src/git-head.ts`), so it would read as zero changes for
 * commits landed on the same branch during the session — exactly the case
 * this metric exists to report.
 *
 * Untracked new files are not counted — `git diff` does not see them without
 * `git add` — so this can undercount a session that added whole new files,
 * rather than guess at their size.
 *
 * Returns `undefined` on any failure (no git, no repository, no commit found
 * before `sinceIso` — e.g. a shallow clone whose history does not reach back
 * that far) rather than falling back to an empty-tree diff, which could
 * misreport an entire shallow checkout as newly added.
 */
export async function collectSessionChangeStats(
  repoRoot: string,
  sinceIso: string
): Promise<SessionChangeStats | undefined> {
  try {
    const { stdout: revOut } = await execFileAsync(
      "git",
      ["rev-list", "-1", "--before", sinceIso, "HEAD"],
      { cwd: repoRoot }
    );
    const baseCommit = revOut.trim();

    if (!baseCommit) {
      return undefined;
    }

    const { stdout: statOut } = await execFileAsync(
      "git",
      ["diff", "--shortstat", baseCommit],
      { cwd: repoRoot }
    );

    return parseShortstat(statOut);
  } catch {
    return undefined;
  }
}

function parseShortstat(output: string): SessionChangeStats {
  const filesMatch = output.match(/(\d+) files? changed/);
  const addedMatch = output.match(/(\d+) insertions?\(\+\)/);
  const removedMatch = output.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    linesAdded: addedMatch ? Number(addedMatch[1]) : 0,
    linesRemoved: removedMatch ? Number(removedMatch[1]) : 0
  };
}
