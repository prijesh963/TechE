import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getArtifactDirectoryPath } from "@copilot-architect/shared";

import type { SearchResult } from "./models.js";

const SEARCH_LOG_FILE_NAME = "search-log.jsonl";
const MAX_LOGGED_QUERY_LENGTH = 200;

interface SearchActivityEntry {
  timestamp: string;
  query: string;
  files: string[];
}

export function getSearchActivityLogPath(repoRoot: string): string {
  return path.join(getArtifactDirectoryPath(repoRoot, "index"), SEARCH_LOG_FILE_NAME);
}

/**
 * One line per `search()` call: which files it actually returned. Read back
 * by the dashboard to report "files referred from the index" as a real count
 * rather than a guess — grounding is the whole point of this tool, and this
 * is the evidence for it. Best-effort and silent on failure: a search result
 * matters more than logging it, so this must never turn a working search
 * into a failed one.
 */
export async function recordSearchActivity(
  repoRoot: string,
  query: string,
  results: SearchResult[]
): Promise<void> {
  try {
    const logPath = getSearchActivityLogPath(repoRoot);
    const entry: SearchActivityEntry = {
      timestamp: new Date().toISOString(),
      query: query.slice(0, MAX_LOGGED_QUERY_LENGTH),
      files: [...new Set(results.map((result) => result.relativePath))]
    };

    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  } catch {
    // Diagnostic, not functional. A logging failure is never a search failure.
  }
}

/**
 * Distinct files and query count returned by search at or after `sinceIso`.
 * Used to report "files referred from the index this session" without
 * re-deriving it from search calls the caller never saw. Degrades to zeros
 * when the log does not exist yet or cannot be read — an unmeasured session,
 * not an error.
 */
export async function readSearchActivitySince(
  repoRoot: string,
  sinceIso: string
): Promise<{ filesReferred: number; searchCount: number }> {
  try {
    const logPath = getSearchActivityLogPath(repoRoot);
    const text = await readFile(logPath, "utf8");
    const since = new Date(sinceIso).getTime();
    const files = new Set<string>();
    let searchCount = 0;

    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      let entry: SearchActivityEntry;
      try {
        entry = JSON.parse(line) as SearchActivityEntry;
      } catch {
        continue;
      }

      if (new Date(entry.timestamp).getTime() < since) {
        continue;
      }

      searchCount += 1;
      for (const file of entry.files) {
        files.add(file);
      }
    }

    return { filesReferred: files.size, searchCount };
  } catch {
    return { filesReferred: 0, searchCount: 0 };
  }
}
