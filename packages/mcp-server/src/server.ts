import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerCopilotArchitectTools } from "./tools.js";

export interface CopilotArchitectMcpServerOptions {
  startPath?: string;
  /**
   * Which MCP tools to register — "full" (every tool, the default) or a
   * named curated subset. See MCP_TOOLSETS in tools.ts for what each name
   * includes and why.
   */
  toolset?: string;
}

export function createCopilotArchitectMcpServer(
  options: CopilotArchitectMcpServerOptions = {}
): McpServer {
  const server = new McpServer({
    name: "copilot-architect",
    version: "0.1.0"
  });

  registerCopilotArchitectTools(server, options);

  return server;
}

export async function startMcpServer(
  options: CopilotArchitectMcpServerOptions = {}
): Promise<void> {
  const server = createCopilotArchitectMcpServer(options);
  await server.connect(new StdioServerTransport());
}
