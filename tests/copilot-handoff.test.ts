import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildCopilotPanelHtml,
  parseCopilotArgs,
  runCopilotCommand
} from "../packages/cli/src/copilot-command.js";
import { runCli } from "../packages/cli/src/index.js";
import {
  IndexingService,
  resetIndexFreshnessCache
} from "../packages/indexer/src/index.js";
import {
  CopilotHandoffService,
  readApprovedPlan
} from "../packages/planner/src/index.js";
import { SessionService } from "../packages/session/src/index.js";

const REQUEST = "Add an approval step for invoices over 10000";

/** A Copilot reply as it arrives: prose around a fenced block of records. */
const REPLY = [
  "Here is the plan:",
  "",
  "```",
  "update | src/invoices.ts | approveInvoice must enforce the threshold first | approveInvoice",
  "add | src/approvalPolicy.ts | holds the second-approver rule |",
  "update | src/ghost.ts | a file the index does not have | Ghost",
  "update | src/server.ts | the route passes the approver through | NotARealSymbol",
  "approach | Invoices above 10000 need a second approver before they are approved.",
  "step | src/invoices.ts | call requiresSecondApprover from approveInvoice",
  "step | src/ghost.ts | describes a file the plan never selected",
  "file | src/approvalPolicy.ts | src/invoices.ts | 30",
  "export | src/approvalPolicy.ts | requiresSecondApprover | requiresSecondApprover(amount: number): boolean | true above 10000",
  "```",
  "",
  "Want me to change anything?"
].join("\n");

let workspaceRoot: string;

beforeEach(async () => {
  resetIndexFreshnessCache();
  workspaceRoot = await createRepo({
    "package.json": JSON.stringify({ name: "invoices", scripts: { test: "vitest" } }),
    "src/invoices.ts":
      "export function approveInvoice(invoiceId: string) {\n  return { invoiceId, status: 'approved' };\n}\n",
    "src/server.ts":
      "import { approveInvoice } from './invoices';\nexport function approveRoute(id: string) {\n  return approveInvoice(id);\n}\n"
  });
  await new IndexingService().index({ startPath: workspaceRoot });
});

describe("CopilotHandoffService.askPrompt", () => {
  it("quotes the files the index finds, with line numbers, under the analyze role", async () => {
    const result = await new CopilotHandoffService().askPrompt({
      workspaceRoot,
      question: "where is approveInvoice"
    });

    expect(result.kind).toBe("ask");
    expect(result.files).toContain("src/invoices.ts");
    expect(result.prompt).toContain("--- src/invoices.ts (lines 1–");
    expect(result.prompt).toContain("export function approveInvoice");
    expect(result.prompt).toContain("Explain what is actually in this repository");
    expect(result.prompt).toContain("where is approveInvoice");
  });

  it("refuses an empty question rather than sending Copilot nothing to answer", async () => {
    await expect(
      new CopilotHandoffService().askPrompt({ workspaceRoot, question: "   " })
    ).rejects.toThrow("Type a question first.");
  });

  it("says the index found nothing instead of handing over an ungrounded prompt", async () => {
    await expect(
      new CopilotHandoffService().askPrompt({
        workspaceRoot,
        question: "kubernetes helm chart"
      })
    ).rejects.toThrow("The index found nothing");
  });
});

describe("CopilotHandoffService plan → import → approve → implement", () => {
  it("asks for all three record kinds in one prompt, listing the candidates", async () => {
    const result = await new CopilotHandoffService().planPrompt({
      workspaceRoot,
      request: REQUEST
    });

    expect(result.prompt).toContain("src/invoices.ts — declares approveInvoice");
    expect(result.prompt).toContain(
      "kind | repo-relative path | why this file changes"
    );
    expect(result.prompt).toContain("approach | one line");
    expect(result.prompt).toContain("file | path | repo files it imports");
    expect(result.prompt).toContain("Do not write any code yet.");
  });

  it("imports a pasted reply into the same plan contract /create-plan produces", async () => {
    const service = new CopilotHandoffService();
    await service.planPrompt({ workspaceRoot, request: REQUEST });

    const imported = await service.importPlan({ workspaceRoot, response: REPLY });

    expect(imported.version).toBe(1);
    // The invented file is dropped; the add and the real updates survive.
    expect(imported.plan.changes.map((change) => change.relativePath)).toEqual([
      "src/invoices.ts",
      "src/approvalPolicy.ts",
      "src/server.ts"
    ]);
    // Snapshots come from disk, never from the reply.
    const invoices = imported.plan.changes[0];
    expect(invoices.before?.text).toContain("export function approveInvoice");
    expect(invoices.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invoices.intent).toEqual([
      "call requiresSecondApprover from approveInvoice"
    ]);
    // A step about a file the plan never selected is not attached anywhere.
    expect(JSON.stringify(imported.plan)).not.toContain(
      "describes a file the plan never selected"
    );
    expect(imported.plan.changes[1].outline?.exports[0].name).toBe(
      "requiresSecondApprover"
    );
    expect(imported.plan.approach).toEqual([
      "Invoices above 10000 need a second approver before they are approved."
    ]);
    // A cited symbol the file does not declare is reported, not hidden.
    expect(imported.unverified).toEqual(["src/server.ts"]);

    const session = await new SessionService().current({ workspaceRoot });
    expect(session?.title).toBe(REQUEST);
    expect(session?.plans).toHaveLength(1);
    expect(session?.plans[0].status).toBe("draft");
  });

  it("records a re-import of the same request as the next version, not a new session", async () => {
    const service = new CopilotHandoffService();
    await service.planPrompt({ workspaceRoot, request: REQUEST });
    await service.importPlan({ workspaceRoot, response: REPLY });

    const second = await service.importPlan({
      workspaceRoot,
      response:
        "update | src/invoices.ts | only the service needs the rule | approveInvoice"
    });

    expect(second.version).toBe(2);
    const session = await new SessionService().current({ workspaceRoot });
    expect(session?.plans.map((plan) => plan.version)).toEqual([1, 2]);
  });

  it("refuses a reply with no plan lines rather than substituting a relevance guess", async () => {
    const service = new CopilotHandoffService();
    await service.planPrompt({ workspaceRoot, request: REQUEST });

    await expect(
      service.importPlan({
        workspaceRoot,
        response: "Sure, I'd be happy to help with that!"
      })
    ).rejects.toThrow("No plan lines were found");
    expect(await new SessionService().current({ workspaceRoot })).toBeUndefined();
  });

  it("refuses an import when no plan prompt was handed out", async () => {
    await expect(
      new CopilotHandoffService().importPlan({ workspaceRoot, response: REPLY })
    ).rejects.toThrow("click Plan first");
  });

  it("will not implement a draft, and approves only the version asked for", async () => {
    const service = new CopilotHandoffService();
    await service.planPrompt({ workspaceRoot, request: REQUEST });
    await service.importPlan({ workspaceRoot, response: REPLY });

    await expect(service.implementPrompt({ workspaceRoot })).rejects.toThrow(
      "There is no approved plan to implement"
    );
    await expect(service.approvePlan({ workspaceRoot, version: 2 })).rejects.toThrow(
      "There is no plan v2"
    );

    const approved = await service.approvePlan({ workspaceRoot, version: 1 });
    expect(approved.version).toBe(1);
    expect((await readApprovedPlan(workspaceRoot))?.version).toBe(1);
    await expect(service.approvePlan({ workspaceRoot, version: 1 })).rejects.toThrow(
      "already approved"
    );

    const implement = await service.implementPrompt({ workspaceRoot });
    expect(implement.prompt).toContain("Implement this approved plan (v1)");
    expect(implement.prompt).toContain(
      "- update src/invoices.ts — approveInvoice must enforce"
    );
    expect(implement.prompt).toContain(
      "    - call requiresSecondApprover from approveInvoice"
    );
    expect(implement.prompt).toContain("change these and no others");
    // No repo-map (the fixture was never analyzed), so the plan commits to no
    // checks — and the prompt does not invent one.
    expect(implement.prompt).not.toContain("When done, run");
  });

  it("refuses to implement once a planned file has changed since the plan quoted it", async () => {
    const service = new CopilotHandoffService();
    await service.planPrompt({ workspaceRoot, request: REQUEST });
    await service.importPlan({ workspaceRoot, response: REPLY });
    await service.approvePlan({ workspaceRoot, version: 1 });

    await writeFile(
      path.join(workspaceRoot, "src/invoices.ts"),
      "export const changed = true;\n",
      "utf8"
    );

    await expect(service.implementPrompt({ workspaceRoot })).rejects.toThrow(
      "These files changed after plan v1 was made: src/invoices.ts"
    );
  });

  it("reports the workflow state without opening or changing a session", async () => {
    const service = new CopilotHandoffService();
    expect(await service.state({ workspaceRoot })).toEqual({});

    await service.planPrompt({ workspaceRoot, request: REQUEST });
    expect(await service.state({ workspaceRoot })).toEqual({ pendingRequest: REQUEST });
    expect(await new SessionService().current({ workspaceRoot })).toBeUndefined();

    await service.importPlan({ workspaceRoot, response: REPLY });
    await service.approvePlan({ workspaceRoot, version: 1 });
    const state = await service.state({ workspaceRoot });
    expect(state.pendingRequest).toBeUndefined();
    expect(state.approvedVersion).toBe(1);
    expect(state.latestPlan?.status).toBe("approved");
  });
});

describe("copilot CLI command", () => {
  it("writes the prompt to --prompt-out and prints one line for the developer", async () => {
    const promptOut = path.join(workspaceRoot, "prompt.md");
    const stdout: string[] = [];
    const result = await runCli(
      [
        "copilot",
        "plan",
        "--path",
        workspaceRoot,
        "--text",
        REQUEST,
        "--prompt-out",
        promptOut
      ],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );

    expect(result.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(
      /^Planning prompt ready with \d+ candidate file\(s\)\./
    );
    expect(await readFile(promptOut, "utf8")).toContain(REQUEST);
  });

  it("imports from --response-file and fails with a readable message on stderr", async () => {
    const responseFile = path.join(workspaceRoot, "reply.txt");
    await writeFile(responseFile, REPLY, "utf8");
    await runCopilotCommand({
      subcommand: "plan",
      startPath: workspaceRoot,
      text: REQUEST,
      json: false
    });

    const imported = await runCopilotCommand({
      subcommand: "import",
      startPath: workspaceRoot,
      responseFile,
      json: false
    });
    expect(imported.version).toBe(1);

    const stderr: string[] = [];
    const failed = await runCli(
      ["copilot", "approve", "--path", workspaceRoot, "--version", "9"],
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line)
      }
    );
    expect(failed.exitCode).toBe(1);
    expect(stderr.join("\n")).toBe("There is no plan v9 in the current session.");
  });

  it("rejects unknown subcommands and arguments", () => {
    expect(() => parseCopilotArgs(["deploy"])).toThrow(
      "Unknown copilot subcommand: deploy"
    );
    expect(() => parseCopilotArgs(["ask", "--bogus"])).toThrow(
      "Unknown copilot argument: --bogus"
    );
    expect(() => parseCopilotArgs(["approve", "--version", "0"])).toThrow(
      "Invalid --version value: 0"
    );
  });

  it("renders the Copilot panel into the dashboard, keeping the typed task", async () => {
    const stdout: string[] = [];
    await runCli(
      [
        "dashboard",
        "--path",
        workspaceRoot,
        "--task",
        "a <b> task",
        "--notice",
        "Copied."
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined
      }
    );
    const html = stdout.join("\n");

    expect(html).toContain("Work with Copilot Chat");
    expect(html).toContain(">a &lt;b&gt; task</textarea>");
    expect(html).toContain('<div class="ca-notice">Copied.</div>');
    expect(html).toContain('href="architect-action:copilotAsk" data-input="ca-task"');
    // The existing setup row is still there, unchanged.
    expect(html).toContain('<a href="architect-action:setupRepo">Setup Repo</a>');
    // No `@architect` front door in a host that has none.
    expect(html).not.toContain("@architect");
  });
});

describe("buildCopilotPanelHtml", () => {
  const draft = {
    version: 2,
    status: "draft" as const,
    implemented: false,
    request: REQUEST,
    approach: ["one line"],
    changes: [
      {
        kind: "update" as const,
        path: "src/invoices.ts",
        rationale: "why",
        steps: ["do it"]
      }
    ]
  };

  it("offers Import only while waiting for Copilot's reply", () => {
    const html = buildCopilotPanelHtml({ pendingRequest: REQUEST });
    expect(html).toContain("Waiting for Copilot's plan");
    expect(html).toContain("architect-action:copilotImport");
    expect(html).not.toContain("copilotApprove");
    expect(html).not.toContain("copilotImplement");
  });

  it("offers Approve for the exact draft version shown, and no Implement before approval", () => {
    const html = buildCopilotPanelHtml({ pendingRequest: REQUEST, latestPlan: draft });
    expect(html).toContain('href="architect-action:copilotApprove:2"');
    expect(html).toContain("Import revised plan");
    expect(html).not.toContain("copilotImplement");
  });

  it("offers Implement once a version is approved", () => {
    const html = buildCopilotPanelHtml({
      latestPlan: { ...draft, status: "approved" },
      approvedVersion: 2
    });
    expect(html).toContain("Implement plan v2 with Copilot");
    expect(html).not.toContain("copilotApprove");
  });

  it("escapes everything that came from a model or a developer", () => {
    const html = buildCopilotPanelHtml(
      { latestPlan: { ...draft, approach: ["<script>alert(1)</script>"] } },
      { notice: "<img src=x>", noticeIsError: true }
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain('class="ca-notice error"');
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-handoff-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
