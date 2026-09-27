import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionService } from "../packages/session/src/index.js";
import {
  createPlanContract,
  writeApprovedPlan
} from "../packages/planner/src/index.js";

import {
  CopilotChatMcpConfigService,
  createCopilotArchitectMcpServer,
  listCopilotArchitectMcpToolNames
} from "../packages/mcp-server/src/index.js";

const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

describe("Copilot Architect MCP server", () => {
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(servers.map((server) => server.close()));
    clients.length = 0;
    servers.length = 0;
  });

  it("lists all required MCP tools", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const { client } = await createConnectedServer(repoRoot);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(listCopilotArchitectMcpToolNames()));
    expect(names).toEqual(
      expect.arrayContaining([
        "repo_map",
        "get_symbol_graph",
        "workspace_map",
        "search_repo",
        "search_across_repos",
        "analyze_cross_repo_impact",
        "generate_feature_plan",
        "get_validation_commands"
      ])
    );
  });

  it("supports repo_map, search_repo, generate_feature_plan, and validation commands", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: {
          build: "tsc -b",
          test: "vitest run"
        }
      }),
      "src/invoices/invoice-service.ts":
        "export function approveInvoice() { return 'approved invoice'; }",
      "src/invoices/invoice-service.test.ts":
        "test('approved invoice', () => expect(true).toBe(true));"
    });
    const { client } = await createConnectedServer(repoRoot);

    const repoMap = await callJsonTool(client, "repo_map", { path: repoRoot });
    const search = await callJsonTool(client, "search_repo", {
      path: repoRoot,
      query: "invoice",
      limit: 5
    });
    const plan = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });
    const validationCommands = await callJsonTool(client, "get_validation_commands", {
      path: repoRoot
    });

    expect(repoMap.ok).toBe(true);
    expect(repoMap.data.summary.summary).toContain("Detected");
    expect(
      search.data.results.map((result: { relativePath: string }) => result.relativePath)
    ).toContain("src/invoices/invoice-service.ts");
    expect(plan.data.plan.task).toBe("Add invoice approval workflow");
    expect(validationCommands.data.commands.length).toBeGreaterThan(0);
  });

  it("builds the symbol/dependency graph through get_symbol_graph", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice-service.ts":
        "export function approveInvoice() { return 'approved invoice'; }",
      "src/server.ts": [
        "import { approveInvoice } from './invoice-service.js';",
        "",
        "export function approve() {",
        "  return approveInvoice();",
        "}"
      ].join("\n")
    });
    const { client } = await createConnectedServer(repoRoot);

    const graph = await callJsonTool(client, "get_symbol_graph", { path: repoRoot });

    expect(graph.ok).toBe(true);
    expect(graph.data.nodes.map((node: { id: string }) => node.id)).toEqual(
      expect.arrayContaining([
        "src/server.ts#approve",
        "src/invoice-service.ts#approveInvoice"
      ])
    );
    expect(graph.data.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/server.ts#approve",
          to: "src/invoice-service.ts#approveInvoice"
        }
      ])
    );
  });

  it("handles missing latest artifacts gracefully", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "missing-artifacts" })
    });
    const { client } = await createConnectedServer(repoRoot);

    const latest = await callJsonTool(client, "get_latest_review", {
      path: repoRoot
    });

    expect(latest.ok).toBe(true);
    expect(latest.data.missing).toBe(true);
  });

  it("keeps analyze_impact from writing plan artifacts", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoices/invoice-service.ts":
        "export function invoiceStatus() { return 'pending'; }"
    });
    const { client } = await createConnectedServer(repoRoot);

    const impact = await callJsonTool(client, "analyze_impact", {
      path: repoRoot,
      request: "Add invoice approval workflow"
    });
    const latestPlan = await callJsonTool(client, "get_latest_plan", {
      path: repoRoot
    });

    expect(impact.ok).toBe(true);
    expect(impact.data.impactAnalysis.summary).toContain("Likely impact");
    expect(latestPlan.data.missing).toBe(true);
  });

  it("requires approval before generating feature plan artifacts", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "approval-required" }),
      "src/invoice.ts": "export const invoice = 'draft';"
    });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires approved=true");
  });

  it("revises a saved draft plan through revise_feature_plan", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = 'draft';"
    });
    const { client } = await createConnectedServer(repoRoot);

    const created = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });
    const revised = await callJsonTool(client, "revise_feature_plan", {
      path: repoRoot,
      feedback: "Also cover the rejection path.",
      sections: { openQuestions: ["What happens on rejection?"] }
    });

    expect(created.data.plan.revision).toBe(1);
    expect(revised.ok).toBe(true);
    expect(revised.data.plan.id).toBe(created.data.plan.id);
    expect(revised.data.plan.revision).toBe(2);
    expect(revised.data.plan.revisions).toHaveLength(2);
    expect(revised.data.plan.openQuestions).toEqual(["What happens on rejection?"]);
  });

  it("blocks regenerating a feature plan over an existing draft", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = 'draft';"
    });
    const { client } = await createConnectedServer(repoRoot);

    await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });
    const blocked = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow, take two",
      approved: true
    });
    const restarted = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow, take two",
      approved: true,
      restart: true
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("revise_feature_plan");
    expect(restarted.ok).toBe(true);
    expect(restarted.data.plan.revision).toBe(1);
    expect(restarted.data.plan.task).toBe("Add invoice approval workflow, take two");
  });

  it("approves a specific revision through approve_plan and gates handoff on it", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = 'draft';"
    });
    const { client } = await createConnectedServer(repoRoot);

    const created = await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });
    const unapproved = await callJsonTool(client, "get_latest_plan", {
      path: repoRoot
    });
    const approved = await callJsonTool(client, "approve_plan", {
      path: repoRoot,
      planId: created.data.plan.id,
      revision: 1,
      approvedBy: "reviewer@example.test"
    });
    const latestAfterApproval = await callJsonTool(client, "get_latest_plan", {
      path: repoRoot
    });

    expect(unapproved.data.status).toBe("draft");
    expect(approved.ok).toBe(true);
    expect(approved.data.plan.status).toBe("approved");
    expect(approved.data.plan.approval).toMatchObject({
      approvedBy: "reviewer@example.test",
      revision: 1
    });
    expect(latestAfterApproval.data.status).toBe("approved");
  });

  it("requires a revision number to approve a plan", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = 'draft';"
    });
    const { client } = await createConnectedServer(repoRoot);

    await callJsonTool(client, "generate_feature_plan", {
      path: repoRoot,
      request: "Add invoice approval workflow",
      approved: true
    });

    const result = await client.callTool({
      name: "approve_plan",
      arguments: { path: repoRoot, approvedBy: "reviewer" }
    });

    expect(result.isError).toBe(true);
  });

  it("resolves a review finding through resolve_review_finding", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } })
    });
    const { client } = await createConnectedServer(repoRoot);

    const declined = await callJsonTool(client, "resolve_review_finding", {
      path: repoRoot,
      findingId: "finding_abc123",
      decision: "decline",
      reason: "Intentionally out of scope for this change.",
      decidedBy: "reviewer@example.test"
    });
    const accepted = await callJsonTool(client, "resolve_review_finding", {
      path: repoRoot,
      findingId: "finding_def456",
      decision: "accept",
      reason: "Folded into the plan.",
      decidedBy: "reviewer@example.test",
      planRevision: 2
    });

    expect(declined.ok).toBe(true);
    expect(declined.data.status).toBe("declined");
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("accepted");
    expect(accepted.data.disposition.planRevision).toBe(2);
  });

  it("requires a non-empty reason to resolve a review finding", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } })
    });
    const { client } = await createConnectedServer(repoRoot);

    const result = await client.callTool({
      name: "resolve_review_finding",
      arguments: {
        path: repoRoot,
        findingId: "finding_abc123",
        decision: "decline",
        reason: "",
        decidedBy: "reviewer"
      }
    });

    expect(result.isError).toBe(true);
  });

  it("writes a Copilot Chat MCP configuration for VS Code", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "mcp-config" })
    });

    const result = await new CopilotChatMcpConfigService().write({
      startPath: repoRoot
    });
    const configText = await readFile(result.configPath, "utf8");
    const config = JSON.parse(configText);

    expect(result.status).toBe("created");
    expect(config.servers.copilotArchitect.type).toBe("stdio");
    expect(config.servers.copilotArchitect.command).toBe("node");
    expect(config.servers.copilotArchitect.args).toContain("mcp");
    expect(config.servers.copilotArchitect.args).toContain("--path");
    expect(config.servers.copilotArchitect.args).toContain("${workspaceFolder}");
    await access(result.configPath);
  });

  it("supports multi-repo workspace map, search, and cross-repo impact tools", async () => {
    const fixture = await createWorkspaceFixture();
    const { client } = await createConnectedServer(fixture.workspaceRoot);

    const workspaceMap = await callJsonTool(client, "workspace_map", {
      path: fixture.workspaceRoot
    });
    const search = await callJsonTool(client, "search_across_repos", {
      path: fixture.workspaceRoot,
      query: "invoice"
    });
    const impact = await callJsonTool(client, "analyze_cross_repo_impact", {
      path: fixture.workspaceRoot,
      request: "Add invoice approval workflow"
    });

    expect(workspaceMap.ok).toBe(true);
    expect(workspaceMap.data.repoMap.summary.repoCount).toBe(2);
    expect(
      search.data.combinedResults.map((result: { repoName: string }) => result.repoName)
    ).toContain("billing-service");
    expect(
      impact.data.impactedRepos.map((repo: { name: string }) => repo.name)
    ).toContain("billing-service");
  });

  it("answers the single-repo tools for every registered repo", async () => {
    // Regression: only workspace_map / search_across_repos understood a
    // workspace. Every other tool resolved the workspace root, which holds
    // registration rather than code, so agents were told the repo was empty.
    const fixture = await createWorkspaceFixture();
    const { client } = await createConnectedServer(fixture.workspaceRoot);
    const at = { path: fixture.workspaceRoot };

    const inventory = await callJsonTool(client, "list_repo_files", at);
    const search = await callJsonTool(client, "search_repo", {
      ...at,
      query: "invoice"
    });
    const repoMap = await callJsonTool(client, "repo_map", at);
    const testCommands = await callJsonTool(client, "detect_test_commands", at);

    expect(inventory.data.repos.map((repo: { name: string }) => repo.name)).toEqual([
      "customer-api",
      "billing-service"
    ]);
    // The inventory reaches a model as `path|language|kind|symbols` lines, so
    // the repo is the path prefix rather than a field.
    expect(
      (inventory.data.files as string[]).some((line) =>
        line.startsWith("billing-service/")
      )
    ).toBe(true);

    expect(
      search.data.results.map((result: { repoName: string }) => result.repoName)
    ).toContain("billing-service");

    expect(
      repoMap.data.repos.map((repo: { displayName: string }) => repo.displayName)
    ).toEqual(["customer-api", "billing-service"]);
    expect(repoMap.data.summary.repoCount).toBe(2);

    // Every detected command says which repo it runs in — a bare `npm test`
    // list gives a caller no way to run it in the right place.
    for (const command of testCommands.data as Array<{ cwd?: string }>) {
      expect(command.cwd).toBeDefined();
    }
  });
});

describe("the session model over MCP", () => {
  it("reports no session rather than an empty one", async () => {
    // "No session" and "a session with nothing in it" are different states,
    // and a client that cannot tell them apart will report the wrong thing.
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "get_session", {});
    const data = result.data as { session: unknown; reason?: string };

    expect(data.session).toBeNull();
    expect(data.reason).toContain("no active session");
  });

  it("returns the feature, phase, decisions and plan versions", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot: repoRoot, title: "Add invoice approval" });
    await sessions.recordDecision(
      { workspaceRoot: repoRoot },
      { kind: "scope", statement: "Billing service only" }
    );

    const { client } = await createConnectedServer(repoRoot);
    const result = await callJsonTool(client, "get_session", {});
    const data = result.data as {
      session: { title: string; phase: string; decisions: { statement: string }[] };
    };

    expect(data.session.title).toBe("Add invoice approval");
    expect(data.session.phase).toBe("analyze");
    expect(data.session.decisions[0].statement).toBe("Billing service only");
  });

  it("does not park a session just because it was read", async () => {
    // peek, not current. A caller asking what the session is has not asked
    // to end it.
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot: repoRoot, title: "Add invoice approval" });

    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "get_session", {});
    await callJsonTool(client, "get_session", {});

    expect(await sessions.current({ workspaceRoot: repoRoot })).toBeDefined();
  });

  it("says no plan is approved rather than returning an empty one", async () => {
    // An empty plan would read as "approved, changes nothing". Nothing
    // approved means nothing authorizes writing code.
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "get_approved_plan_contract", {});
    const data = result.data as { plan: unknown; reason?: string };

    expect(data.plan).toBeNull();
    expect(data.reason).toContain("no plan has been approved");
  });

  it("verifies claims against the index for a client that is not the extension", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const result = await callJsonTool(client, "verify_claims", {
      text: "The logic is in `src/OrderService.ts`, with a helper in `src/Ghost.ts`."
    });
    const data = result.data as {
      verified: { claim: { text: string } }[];
      unverified: { claim: { text: string } }[];
    };

    expect(data.verified.map((entry) => entry.claim.text)).toEqual([
      "src/OrderService.ts"
    ]);
    expect(data.unverified.map((entry) => entry.claim.text)).toEqual(["src/Ghost.ts"]);
  });
});

describe("draft_plan_contract and approve_plan_contract", () => {
  it("drafts a plan into a new session, verifying cited symbols", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const result = await callJsonTool(client, "draft_plan_contract", {
      request: "Add invoice approval",
      files: [
        {
          path: "src/OrderService.ts",
          kind: "update",
          reason: "this is where an order is placed",
          symbol: "OrderService",
          steps: ["add an approve() method"]
        }
      ]
    });
    const data = result.data as {
      ok: boolean;
      version: number;
      evidence: Array<{ path: string; evidence: string }>;
      plan: { changes: Array<{ relativePath: string; intent?: string[] }> };
    };

    expect(data.ok).toBe(true);
    expect(data.version).toBe(1);
    expect(data.evidence).toEqual([
      { path: "src/OrderService.ts", evidence: "verified" }
    ]);
    expect(data.plan.changes[0].intent).toEqual(["add an approve() method"]);
  });

  it("drops a path outside the index rather than planning against nothing", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const result = await callJsonTool(client, "draft_plan_contract", {
      request: "Add invoice approval",
      files: [
        { path: "src/OrderService.ts", kind: "update", reason: "real file" },
        { path: "src/Ghost.ts", kind: "update", reason: "does not exist" }
      ]
    });
    const data = result.data as {
      ok: boolean;
      plan: { changes: Array<{ relativePath: string }> };
      dropped: Array<{ path: string; reason: string }>;
    };

    expect(data.ok).toBe(true);
    expect(data.plan.changes.map((change) => change.relativePath)).toEqual([
      "src/OrderService.ts"
    ]);
    expect(data.dropped).toEqual([
      { path: "src/Ghost.ts", reason: expect.stringContaining("not in the index") }
    ]);
  });

  it("flags an unverified symbol rather than dropping the file", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const result = await callJsonTool(client, "draft_plan_contract", {
      request: "Add invoice approval",
      files: [
        {
          path: "src/OrderService.ts",
          kind: "update",
          reason: "wrong symbol on purpose",
          symbol: "InvoiceApprover"
        }
      ]
    });
    const data = result.data as {
      ok: boolean;
      plan: { changes: Array<{ relativePath: string }> };
      evidence: Array<{ path: string; evidence: string; reason?: string }>;
    };

    expect(data.ok).toBe(true);
    // Not dropped: the file may still be right even though the reason is not.
    expect(data.plan.changes.map((change) => change.relativePath)).toEqual([
      "src/OrderService.ts"
    ]);
    expect(data.evidence[0].evidence).toBe("unverified");
    expect(data.evidence[0].reason).toContain("InvoiceApprover");
  });

  it("refuses to approve a version that was never drafted", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "approve_plan_contract", {
      version: 1
    });
    const data = result.data as { ok: boolean; reason: string };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain("no active session");
  });

  it("drafts, approves, and applies an edit end to end over MCP", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService {\n  place() {}\n}"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const drafted = await callJsonTool(client, "draft_plan_contract", {
      request: "Add invoice approval",
      files: [
        {
          path: "src/OrderService.ts",
          kind: "update",
          reason: "this is where an order is placed",
          symbol: "OrderService"
        }
      ]
    });
    const draftData = drafted.data as { ok: boolean; version: number };
    expect(draftData.ok).toBe(true);

    const approved = await callJsonTool(client, "approve_plan_contract", {
      version: draftData.version
    });
    expect((approved.data as { ok: boolean }).ok).toBe(true);

    const applied = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/OrderService.ts",
      edits: [{ search: "  place() {}", replace: "  place() { return true; }" }]
    });
    const appliedData = applied.data as { ok: boolean; written: string };

    expect(appliedData.ok).toBe(true);
    expect(appliedData.written).toBe("src/OrderService.ts");
    expect(await readFile(path.join(repoRoot, "src/OrderService.ts"), "utf8")).toBe(
      "export class OrderService {\n  place() { return true; }\n}"
    );
  });
});

describe("MCP prompts", () => {
  it("lists all four phase prompts", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((prompt) => prompt.name);

    expect(names).toEqual(
      expect.arrayContaining(["analyze", "create-plan", "implement", "review"])
    );
  });

  it("tells every prompt to pass an explicit path on every tool call", async () => {
    // JetBrains Copilot Chat reads one global mcp.json shared across every
    // project a developer opens, unlike VS Code's per-project config — so
    // the server cannot rely on its own cwd being the right repo, and every
    // prompt has to say so explicitly rather than let a stale default answer
    // silently for the wrong project.
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const analyze = firstMessageText(
      await client.getPrompt({ name: "analyze", arguments: { question: "x" } })
    );
    const createPlan = firstMessageText(
      await client.getPrompt({ name: "create-plan", arguments: { request: "x" } })
    );
    const implement = firstMessageText(
      await client.getPrompt({ name: "implement", arguments: {} })
    );
    const review = firstMessageText(
      await client.getPrompt({ name: "review", arguments: {} })
    );

    for (const text of [analyze, createPlan, implement, review]) {
      expect(text).toContain("pass `path`");
    }
  });

  it("interpolates the question into the analyze prompt", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await client.getPrompt({
      name: "analyze",
      arguments: { question: "What does OrderService do?" }
    });
    const text = firstMessageText(result);

    expect(text).toContain("What does OrderService do?");
    expect(text).toContain("search_repo");
    expect(text).toContain("verify_claims");
  });

  it("tells create-plan not to approve in the same turn", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await client.getPrompt({
      name: "create-plan",
      arguments: { request: "Add invoice approval" }
    });
    const text = firstMessageText(result);

    expect(text).toContain("Add invoice approval");
    expect(text).toContain("draft_plan_contract");
    expect(text).toContain("Do not call approve_plan_contract in this turn");
  });

  it("tells implement to use search/replace, not whole files", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await client.getPrompt({ name: "implement", arguments: {} });
    const text = firstMessageText(result);

    expect(text).toContain("get_approved_plan_contract");
    expect(text).toContain("apply_plan_edit");
    expect(text).toContain("not by returning whole files");
  });

  it("points review at generate_review and resolve_review_finding", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const { client } = await createConnectedServer(repoRoot);

    const result = await client.getPrompt({ name: "review", arguments: {} });
    const text = firstMessageText(result);

    expect(text).toContain("generate_review");
    expect(text).toContain("resolve_review_finding");
  });
});

describe("generate_review", () => {
  it("writes and returns a report even with no approved plan", async () => {
    const repoRoot = await createRepo({
      "src/a.ts": "export const a = 1;"
    });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "generate_review", {});
    const report = result.data as { schemaVersion: string; expectedFiles: string[] };

    expect(report.schemaVersion).toBeDefined();
    expect(report.expectedFiles).toEqual([]);

    const readBack = await callJsonTool(client, "get_latest_review", {});
    expect(readBack.data).toEqual(result.data);
  });

  it("compares against the approved plan contract's expected files", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);
    await callJsonTool(client, "list_repo_files", {});

    const drafted = await callJsonTool(client, "draft_plan_contract", {
      request: "Add invoice approval",
      files: [
        {
          path: "src/OrderService.ts",
          kind: "update",
          reason: "this is where an order is placed",
          symbol: "OrderService"
        }
      ]
    });
    const draftData = drafted.data as { version: number };
    await callJsonTool(client, "approve_plan_contract", { version: draftData.version });

    const result = await callJsonTool(client, "generate_review", {});
    const report = result.data as { expectedFiles: string[] };

    expect(report.expectedFiles).toEqual(["src/OrderService.ts"]);
  });
});

describe("apply_plan_edit", () => {
  it("refuses when no plan has been approved", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/OrderService.ts",
      edits: [{ search: "place() {}", replace: "place() { return true; }" }]
    });
    const data = result.data as { ok: boolean; reason: string };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain("no plan has been approved");
    expect(await readFile(path.join(repoRoot, "src/OrderService.ts"), "utf8")).toBe(
      "export class OrderService { place() {} }"
    );
  });

  it("refuses a path the approved plan never named", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    await approvePlan(repoRoot, [
      { kind: "update", relativePath: "src/OrderService.ts", rationale: "test" }
    ]);
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/Unrelated.ts",
      edits: [{ search: "x", replace: "y" }]
    });
    const data = result.data as { ok: boolean; reason: string };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain("not part of the approved plan");
  });

  it("refuses a path the plan lists as add, not update", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    await approvePlan(repoRoot, [
      { kind: "add", relativePath: "src/NewFile.ts", rationale: "test" }
    ]);
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/NewFile.ts",
      edits: [{ search: "x", replace: "y" }]
    });
    const data = result.data as { ok: boolean; reason: string };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain('planned as "add"');
  });

  it("refuses rather than writes when the search text is ambiguous", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts":
        "export class OrderService {\n  place() {}\n  place() {}\n}"
    });
    await approvePlan(repoRoot, [
      { kind: "update", relativePath: "src/OrderService.ts", rationale: "test" }
    ]);
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/OrderService.ts",
      edits: [{ search: "  place() {}", replace: "  place() { return true; }" }]
    });
    const data = result.data as { ok: boolean; reason: string };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain("ambiguous");
    expect(
      await readFile(path.join(repoRoot, "src/OrderService.ts"), "utf8")
    ).toContain("place() {}\n  place() {}");
  });

  it("refuses when the file drifted since the plan was approved", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });
    await approvePlan(repoRoot, [
      {
        kind: "update",
        relativePath: "src/OrderService.ts",
        rationale: "test",
        beforeHash: "not-the-real-hash"
      }
    ]);
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/OrderService.ts",
      edits: [{ search: "place() {}", replace: "place() { return true; }" }]
    });
    const data = result.data as { ok: boolean; reason: string; drifted: string[] };

    expect(data.ok).toBe(false);
    expect(data.reason).toContain("moved since this plan was written");
    expect(data.drifted).toContain("src/OrderService.ts");
    expect(await readFile(path.join(repoRoot, "src/OrderService.ts"), "utf8")).toBe(
      "export class OrderService { place() {} }"
    );
  });

  it("applies a clean edit to a file the approved plan authorizes", async () => {
    const repoRoot = await createRepo({
      "src/OrderService.ts": "export class OrderService {\n  place() {}\n}"
    });
    await approvePlan(repoRoot, [
      { kind: "update", relativePath: "src/OrderService.ts", rationale: "test" }
    ]);
    const { client } = await createConnectedServer(repoRoot);

    const result = await callJsonTool(client, "apply_plan_edit", {
      relativePath: "src/OrderService.ts",
      edits: [{ search: "  place() {}", replace: "  place() { return true; }" }]
    });
    const data = result.data as { ok: boolean; written: string; editsApplied: number };

    expect(data.ok).toBe(true);
    expect(data.written).toBe("src/OrderService.ts");
    expect(data.editsApplied).toBe(1);
    expect(await readFile(path.join(repoRoot, "src/OrderService.ts"), "utf8")).toBe(
      "export class OrderService {\n  place() { return true; }\n}"
    );
  });
});

async function approvePlan(
  workspaceRoot: string,
  changes: Array<{
    kind: "add" | "update" | "delete";
    relativePath: string;
    rationale: string;
    beforeHash?: string;
  }>
): Promise<void> {
  const plan = createPlanContract({
    request: "test request",
    version: 1,
    decisions: [],
    changes
  });
  await writeApprovedPlan(workspaceRoot, plan);
}

async function createConnectedServer(repoRoot: string) {
  const server = createCopilotArchitectMcpServer({ startPath: repoRoot });
  const client = new Client({ name: "mcp-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  servers.push(server);
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client };
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];

  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} did not return text content`);
  }

  return JSON.parse(first.text);
}

function firstMessageText(result: { messages: Array<{ content: unknown }> }): string {
  const content = result.messages[0]?.content as { type: string; text?: string };

  if (!content || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Prompt did not return a text message");
  }

  return content.text;
}

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-mcp-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function createWorkspaceFixture(): Promise<{
  workspaceRoot: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "copilot-mcp-workspace-"));
  const workspaceRoot = path.join(parent, "customer-platform");
  const customerApi = path.join(parent, "customer-api");
  const billingService = path.join(parent, "billing-service");

  await writeRepo(customerApi, {
    "package.json": JSON.stringify({ name: "customer-api" }),
    "src/customer.ts": "export const customer = true;"
  });
  await writeRepo(billingService, {
    "package.json": JSON.stringify({ name: "billing-service" }),
    "src/invoice.ts": "export const invoice = 'approved';"
  });
  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify({
      schemaVersion: "0.1.0",
      workspaceName: "Customer Platform",
      workspaceRoot,
      artifactRoot: path.join(workspaceRoot, ".copilot-architect"),
      repos: [
        { name: "customer-api", path: "../customer-api", role: "backend" },
        { name: "billing-service", path: "../billing-service", role: "service" }
      ],
      repoRoots: []
    }),
    "utf8"
  );

  return { workspaceRoot };
}

async function writeRepo(
  repoRoot: string,
  files: Record<string, string>
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
}
