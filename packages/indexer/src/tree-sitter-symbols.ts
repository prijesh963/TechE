import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Symbol extraction by parsing, for languages the regex list cannot see.
 *
 * The index's symbols are what grounding checks a claim against. When a
 * language has no pattern, the failure is not silence — it is confident
 * wrongness: every true statement about a real function comes back flagged as
 * unverified, so the tool tells a developer that correct answers are
 * fabrications. Go and Rust yielded zero symbols per file, measured, which
 * made them worse served than a language with no support at all.
 *
 * Adding another regex was the treadmill this replaces. A grammar knows what
 * a declaration is; a pattern only knows what one usually looks like.
 *
 * Scoped deliberately to Go and Rust. They are the two measured at zero, so
 * every language the regex list already handles keeps exactly the behaviour
 * it has — this adds capability without moving anything that works. The
 * shape below takes another language by adding a row.
 */

/**
 * What to capture, per language.
 *
 * The capture name is the symbol kind, so it uses the same vocabulary the
 * pattern path produces — `class`, `interface`, `function`. A consumer
 * reading `kind` cannot tell which path found the symbol, which is the point.
 */
interface GrammarSpec {
  /** File in `tree-sitter-wasms/out`, without the extension. */
  wasm: string;
  /** Tree-sitter query. Every `@name` capture becomes a symbol. */
  query: string;
}

const GRAMMARS: Record<string, GrammarSpec> = {
  ".go": {
    wasm: "tree-sitter-go",
    // Methods carry `field_identifier`, not `identifier` — a receiver method
    // is the common shape in Go and missing it would leave most of a
    // service's surface invisible.
    query: `
      (function_declaration name: (identifier) @function)
      (method_declaration name: (field_identifier) @function)
      (type_spec name: (type_identifier) @class)
    `
  },
  ".rs": {
    wasm: "tree-sitter-rust",
    query: `
      (function_item name: (identifier) @function)
      (struct_item name: (type_identifier) @class)
      (enum_item name: (type_identifier) @class)
      (trait_item name: (type_identifier) @interface)
      (mod_item name: (identifier) @class)
    `
  }
};

/** Languages this module can parse, for callers that want to report it. */
export const PARSED_EXTENSIONS = Object.keys(GRAMMARS);

interface LoadedLanguage {
  language: unknown;
  query: unknown;
}

// Parsing is opt-in per file extension and the runtime is several megabytes,
// so nothing is loaded until a file actually needs it. Once loaded it is kept:
// an index pass hits the same few languages thousands of times.
let parserModule: unknown;
let initFailed = false;
const loaded = new Map<string, LoadedLanguage | undefined>();

/**
 * Where the grammar files are.
 *
 * Three places, in order: an explicit override, next to the running bundle
 * (how the packaged CLI ships them), then `node_modules` (how a clone runs).
 * Returning undefined is not an error — the caller falls back to the regex
 * list, which is why an environment without grammars still indexes.
 */
function resolveGrammarDir(): string | undefined {
  const override = process.env.COPILOT_ARCHITECT_GRAMMAR_DIR;
  if (override && existsSync(override)) {
    return override;
  }

  const beside = path.join(getModuleDir(), "grammars");
  if (existsSync(beside)) {
    return beside;
  }

  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("tree-sitter-wasms/out/tree-sitter-go.wasm"));
  } catch {
    return undefined;
  }
}

/**
 * Where the tree-sitter runtime's own wasm is.
 *
 * Beside the grammars when packaged; inside `web-tree-sitter` when running
 * from a clone. Falling back to the grammar directory keeps the failure a
 * missing file the caller already handles, rather than a throw.
 */
function locateRuntimeFile(grammarDir: string, file: string): string {
  const beside = path.join(grammarDir, file);
  if (existsSync(beside)) {
    return beside;
  }

  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve("web-tree-sitter")), file);
  } catch {
    return beside;
  }
}

function getModuleDir(): string {
  try {
    return fileURLToPath(new URL(".", import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Loads the grammar for one extension, or reports that there is none.
 *
 * Every failure path returns undefined rather than throwing. Indexing a
 * repository must not stop because a grammar file is missing or a runtime
 * refuses to initialise — the worst acceptable outcome is the symbols this
 * file had before parsing existed.
 */
async function loadLanguage(extension: string): Promise<LoadedLanguage | undefined> {
  if (loaded.has(extension)) {
    return loaded.get(extension);
  }

  const spec = GRAMMARS[extension];
  if (!spec || initFailed) {
    return undefined;
  }

  try {
    const dir = resolveGrammarDir();
    if (!dir) {
      initFailed = true;
      return undefined;
    }

    if (!parserModule) {
      const mod = (await import("web-tree-sitter")) as { default?: unknown };
      parserModule = mod.default ?? mod;

      // The runtime loads its own `tree-sitter.wasm` relative to the script
      // that imported it. Bundled into one file by esbuild, that path no
      // longer exists, so it is told where to look instead.
      //
      // Two places, because the two layouts differ: the package ships the
      // runtime beside the grammars, while `node_modules` keeps it in
      // `web-tree-sitter/` and the grammars somewhere else entirely. Pointing
      // only at the grammar directory fixes the packaged extension and breaks
      // every development run, which is how this was found.
      await (
        parserModule as {
          init(options?: { locateFile?: (file: string) => string }): Promise<void>;
        }
      ).init({
        locateFile: (file: string) => locateRuntimeFile(dir, file)
      });
    }

    const file = path.join(dir, `${spec.wasm}.wasm`);
    if (!existsSync(file)) {
      loaded.set(extension, undefined);
      return undefined;
    }

    const LanguageCtor = (
      parserModule as { Language: { load(p: string): Promise<unknown> } }
    ).Language;
    const language = await LanguageCtor.load(file);
    const query = (language as { query(source: string): unknown }).query(spec.query);
    const entry = { language, query };
    loaded.set(extension, entry);
    return entry;
  } catch {
    // One failure disables parsing for the run rather than paying the cost on
    // every file: a runtime that cannot start will not start for the next one.
    initFailed = true;
    loaded.set(extension, undefined);
    return undefined;
  }
}

/** One declaration a grammar found, with where it starts. */
export interface ParsedSymbol {
  name: string;
  kind: string;
  /** 1-based, to match what the pattern path reports. */
  startLine: number;
}

/**
 * Declarations in this file, or undefined when it is not a language this
 * module parses.
 *
 * Undefined and an empty array mean different things, and the caller depends
 * on it: undefined is "use the pattern list", `[]` is "parsed, and it
 * declares nothing".
 *
 * `startLine` is carried, not dropped. A plan excerpts a window centred on a
 * symbol's line, so a symbol without one would quote the top of the file
 * instead of the code the change is about.
 */
export async function extractParsedSymbols(
  relativePath: string,
  text: string
): Promise<ParsedSymbol[] | undefined> {
  const extension = path.extname(relativePath).toLowerCase();
  if (!GRAMMARS[extension]) {
    return undefined;
  }

  const entry = await loadLanguage(extension);
  if (!entry) {
    return undefined;
  }

  try {
    const ParserCtor = parserModule as new () => {
      setLanguage(language: unknown): void;
      parse(input: string): { rootNode: unknown };
      delete(): void;
    };
    const parser = new ParserCtor();
    parser.setLanguage(entry.language);
    const tree = parser.parse(text);

    const captures = (
      entry.query as {
        captures(node: unknown): {
          name: string;
          node: { text: string; startPosition: { row: number } };
        }[];
      }
    ).captures(tree.rootNode);

    const found: ParsedSymbol[] = [];
    const seen = new Set<string>();

    for (const capture of captures) {
      const name = capture.node.text;
      if (!name) continue;

      // Keyed by name and line: the same name can legitimately appear twice
      // in a file (a method on two types), and both are worth indexing.
      const key = `${name}:${capture.node.startPosition.row}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        name,
        kind: capture.name,
        startLine: capture.node.startPosition.row + 1
      });
    }

    parser.delete();
    return found;
  } catch {
    // A file the grammar cannot parse yields nothing from parsing, and the
    // caller falls back — an unparseable file is not a reason to index none.
    return undefined;
  }
}
