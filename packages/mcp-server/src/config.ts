import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CURRENT_SCHEMA_VERSION } from "@copilot-architect/shared";

import { MCP_TOOLSET_NAMES, isMcpToolsetName } from "./tools.js";

export interface CopilotChatMcpConfigOptions {
  startPath?: string;
  force?: boolean;
  /**
   * Baked into the generated server's args as `--toolset <name>` when set.
   * See MCP_TOOLSETS in tools.ts for what each name includes and why.
   */
  toolset?: string;
}

export interface CopilotChatMcpConfigResult {
  schemaVersion: string;
  generatedAt: string;
  configPath: string;
  serverName: "copilotArchitect";
  status: "created" | "updated";
  backupPath?: string;
  config: CopilotChatMcpConfig;
  messages: string[];
}

export interface CopilotChatMcpConfig {
  servers: {
    copilotArchitect: {
      type: "stdio";
      command: string;
      args: string[];
      cwd: string;
    };
  } & Record<string, unknown>;
}

export class CopilotChatMcpConfigService {
  async write(
    options: CopilotChatMcpConfigOptions = {}
  ): Promise<CopilotChatMcpConfigResult> {
    if (options.toolset && !isMcpToolsetName(options.toolset)) {
      throw new Error(
        `Unknown MCP toolset "${options.toolset}". Known toolsets: ${MCP_TOOLSET_NAMES.join(", ")}.`
      );
    }

    const repoRoot = path.resolve(options.startPath ?? process.cwd());
    const configPath = path.join(repoRoot, ".vscode", "mcp.json");
    const existing = await readExistingConfig(configPath);
    const backupPath = existing
      ? await writeBackup(configPath, existing.raw)
      : undefined;
    const config = mergeCopilotArchitectServer(existing?.config, options.toolset);

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      configPath,
      serverName: "copilotArchitect",
      status: existing ? "updated" : "created",
      backupPath,
      config,
      messages: [
        "Configured Copilot Architect as a local stdio MCP server for Copilot Chat.",
        "Open VS Code Command Palette > MCP: List Servers to start or inspect the server.",
        "Copilot Architect does not modify Copilot internals; it provides local repo tools through MCP.",
        ...(options.toolset ? [`Registered the "${options.toolset}" MCP toolset.`] : [])
      ]
    };
  }
}

function mergeCopilotArchitectServer(
  existing?: Partial<CopilotChatMcpConfig>,
  toolset?: string
): CopilotChatMcpConfig {
  const args = [resolveCliEntryPoint(), "mcp", "--path", "${workspaceFolder}"];

  if (toolset) {
    args.push("--toolset", toolset);
  }

  return {
    ...existing,
    servers: {
      ...(existing?.servers ?? {}),
      copilotArchitect: {
        type: "stdio",
        command: "node",
        args,
        cwd: "${workspaceFolder}"
      }
    }
  };
}

async function readExistingConfig(
  configPath: string
): Promise<{ raw: string; config: Partial<CopilotChatMcpConfig> } | undefined> {
  try {
    const raw = await readFile(configPath, "utf8");
    return { raw, config: JSON.parse(raw) as Partial<CopilotChatMcpConfig> };
  } catch {
    return undefined;
  }
}

async function writeBackup(configPath: string, raw: string): Promise<string> {
  const backupPath = `${configPath}.${timestampId()}.bak`;
  await writeFile(backupPath, raw, "utf8");
  return backupPath;
}

function resolveCliEntryPoint(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(currentFile), "../../..");
  return path.join(repoRoot, "packages", "cli", "dist", "index.js");
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function copilotChatMcpConfigExists(startPath?: string): Promise<boolean> {
  try {
    await access(
      path.join(path.resolve(startPath ?? process.cwd()), ".vscode", "mcp.json")
    );
    return true;
  } catch {
    return false;
  }
}
