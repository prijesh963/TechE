import { describe, expect, it } from "vitest";

import { parsePlanApproach } from "../packages/planner/src/index.js";

const plannedPaths = new Set([
  "src/users/UserService.java",
  "src/users/LoginResource.java"
]);

describe("parsePlanApproach", () => {
  it("reads the overall approach and a step per file", () => {
    const approach = parsePlanApproach(
      [
        "approach | Hash passwords on write and verify on login.",
        "approach | Existing rows stay readable via a one-time rewrite.",
        "step | src/users/UserService.java | add hashPassword(String) delegating to BCrypt",
        "step | src/users/LoginResource.java | replace the equals() comparison in authenticate()"
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.summary).toEqual([
      "Hash passwords on write and verify on login.",
      "Existing rows stay readable via a one-time rewrite."
    ]);
    expect(approach.intents.get("src/users/UserService.java")).toEqual([
      "add hashPassword(String) delegating to BCrypt"
    ]);
    expect(approach.intents.get("src/users/LoginResource.java")).toEqual([
      "replace the equals() comparison in authenticate()"
    ]);
  });

  it("keeps several steps for one file, in order", () => {
    const approach = parsePlanApproach(
      [
        "step | src/users/UserService.java | add hashPassword(String)",
        "step | src/users/UserService.java | call it from create()"
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.intents.get("src/users/UserService.java")).toEqual([
      "add hashPassword(String)",
      "call it from create()"
    ]);
  });

  it("drops a step for a file the plan does not touch", () => {
    // An intent that cannot be attached to an approved change is a promise
    // nothing is going to keep, which is worse than saying nothing.
    const approach = parsePlanApproach(
      [
        "step | src/users/UserService.java | add hashPassword(String)",
        "step | src/users/PasswordPolicy.java | add the policy rules"
      ].join("\n"),
      { plannedPaths }
    );

    expect([...approach.intents.keys()]).toEqual(["src/users/UserService.java"]);
  });

  it("keeps a pipe that belongs to the text", () => {
    const approach = parsePlanApproach(
      "step | src/users/UserService.java | guard with a | b before hashing",
      { plannedPaths }
    );

    expect(approach.intents.get("src/users/UserService.java")).toEqual([
      "guard with a | b before hashing"
    ]);
  });

  it("strips bullets and numbering the model adds anyway", () => {
    const approach = parsePlanApproach(
      [
        "- approach | Hash passwords on write.",
        "1. step | src/users/UserService.java | add hashPassword(String)"
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.summary).toEqual(["Hash passwords on write."]);
    expect(approach.intents.get("src/users/UserService.java")).toEqual([
      "add hashPassword(String)"
    ]);
  });

  it("drops records that say nothing", () => {
    const approach = parsePlanApproach(
      [
        "approach |",
        "approach | n/a",
        "step | src/users/UserService.java | ",
        "step | src/users/UserService.java | TBD",
        "step | src/users/LoginResource.java | -"
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.summary).toEqual([]);
    expect(approach.intents.size).toBe(0);
  });

  it("ignores prose around the records", () => {
    const approach = parsePlanApproach(
      [
        "Here is the plan:",
        "",
        "approach | Hash passwords on write.",
        "",
        "Let me know if you want changes."
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.summary).toEqual(["Hash passwords on write."]);
  });

  it("caps the summary and the steps per file", () => {
    const approach = parsePlanApproach(
      [
        ...Array.from({ length: 10 }, (_, i) => `approach | line number ${i}`),
        ...Array.from(
          { length: 10 },
          (_, i) => `step | src/users/UserService.java | edit number ${i}`
        )
      ].join("\n"),
      { plannedPaths }
    );

    expect(approach.summary).toHaveLength(6);
    expect(approach.intents.get("src/users/UserService.java")).toHaveLength(6);
    // The cap keeps the first ones, so a truncated plan is still the plan's
    // own order rather than an arbitrary tail.
    expect(approach.summary[0]).toBe("line number 0");
  });

  it("truncates a step that runs to an essay", () => {
    const long = "x".repeat(400);
    const approach = parsePlanApproach(`step | src/users/UserService.java | ${long}`, {
      plannedPaths
    });

    const step = approach.intents.get("src/users/UserService.java")?.[0] ?? "";
    expect(step.length).toBeLessThanOrEqual(301);
    expect(step.endsWith("…")).toBe(true);
  });

  it("returns nothing for a reply with no records", () => {
    const approach = parsePlanApproach(
      "I would add password hashing to the user service.",
      { plannedPaths }
    );

    expect(approach.summary).toEqual([]);
    expect(approach.intents.size).toBe(0);
  });
});
