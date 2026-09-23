import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { escapeHtml } from "@copilot-architect/dashboard";
import {
  CopilotHandoffService,
  type CopilotPlanSummary,
  type CopilotWorkflowState
} from "@copilot-architect/planner";

/**
 * `copilot` — the no-MCP, no-terminal workflow for a host whose only model
 * is GitHub Copilot Chat (see `CopilotHandoffService`). Each subcommand is
 * one click in the IntelliJ Tool Window; the plugin never parses this
 * command's output. A prompt is handed over as a file (`--prompt-out`),
 * a Copilot reply as a file (`--response-file`), and stdout is one line of
 * plain text shown to the developer as-is.
 */
export type CopilotSubcommand =
  "ask" | "plan" | "import" | "approve" | "implement" | "state";

const SUBCOMMANDS: CopilotSubcommand[] = [
  "ask",
  "plan",
  "import",
  "approve",
  "implement",
  "state"
];

export interface CopilotCliOptions {
  subcommand: CopilotSubcommand;
  startPath?: string;
  text?: string;
  responseFile?: string;
  promptOut?: string;
  version?: number;
  json: boolean;
}

export interface CopilotCliOutcome {
  message: string;
  prompt?: string;
  files?: string[];
  version?: number;
  state?: CopilotWorkflowState;
}

export function parseCopilotArgs(args: string[]): CopilotCliOptions {
  const subcommand = args[0] as CopilotSubcommand;

  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `Unknown copilot subcommand: ${args[0] ?? "(none)"}. Expected one of: ${SUBCOMMANDS.join(", ")}.`
    );
  }

  const options: CopilotCliOptions = { subcommand, json: false };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };

    if (arg === "--json") options.json = true;
    else if (arg === "--path") options.startPath = value();
    else if (arg === "--text") options.text = value();
    else if (arg === "--response-file") options.responseFile = value();
    else if (arg === "--prompt-out") options.promptOut = value();
    else if (arg === "--version") {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --version value: ${raw}`);
      }
      options.version = parsed;
    } else throw new Error(`Unknown copilot argument: ${arg}`);
  }

  return options;
}

export async function runCopilotCommand(
  options: CopilotCliOptions,
  service = new CopilotHandoffService()
): Promise<CopilotCliOutcome> {
  const workspaceRoot = path.resolve(options.startPath ?? process.cwd());

  switch (options.subcommand) {
    case "ask":
    case "plan":
    case "implement": {
      const result =
        options.subcommand === "ask"
          ? await service.askPrompt({ workspaceRoot, question: options.text ?? "" })
          : options.subcommand === "plan"
            ? await service.planPrompt({ workspaceRoot, request: options.text ?? "" })
            : await service.implementPrompt({ workspaceRoot });

      if (options.promptOut) {
        await writeFile(options.promptOut, result.prompt, "utf8");
      }

      return { message: result.message, prompt: result.prompt, files: result.files };
    }
    case "import": {
      if (!options.responseFile) {
        throw new Error(
          "copilot import needs --response-file <file> holding Copilot's reply."
        );
      }
      const response = await readFile(options.responseFile, "utf8");
      const imported = await service.importPlan({ workspaceRoot, response });
      return { message: imported.message, version: imported.version };
    }
    case "approve": {
      if (options.version === undefined) {
        throw new Error(
          "copilot approve needs --version <n>: the plan version shown when you clicked."
        );
      }
      const approved = await service.approvePlan({
        workspaceRoot,
        version: options.version
      });
      return {
        message: `Plan v${approved.version} approved. Click Implement to hand it to Copilot.`,
        version: approved.version
      };
    }
    case "state": {
      const state = await service.state({ workspaceRoot });
      return { message: describeState(state), state };
    }
  }
}

function describeState(state: CopilotWorkflowState): string {
  if (state.latestPlan) {
    return `Plan v${state.latestPlan.version} (${state.latestPlan.status}) — ${state.latestPlan.request}`;
  }
  if (state.pendingRequest) {
    return `Waiting for Copilot's plan for: ${state.pendingRequest}`;
  }
  return "No Copilot plan in progress.";
}

/**
 * The "Work with Copilot Chat" panel at the top of the dashboard.
 *
 * Buttons are `architect-action:` links like every other action. Each one
 * carries `data-input`, so the host's click script (IntelliJ's
 * `ActionLinkBridge`) sends the text box's value along with the id — Ask
 * and Plan need it, and every click re-renders the page, so the others send
 * it too or whatever was typed would be lost. Only the
 * step that makes sense next is offered — Implement appears once a plan is
 * approved, Approve only on a draft — so the panel itself says what to do.
 */
export function buildCopilotPanelHtml(
  state: CopilotWorkflowState,
  options: { task?: string; notice?: string; noticeIsError?: boolean } = {}
): string {
  const plan = state.latestPlan;
  const pendingIsNewer = Boolean(
    state.pendingRequest && (!plan || plan.request !== state.pendingRequest)
  );
  const pendingMatchesPlan = Boolean(
    state.pendingRequest && plan && plan.request === state.pendingRequest
  );

  const parts = [
    '<div class="ca-copilot">',
    "<style>",
    ".ca-copilot{flex-basis:100%;border:1px solid var(--vscode-panel-border);border-left:4px solid var(--vscode-charts-green);border-radius:6px;padding:12px;background:var(--vscode-sideBar-background);display:flex;flex-direction:column;gap:8px;}",
    ".ca-copilot h2{font-size:14px;margin:0;color:var(--vscode-foreground);}",
    ".ca-copilot .ca-hint{font-size:12px;margin:0;color:var(--vscode-descriptionForeground);}",
    ".ca-copilot textarea{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;font:inherit;font-size:13px;padding:6px;border-radius:4px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-foreground);}",
    ".ca-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
    ".ca-btn{display:inline-block;padding:5px 12px;border-radius:4px;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-size:12px;cursor:pointer;}",
    ".ca-btn.primary{background:var(--vscode-charts-blue);border-color:var(--vscode-charts-blue);color:#fff;}",
    ".ca-notice{font-size:12px;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-charts-green);}",
    ".ca-notice.error{border-color:var(--vscode-charts-red);}",
    ".ca-plan{border-top:1px solid var(--vscode-panel-border);padding-top:8px;display:flex;flex-direction:column;gap:6px;font-size:12px;}",
    ".ca-plan ul{margin:0;padding-left:18px;}",
    ".ca-plan li{margin:2px 0;}",
    ".ca-kind{font-weight:600;text-transform:uppercase;font-size:10px;margin-right:4px;}",
    ".ca-path{font-family:var(--vscode-editor-font-family, monospace);}",
    ".ca-setup-label{font-size:12px;color:var(--vscode-descriptionForeground);}",
    "</style>",
    "<h2>Work with Copilot Chat</h2>",
    '<p class="ca-hint">Describe a question or a change. Copilot Architect finds the right code in this repo and prepares the prompt; you paste it into Copilot Chat.</p>'
  ];

  if (options.notice) {
    parts.push(
      `<div class="ca-notice${options.noticeIsError ? " error" : ""}">${escapeHtml(options.notice)}</div>`
    );
  }

  parts.push(
    `<textarea id="ca-task" placeholder="e.g. Add an approval step for invoices over 10,000">${escapeHtml(options.task ?? "")}</textarea>`,
    '<div class="ca-row">',
    button("copilotAsk", "Ask about the code", { input: true }),
    button("copilotPlan", "Plan the change", {
      input: true,
      primary: !plan || (plan.status === "approved" && plan.implemented)
    }),
    "</div>"
  );

  if (pendingIsNewer) {
    parts.push(
      '<div class="ca-plan">',
      `<div><strong>Waiting for Copilot's plan</strong> for “${escapeHtml(state.pendingRequest!)}”.</div>`,
      "<div>When Copilot has replied, click <em>Copy</em> on its reply, then:</div>",
      `<div class="ca-row">${button("copilotImport", "Import plan from clipboard", { primary: true })}</div>`,
      "</div>"
    );
  }

  if (plan) {
    parts.push(
      renderPlan(plan, {
        canReimport: pendingMatchesPlan,
        approvedVersion: state.approvedVersion
      })
    );
  }

  parts.push("</div>");
  return parts.join("");
}

function renderPlan(
  plan: CopilotPlanSummary,
  options: { canReimport: boolean; approvedVersion?: number }
): string {
  const status =
    plan.status === "draft"
      ? "draft — review it, then approve"
      : plan.implemented
        ? "approved and implemented"
        : "approved — ready to implement";

  const rows = [
    '<div class="ca-plan">',
    `<div><strong>Plan v${plan.version}</strong> · ${escapeHtml(status)}</div>`,
    `<div>${escapeHtml(plan.request)}</div>`
  ];

  if (plan.approach.length > 0) {
    rows.push(
      "<div><strong>What it does</strong></div>",
      `<ul>${plan.approach.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    );
  } else {
    rows.push(
      "<div><em>Copilot gave no overall approach — the file steps below are all there is.</em></div>"
    );
  }

  rows.push(
    "<div><strong>Files</strong></div>",
    `<ul>${plan.changes
      .map(
        (change) =>
          `<li><span class="ca-kind">${escapeHtml(change.kind)}</span><span class="ca-path">${escapeHtml(change.path)}</span> — ${escapeHtml(change.rationale)}${
            change.steps.length > 0
              ? `<ul>${change.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>`
              : ""
          }</li>`
      )
      .join("")}</ul>`
  );

  const actions: string[] = [];
  if (plan.status === "draft") {
    actions.push(
      button(`copilotApprove:${plan.version}`, `Approve plan v${plan.version}`, {
        primary: true
      })
    );
    if (options.canReimport) {
      actions.push(button("copilotImport", "Import revised plan", {}));
    }
  }
  if (options.approvedVersion !== undefined) {
    actions.push(
      button(
        "copilotImplement",
        `Implement plan v${options.approvedVersion} with Copilot`,
        {
          primary: plan.status === "approved" && !plan.implemented
        }
      )
    );
  }

  rows.push(`<div class="ca-row">${actions.join("")}</div>`);

  if (plan.status === "draft") {
    rows.push(
      '<p class="ca-hint">To change it, tell Copilot what to change, copy its new reply, and click Import revised plan.</p>'
    );
  } else if (!plan.implemented) {
    rows.push(
      '<p class="ca-hint">Implement copies a prompt for Copilot Chat. Switch Copilot Chat to Agent mode before pasting, so it can edit the files.</p>'
    );
  }

  rows.push("</div>");
  return rows.join("");
}

function button(
  id: string,
  label: string,
  options: { input?: boolean; primary?: boolean }
): string {
  return `<a class="ca-btn${options.primary ? " primary" : ""}" href="architect-action:${escapeHtml(id)}"${
    options.input === false ? "" : ' data-input="ca-task"'
  }>${escapeHtml(label)}</a>`;
}
