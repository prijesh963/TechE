import { renderRolePrompt } from "@copilot-architect/agents";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts for the four phases, so a developer gets a real slash command
 * — `/mcp.copilot-architect.create-plan`, and so on — instead of relying on
 * Copilot's own reasoning to decide, on its own, that a tool in this server
 * is relevant. A tool is only ever called when the client's model chooses
 * to; a prompt is what makes invoking a phase deterministic the way
 * `/create-plan` is in the VS Code extension.
 *
 * Each prompt inserts one user-role message: the same role guidance
 * `renderRolePrompt` gives the extension's own model calls, followed by
 * which tools to call, in what order, and — for create-plan and implement
 * — the exact contract those tools expect. The message is text a model
 * reads and acts on in its own next turn; nothing here calls a tool itself.
 */
export function registerCopilotArchitectPrompts(server: McpServer): void {
  server.registerPrompt(
    "analyze",
    {
      title: "Analyze the repo",
      description:
        "Answer a question about this repository, grounded in its real index rather than a guess.",
      argsSchema: { question: z.string() }
    },
    ({ question }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              renderRolePrompt("analyze"),
              "",
              `Question: ${question}`,
              "",
              "Call list_repo_files and/or search_repo — and get_symbol_graph if " +
                "it would help — to find what actually answers this before " +
                "writing anything. Cite `file:line` for every claim about the " +
                "code.",
              "",
              "Before your final answer, call verify_claims with that answer's " +
                "text, and add a line naming anything it could not verify " +
                "rather than presenting it as checked."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "create-plan",
    {
      title: "Draft a plan",
      description:
        "Draft a plan contract for a feature request, for the developer to approve before anything is written.",
      argsSchema: { request: z.string() }
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              renderRolePrompt("plan"),
              "",
              `Request: ${request}`,
              "",
              "1. Call search_repo — and get_symbol_graph if it would help — to " +
                "find candidate files. Being related is not a reason to change " +
                "a file: leave out a test, doc, or config that merely mentions " +
                "the subject.",
              "2. Decide which files actually need to change. For each: a kind " +
                "(add/update/delete), a reason, and — for update/delete — one " +
                "symbol in that file your reason rests on. It will be checked " +
                "against the index, so cite one that is actually declared " +
                "there rather than leaving it out to avoid being wrong.",
              "3. Call draft_plan_contract with { request, files: [{path, " +
                "kind, reason, symbol?, steps?}], approach? }. Read back its " +
                "`dropped` and `evidence` fields and tell the developer about " +
                "both in your reply — a dropped file or an unverified reason " +
                "is not something to hide.",
              "4. Show the developer the draft: what each file is for, what " +
                "happens to it, and the version number draft_plan_contract " +
                "returned. Do not call approve_plan_contract in this turn.",
              "5. Only when the developer clearly says to approve it — not " +
                "silence, not a question, not qualified agreement — call " +
                "approve_plan_contract with that version. If they give " +
                "feedback instead, call draft_plan_contract again with the " +
                "revised selection; this drafts a new version rather than " +
                "overwriting the one before it."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "implement",
    {
      title: "Implement the approved plan",
      description:
        "Apply the currently approved plan contract, one file at a time, via apply_plan_edit."
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              renderRolePrompt("implement"),
              "",
              "This phase edits by quoting what to replace, not by returning " +
                "whole files: apply_plan_edit takes { search, replace } pairs, " +
                "and every `search` must match the file's current text " +
                "character for character.",
              "",
              "Call get_approved_plan_contract first. If none is approved, " +
                "stop and say so — a draft is not authorization to write code.",
              "",
              'For each change of kind "update": read its `before` excerpt and ' +
                "`rationale`/`intent` steps from the plan, decide the exact " +
                "edits, and call apply_plan_edit with { relativePath, edits: " +
                "[{search, replace}] } for that one file. If it refuses — the " +
                "search text is not found, or is ambiguous — the reason tells " +
                "you why; pick a more specific search from the actual file " +
                "text and retry rather than guessing again blindly.",
              "",
              'For "add" and "delete" changes: there is no write tool for ' +
                "either yet. Show the developer the file you would create (or " +
                "name the file that should be deleted) and say a human needs " +
                "to do it — do not attempt it through apply_plan_edit, which " +
                "will only refuse.",
              "",
              "After every update-kind file has been applied or refused with " +
                "a clear reason, tell the developer to run " +
                "/mcp.copilot-architect.review."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "review",
    {
      title: "Review against the plan",
      description:
        "Generate and read back a review report comparing what changed against what the approved plan authorized."
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              renderRolePrompt("review"),
              "",
              "Call generate_review, then read its findings, changedFiles, " +
                "expectedFiles/unexpectedFiles, and validation status from the " +
                "result.",
              "",
              "For each finding: name the file, the line where there is one, " +
                "the severity, and a specific remediation. Separate what " +
                "blocks a merge from what is worth a follow-up.",
              "",
              "A file the plan named that never changed, and a file that " +
                "changed but the plan never named, are both worth saying " +
                "explicitly — the second is exactly what a review reading " +
                "only the plan would miss.",
              "",
              "If the developer wants to accept or decline a specific " +
                "finding, call resolve_review_finding with that decision and " +
                "a reason — required for both, since it is the audit trail."
            ].join("\n")
          }
        }
      ]
    })
  );
}
