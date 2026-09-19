import { describe, expect, it } from "vitest";

import { ROLE_PROMPTS, renderRolePrompt } from "../packages/agents/src/index.js";

describe("internal roles", () => {
  it("covers exactly the four phases", () => {
    // One door means four roles. Eleven mentions is what produced a report
    // about "the Code Analysis Agent" that had been typed at @architect.
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual([
      "analyze",
      "implement",
      "plan",
      "review"
    ]);
  });

  it("keeps the safety rules the .agent.md templates earned", () => {
    // These were written in response to real failures and must survive the
    // move from generated markdown to internal prompts.
    expect(renderRolePrompt("analyze")).toContain("Zero matches mean the query missed");
    expect(renderRolePrompt("analyze")).toContain(
      "whichever file happens to be open in the editor"
    );
    expect(renderRolePrompt("implement")).toContain(
      "Do not write files outside the workspace root"
    );
    expect(renderRolePrompt("implement")).toContain(
      "a draft, however detailed, is not authorization to write code"
    );
    expect(renderRolePrompt("plan")).toContain(
      "Do not treat silence, a question, or qualified agreement as approval"
    );
    expect(renderRolePrompt("review")).toContain("findings only");
  });

  it("renders purpose, guidance and prohibitions", () => {
    const rendered = renderRolePrompt("plan");

    expect(rendered).toContain("How to work:");
    expect(rendered).toContain("You must not:");
    expect(
      rendered.split("\n").filter((line) => line.startsWith("- ")).length
    ).toBeGreaterThan(3);
  });
});
