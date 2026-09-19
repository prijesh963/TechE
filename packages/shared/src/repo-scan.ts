import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * A single file discovered by the shared repository scanner. Carries only
 * metadata — each consumer decides whether to read text based on its own size
 * and file-type rules, avoiding a one-size-fits-all read policy.
 */
export interface ScannedEntry {
  /** Posix-normalized path relative to the scan root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Lowercased extension including the dot, or "" when there is none. */
  extension: string;
  sizeBytes: number;
  modifiedTimeMs: number;
}

export interface RepoScanOptions {
  /** Honor a root-level `.gitignore` in addition to the built-in ignore set. Default true. */
  respectGitignore?: boolean;
  /** Extra directory/file names to ignore on top of the built-in set. */
  additionalIgnores?: Iterable<string>;
}

/**
 * Directory and file names skipped by every scan. Centralized here so the
 * discovery, indexer, and advanced-analysis walkers cannot drift apart.
 */
export const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".copilot-architect",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".angular",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "vendor",
  ".idea",
  ".vscode",
  ".DS_Store"
]);

export const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  // Documents / archives
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  // JVM bytecode
  ".jar",
  ".class",
  // Native binaries
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".lib",
  ".bin",
  ".elf",
  // WebAssembly
  ".wasm",
  // Python compiled
  ".pyc",
  ".pyo",
  ".pyd",
  // Fonts
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot"
]);

export function isBinaryPath(filePath: string): boolean {
  return BINARY_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Climb from `startPath` to the nearest ancestor containing a `.git` directory.
 * Falls back to the start directory when no Git root is found.
 */
export async function findRepoRoot(startPath: string): Promise<string> {
  const startStats = await stat(startPath);
  let current = startStats.isDirectory() ? startPath : path.dirname(startPath);

  while (true) {
    if (await pathExists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startStats.isDirectory() ? startPath : path.dirname(startPath);
    }

    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the repository once and return every file that survives the built-in
 * ignore set and (optionally) the root `.gitignore`. Symlinks are skipped.
 */
export async function scanRepository(
  root: string,
  options: RepoScanOptions = {}
): Promise<ScannedEntry[]> {
  const ignoredNames = new Set(DEFAULT_IGNORED_NAMES);
  for (const name of options.additionalIgnores ?? []) {
    ignoredNames.add(name);
  }

  const gitignore =
    options.respectGitignore === false
      ? undefined
      : await loadGitignore(path.join(root, ".gitignore"));

  const entries: ScannedEntry[] = [];
  await walk(root, root, ignoredNames, gitignore, entries);
  return entries;
}

async function walk(
  root: string,
  directory: string,
  ignoredNames: Set<string>,
  gitignore: GitignoreMatcher | undefined,
  entries: ScannedEntry[]
): Promise<void> {
  const dirEntries = await readdir(directory, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (ignoredNames.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));

    if (entry.isDirectory()) {
      if (gitignore?.ignores(relativePath, true)) {
        continue;
      }
      await walk(root, absolutePath, ignoredNames, gitignore, entries);
      continue;
    }

    if (!entry.isFile() || gitignore?.ignores(relativePath, false)) {
      continue;
    }

    const fileStats = await stat(absolutePath);
    entries.push({
      relativePath,
      absolutePath,
      extension: path.extname(entry.name).toLowerCase(),
      sizeBytes: fileStats.size,
      modifiedTimeMs: fileStats.mtimeMs
    });
  }
}

// --- Minimal .gitignore support (root-level patterns) ---
//
// Covers the patterns teams actually use to keep build output and secrets out
// of an index: directory names, `*.ext` globs, anchored paths, and negation.
// Nested per-directory .gitignore files are intentionally not honored yet.

interface GitignoreRule {
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

interface GitignoreMatcher {
  ignores(relativePath: string, isDirectory: boolean): boolean;
}

async function loadGitignore(
  gitignorePath: string
): Promise<GitignoreMatcher | undefined> {
  let content: string;
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    return undefined;
  }

  const rules = content
    .split(/\r?\n/)
    .map((line) => compileGitignoreLine(line))
    .filter((rule): rule is GitignoreRule => rule !== undefined);

  if (rules.length === 0) {
    return undefined;
  }

  return {
    ignores(relativePath: string, isDirectory: boolean): boolean {
      let ignored = false;
      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) {
          continue;
        }
        if (rule.regex.test(relativePath)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    }
  };
}

function compileGitignoreLine(rawLine: string): GitignoreRule | undefined {
  // Trim trailing whitespace that is not backslash-escaped.
  const line = rawLine.replace(/((?:[^\\]|^)(?:\\\\)*)\s+$/, "$1");
  if (line.length === 0 || line.startsWith("#")) {
    return undefined;
  }

  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  // Unescape a leading "\#" or "\!".
  pattern = pattern.replace(/^\\(?=[#!])/, "");

  let directoryOnly = false;
  if (pattern.endsWith("/")) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const leadingSlash = pattern.startsWith("/");
  if (leadingSlash) {
    pattern = pattern.slice(1);
  }
  if (pattern.length === 0) {
    return undefined;
  }

  // A separator at the start or middle anchors the pattern to the scan root;
  // otherwise it matches a path segment at any depth.
  const anchored = leadingSlash || pattern.includes("/");
  const body = translateGlob(pattern);
  const prefix = anchored ? "^" : "(?:^|/)";

  return {
    negated,
    directoryOnly,
    regex: new RegExp(`${prefix}${body}$`)
  };
}

function translateGlob(glob: string): string {
  let regex = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        regex += ".*";
        i++;
        if (glob[i + 1] === "/") {
          i++;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if (char === "/") {
      regex += "/";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return regex;
}

/**
 * Files that mark a directory as a project worth treating as a repo.
 *
 * Registering every sub-directory swept `docs/`, `docker/` and `scripts/`
 * into a workspace alongside the eight real services of a Spring microservice
 * project — reported as "12 repos", with documentation ranked against source
 * in every search. A directory earns the name by carrying something that
 * builds.
 */
export const REPO_MARKER_FILES = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "CMakeLists.txt",
  "angular.json"
] as const;

/**
 * Whether a directory looks like a repository.
 *
 * A `.git` directory counts on its own: a checked-out repo is one whatever it
 * builds with, including a docs-only one the developer deliberately cloned.
 */
export async function looksLikeRepo(directory: string): Promise<boolean> {
  for (const marker of [".git", ...REPO_MARKER_FILES]) {
    try {
      await access(path.join(directory, marker));
      return true;
    } catch {
      // Next marker.
    }
  }

  return false;
}
