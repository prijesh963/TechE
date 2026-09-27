import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerCopilotArchitectPrompts } from "./prompts.js";
import { registerCopilotArchitectTools } from "./tools.js";

export interface CopilotArchitectMcpServerOptions {
  startPath?: string;
}

export function createCopilotArchitectMcpServer(
  options: CopilotArchitectMcpServerOptions = {}
): McpServer {
  const server = new McpServer({
    name: "copilot-architect",
    version: "0.1.0"
  });

  registerCopilotArchitectTools(server, options);
  registerCopilotArchitectPrompts(server);

  return server;
}

export async function startMcpServer(
  options: CopilotArchitectMcpServerOptions = {}
): Promise<void> {
  const server = createCopilotArchitectMcpServer(options);
  await server.connect(new StdioServerTransport());
}
