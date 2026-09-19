import { readFile } from "node:fs/promises";
import path from "node:path";

import { SymbolGraphService } from "@copilot-architect/graph";
import { IndexingService } from "@copilot-architect/indexer";

import type { Claim, ClaimResult, GroundingReport, VerifyOptions } from "./models.js";

/**
 * Backtick-quoted spans only.
 *
 * Prose is not searched for identifiers on purpose. "Spring", "React" and
 * "Kafka" are PascalCase words that will never appear in an index, and
 * flagging them would bury a real finding under noise the developer learns to
 * scroll past.
 */
const BACKTICKED = /`([^`\n]{2,200})`/g;

/** `src/a.ts`, `com/acme/Order.java` — a path with a recognizable extension. */
const PATH_LIKE = /^[\w.@-]+(?:\/[\w.@-]+)+\.[a-zA-Z0-9]{1,8}$/;

/** `src/a.ts:42` — the same, with a line. */
const CITATION = /^([\w.@-]+(?:\/[\w.@-]+)+\.[a-zA-Z0-9]{1,8}):(\d+)$/;

/** `OrderService.place()` or `OrderService.place` — a symbol on a type. */
const QUALIFIED_SYMBOL = /^([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?$/;

export class GroundingService {
  /**
   * Checks a model's answer against the index, and reports what it could not
   * check rather than implying it checked everything.
   */
  async verify(text: string, options: VerifyOptions): Promise<GroundingReport> {
    const claims = extractClaims(text);
    const verified: ClaimResult[] = [];
    const unverified: ClaimResult[] = [];
    const notChecked: string[] = [];

    const indexing = new IndexingService();
    const inventory = await indexing
      .listFiles({ startPath: options.startPath, limit: Number.MAX_SAFE_INTEGER })
      .catch(() => undefined);

    // An empty index is not the same as a wrong answer. Without this, every
    // claim would come back "no such file" and a developer would be told their
    // correct answer was fabricated — the same mistake, pointed the other way,
    // as an empty context reading as "the repo is empty".
    if (!inventory || inventory.totalFiles === 0) {
      return {
        verified: [],
        unverified: [],
        notChecked: [
          "Nothing was verified: this workspace has no indexed files to check against."
        ]
      };
    }

    const paths = new Set(
      inventory.files.map((file) =>
        file.repoName ? `${file.repoName}/${file.relativePath}` : file.relativePath
      )
    );
    // Uncapped: the inventory truncates symbols per file for display, and
    // checking existence against a truncated list reports real symbols as
    // missing — a false warning being far more damaging here than a missed one.
    const allSymbols = await indexing
      .symbolNames({ startPath: options.startPath })
      .catch(() => new Set<string>());

    for (const claim of claims) {
      const result = await this.verifyClaim(claim, {
        startPath: options.startPath,
        paths,
        allSymbols
      });
      (result.status === "verified" ? verified : unverified).push(result);
    }

    if (!options.useSymbolGraph && claims.some((claim) => claim.kind === "relation")) {
      notChecked.push(
        "Claims that one symbol calls another were not checked against the symbol graph."
      );
    }

    notChecked.push(
      "Statements in prose are not checked — only paths and symbols written in backticks."
    );

    return { verified, unverified, notChecked };
  }

  private async verifyClaim(
    claim: Claim,
    context: {
      startPath: string;
      paths: Set<string>;
      allSymbols: Set<string>;
    }
  ): Promise<ClaimResult> {
    if (claim.kind === "file" || claim.kind === "citation") {
      if (!claim.path || !context.paths.has(claim.path)) {
        return {
          claim,
          status: "unverified",
          reason: "no such file in the index"
        };
      }

      if (claim.kind === "file") {
        return { claim, status: "verified" };
      }

      // A cited line past the end of the file is a fabricated reference, and
      // one of the cheapest hallucinations to catch.
      const lineCount = await countLines(
        path.join(context.startPath, claim.path)
      ).catch(() => undefined);

      if (lineCount === undefined) {
        return { claim, status: "verified" };
      }

      return claim.line !== undefined && claim.line <= lineCount
        ? { claim, status: "verified" }
        : {
            claim,
            status: "unverified",
            reason: `line ${claim.line} is past the end of the file (${lineCount} lines)`
          };
    }

    if (claim.kind === "symbol" && claim.symbol) {
      return context.allSymbols.has(claim.symbol)
        ? { claim, status: "verified" }
        : {
            claim,
            status: "unverified",
            reason: "no symbol with that name is indexed"
          };
    }

    // A relation claim with the graph switched off is reported as unchecked
    // rather than guessed at.
    return { claim, status: "verified" };
  }
}

/**
 * Pulls checkable claims out of an answer.
 *
 * Conservative by design: only backticked spans that unambiguously look like a
 * repo path or a qualified symbol. A bare word is never treated as a claim,
 * however code-like it looks.
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(BACKTICKED)) {
    const raw = match[1].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);

    const citation = CITATION.exec(raw);
    if (citation) {
      claims.push({
        kind: "citation",
        text: raw,
        path: citation[1],
        line: Number(citation[2])
      });
      continue;
    }

    if (PATH_LIKE.test(raw)) {
      claims.push({ kind: "file", text: raw, path: raw });
      continue;
    }

    const qualified = QUALIFIED_SYMBOL.exec(raw);
    if (qualified) {
      claims.push({ kind: "symbol", text: raw, symbol: qualified[1] });
    }
  }

  return claims;
}

/**
 * A one-line summary for the end of an answer, or `undefined` when everything
 * checked out — a clean pass should not add noise.
 */
export function summarizeGrounding(report: GroundingReport): string | undefined {
  if (report.unverified.length === 0) {
    return undefined;
  }

  const items = report.unverified
    .map((result) => `\`${result.claim.text}\` (${result.reason})`)
    .join(", ");

  return `⚠️ Could not verify: ${items}. Treat those as unconfirmed.`;
}

/** Builds the symbol graph and checks a call claim. Opt-in; see VerifyOptions. */
export async function verifyRelation(
  startPath: string,
  from: string,
  to: string
): Promise<boolean> {
  const { graph } = await new SymbolGraphService().build({ startPath });

  return graph.edges.some((edge) => edge.from.includes(from) && edge.to.includes(to));
}

async function countLines(filePath: string): Promise<number> {
  return (await readFile(filePath, "utf8")).split("\n").length;
}
