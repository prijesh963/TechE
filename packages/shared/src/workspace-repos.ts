import { readFile } from "node:fs/promises";
import path from "node:path";

export interface RegisteredRepo {
  name: string;
  path: string;
  role?: string;
  repoRoot: string;
}

/**
 * The repos a start path should answer for, or `[]` when it is a plain single
 * repo so callers keep their existing single-repo behavior unchanged.
 *
 * A workspace root holds registration, not code: its own artifacts cover little
 * more than `workspace.json`. Reading only that root is what made agents report
 * an empty repository on a perfectly well-indexed multi-repo workspace, so
 * every read path that resolves a repo should consult this first.
 *
 * Reads `workspace.json` directly rather than going through `WorkspaceService`,
 * whose `show()` initializes and WRITES a workspace when none exists — a read
 * path must never have that side effect.
 */
export async function resolveRegisteredRepos(
  rootPath: string
): Promise<RegisteredRepo[]> {
  let parsed: { repos?: Array<{ name?: string; path?: string; role?: string }> };

  try {
    parsed = JSON.parse(
      await readFile(
        path.join(rootPath, ".copilot-architect", "workspace.json"),
        "utf8"
      )
    );
  } catch {
    return [];
  }

  const repos = (parsed.repos ?? [])
    .filter((repo) => typeof repo.path === "string" && repo.path.length > 0)
    .map((repo) => {
      const repoRoot = path.resolve(rootPath, repo.path as string);
      return {
        name: repo.name ?? path.basename(repoRoot),
        path: repo.path as string,
        role: repo.role,
        repoRoot
      };
    });

  // A workspace that only registers itself is just a repo — no fan-out needed.
  return repos.some((repo) => repo.repoRoot !== rootPath) ? repos : [];
}
