import { describe, expect, it } from "vitest";

import {
  applyFileEdits,
  describeRefusals,
  parseFileEdits
} from "../packages/planner/src/index.js";

const file = [
  "export class InvoiceService {",
  "  place(invoice: Invoice): void {",
  "    this.ledger.record(invoice);",
  "  }",
  "",
  "  cancel(invoice: Invoice): void {",
  "    this.ledger.record(invoice);",
  "  }",
  "}"
].join("\n");

describe("parseFileEdits", () => {
  it("reads a search/replace block", () => {
    const edits = parseFileEdits(
      [
        "<<<<<<< SEARCH",
        "  place(invoice: Invoice): void {",
        "=======",
        "  place(invoice: Invoice, approver: User): void {",
        ">>>>>>> REPLACE"
      ].join("\n")
    );

    expect(edits).toEqual([
      {
        search: "  place(invoice: Invoice): void {",
        replace: "  place(invoice: Invoice, approver: User): void {"
      }
    ]);
  });

  it("tolerates a label on the SEARCH marker line", () => {
    // Models routinely add "SEARCH:" or "SEARCH (existing)" even when told to
    // leave the marker bare. Requiring an exact line would drop every block
    // in the response over one habit, not just the ones that mismatch.
    const edits = parseFileEdits(
      [
        "<<<<<<< SEARCH:",
        "  place(invoice: Invoice): void {",
        "=======",
        "  place(invoice: Invoice, approver: User): void {",
        ">>>>>>> REPLACE"
      ].join("\n")
    );

    expect(edits).toEqual([
      {
        search: "  place(invoice: Invoice): void {",
        replace: "  place(invoice: Invoice, approver: User): void {"
      }
    ]);
  });

  it("tolerates a label on the ======= divider line", () => {
    const edits = parseFileEdits(
      [
        "<<<<<<< SEARCH",
        "  place(invoice: Invoice): void {",
        "======= (updated)",
        "  place(invoice: Invoice, approver: User): void {",
        ">>>>>>> REPLACE"
      ].join("\n")
    );

    expect(edits).toHaveLength(1);
  });

  it("ignores prose around the blocks", () => {
    // A model that explains itself before answering has still answered.
    const edits = parseFileEdits(
      [
        "I'll add the approver parameter.",
        "",
        "<<<<<<< SEARCH",
        "  place(invoice: Invoice): void {",
        "=======",
        "  place(invoice: Invoice, approver: User): void {",
        ">>>>>>> REPLACE",
        "",
        "That should do it."
      ].join("\n")
    );

    expect(edits).toHaveLength(1);
  });

  it("reads several blocks in order", () => {
    const edits = parseFileEdits(
      [
        "<<<<<<< SEARCH",
        "first",
        "=======",
        "FIRST",
        ">>>>>>> REPLACE",
        "<<<<<<< SEARCH",
        "second",
        "=======",
        "SECOND",
        ">>>>>>> REPLACE"
      ].join("\n")
    );

    expect(edits.map((edit) => edit.search)).toEqual(["first", "second"]);
  });

  it("accepts an empty replacement as a deletion", () => {
    const edits = parseFileEdits(
      ["<<<<<<< SEARCH", "  const unused = 1;", "=======", ">>>>>>> REPLACE"].join("\n")
    );

    expect(edits).toEqual([{ search: "  const unused = 1;", replace: "" }]);
  });

  it("refuses an empty search, which matches nothing it can verify", () => {
    // Inserting at an unspecified position is not an edit this can check, so
    // it is not one it accepts.
    const edits = parseFileEdits(
      ["<<<<<<< SEARCH", "   ", "=======", "something new", ">>>>>>> REPLACE"].join(
        "\n"
      )
    );

    expect(edits).toEqual([]);
  });

  it("finds nothing in a response that has no blocks", () => {
    expect(parseFileEdits("I could not work out what to change.")).toEqual([]);
  });
});

describe("applyFileEdits", () => {
  it("applies an edit that matches exactly once", () => {
    const result = applyFileEdits(file, [
      {
        search: "  place(invoice: Invoice): void {",
        replace: "  place(invoice: Invoice, approver: User): void {"
      }
    ]);

    expect(result.applied).toBe(1);
    expect(result.refused).toEqual([]);
    expect(result.text).toContain("approver: User");
    // Everything else is byte-for-byte what it was — the point of editing
    // rather than rewriting.
    expect(result.text).toContain("  cancel(invoice: Invoice): void {");
  });

  it("refuses an edit whose text is not in the file", () => {
    const result = applyFileEdits(file, [
      { search: "  refund(invoice: Invoice): void {", replace: "  refund(): void {" }
    ]);

    expect(result.text).toBeUndefined();
    expect(result.refused[0].reason).toEqual({ kind: "not-found" });
  });

  it("refuses an edit that matches twice rather than guessing which", () => {
    // The guard that makes this safer than a fuzzy patch: ambiguity is
    // detectable, so it does not have to be resolved silently.
    const result = applyFileEdits(file, [
      {
        search: "    this.ledger.record(invoice);",
        replace: "    this.audit(invoice);"
      }
    ]);

    expect(result.text).toBeUndefined();
    expect(result.refused[0].reason).toEqual({ kind: "ambiguous", occurrences: 2 });
  });

  it("changes nothing at all when one edit of several fails", () => {
    // A file with three of four edits applied is not a partial success — it
    // is a file in a state nobody designed.
    const result = applyFileEdits(file, [
      { search: "export class InvoiceService {", replace: "export class Invoices {" },
      { search: "  refund(): void {}", replace: "  refund(): void { /* */ }" }
    ]);

    expect(result.text).toBeUndefined();
    expect(result.applied).toBe(0);
    expect(result.refused).toHaveLength(1);
  });

  it("lets a later edit quote what an earlier one produced", () => {
    const result = applyFileEdits(file, [
      { search: "export class InvoiceService {", replace: "export class Invoices {" },
      { search: "export class Invoices {", replace: "export class Billing {" }
    ]);

    expect(result.applied).toBe(2);
    expect(result.text).toContain("export class Billing {");
  });

  it("checks ambiguity against the running text, not the original", () => {
    // What matters is whether the edit is ambiguous when it is applied. An
    // earlier edit can create the second occurrence.
    const result = applyFileEdits("alpha\nbeta\n", [
      { search: "beta", replace: "alpha" },
      { search: "alpha", replace: "gamma" }
    ]);

    expect(result.text).toBeUndefined();
    expect(result.refused[0].reason).toEqual({ kind: "ambiguous", occurrences: 2 });
  });

  it("deletes the searched text when the replacement is empty", () => {
    const result = applyFileEdits("keep\nremove me\nkeep\n", [
      { search: "remove me\n", replace: "" }
    ]);

    expect(result.text).toBe("keep\nkeep\n");
  });

  it("treats replacement text literally, including $ patterns", () => {
    // String.replace interprets $& and friends in the replacement. Code
    // containing them would be silently corrupted.
    const result = applyFileEdits("const price = 0;\n", [
      { search: "const price = 0;", replace: "const price = `$${amount}`;" }
    ]);

    expect(result.text).toBe("const price = `$${amount}`;\n");
  });

  it("reports nothing applied when no edits were offered", () => {
    const result = applyFileEdits(file, []);
    expect(result).toEqual({ text: file, refused: [], applied: 0 });
  });
});

describe("describeRefusals", () => {
  it("stays quiet when everything applied", () => {
    expect(describeRefusals([])).toBeUndefined();
  });

  it("says which edit failed and why", () => {
    const summary = describeRefusals([
      { search: "  place(invoice: Invoice): void {", reason: { kind: "not-found" } },
      {
        search: "    this.ledger.record(invoice);",
        reason: { kind: "ambiguous", occurrences: 2 }
      }
    ]);

    expect(summary).toContain("no longer in the file");
    expect(summary).toContain("appears 2 times");
    expect(summary).toContain("place(invoice");
  });

  it("quotes only the opening of a long search", () => {
    const summary = describeRefusals([
      { search: "x".repeat(200), reason: { kind: "not-found" } }
    ]);

    expect(summary!.length).toBeLessThan(120);
    expect(summary).toContain("…");
  });
});
