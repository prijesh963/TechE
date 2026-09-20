import { describe, expect, it } from "vitest";

import {
  extractParsedSymbols,
  PARSED_EXTENSIONS
} from "../packages/indexer/src/tree-sitter-symbols.js";

describe("parsed symbol extraction", () => {
  it("finds Go declarations a pattern list cannot see", async () => {
    // Measured before this existed: a Go file yielded zero symbols. The
    // failure was not silence — grounding checks claims against indexed
    // symbols, so every true statement about a real function came back
    // flagged as unverified. The tool told the developer correct answers
    // were fabrications.
    const source = [
      "package main",
      "",
      "type InvoiceService struct { db *DB }",
      "",
      "func NewInvoiceService(db *DB) *InvoiceService { return nil }",
      "",
      "func (s *InvoiceService) FindAll() ([]Invoice, error) { return nil, nil }"
    ].join("\n");

    const parsed = await extractParsedSymbols("svc.go", source);

    expect(parsed).toBeDefined();
    expect(parsed?.map((symbol) => symbol.name).sort()).toEqual([
      "FindAll",
      "InvoiceService",
      "NewInvoiceService"
    ]);
  });

  it("finds a Go method on its receiver, not just top-level functions", async () => {
    // A receiver method is `field_identifier`, not `identifier`. Missing that
    // node would leave most of a service's surface invisible while still
    // looking like it worked.
    const parsed = await extractParsedSymbols(
      "svc.go",
      "package main\nfunc (s *Repo) Save(i Invoice) error { return nil }"
    );

    expect(parsed?.map((symbol) => symbol.name)).toContain("Save");
  });

  it("finds Rust declarations", async () => {
    const source = [
      "pub struct InvoiceService { db: Db }",
      "pub fn find_all() -> Vec<Invoice> { vec![] }",
      "pub trait Repository { fn save(&self); }",
      "pub enum Status { Open, Paid }"
    ].join("\n");

    const parsed = await extractParsedSymbols("lib.rs", source);

    expect(parsed?.map((symbol) => symbol.name).sort()).toEqual([
      "InvoiceService",
      "Repository",
      "Status",
      "find_all"
    ]);
  });

  it("reports where each declaration starts", async () => {
    // The plan excerpts a window centred on a symbol's line. A symbol without
    // one would quote the top of the file instead of the code being changed,
    // which is a quiet way to make every Go plan useless.
    const parsed = await extractParsedSymbols(
      "svc.go",
      "package main\n\nfunc First() {}\n\nfunc Second() {}"
    );

    expect(parsed?.find((symbol) => symbol.name === "First")?.startLine).toBe(3);
    expect(parsed?.find((symbol) => symbol.name === "Second")?.startLine).toBe(5);
  });

  it("names kinds in the vocabulary the pattern path uses", async () => {
    // A consumer reading `kind` should not be able to tell which path found
    // the symbol.
    const parsed = await extractParsedSymbols(
      "lib.rs",
      "pub struct Ledger {}\npub fn post() {}\npub trait Store {}"
    );
    const kindOf = (name: string) =>
      parsed?.find((symbol) => symbol.name === name)?.kind;

    expect(kindOf("Ledger")).toBe("class");
    expect(kindOf("post")).toBe("function");
    expect(kindOf("Store")).toBe("interface");
  });

  it("declines a language it does not parse, rather than returning nothing", async () => {
    // undefined and [] mean different things to the caller: undefined is "use
    // the pattern list", [] is "parsed, and it declares nothing". Confusing
    // them would silently disable pattern matching for every other language.
    expect(await extractParsedSymbols("svc.py", "class A: pass")).toBeUndefined();
    expect(await extractParsedSymbols("app.ts", "export class A {}")).toBeUndefined();
    expect(await extractParsedSymbols("README.md", "# hi")).toBeUndefined();
  });

  it("returns an empty list for a parsed file that declares nothing", async () => {
    const parsed = await extractParsedSymbols("svc.go", "package main\n");

    expect(parsed).toEqual([]);
  });

  it("survives source it cannot parse", async () => {
    // Indexing a repository must not stop because one file is broken.
    const parsed = await extractParsedSymbols("svc.go", "func ((( {{{ )))");

    expect(Array.isArray(parsed) || parsed === undefined).toBe(true);
  });

  it("covers the languages measured at zero", () => {
    expect(PARSED_EXTENSIONS).toContain(".go");
    expect(PARSED_EXTENSIONS).toContain(".rs");
  });
});
