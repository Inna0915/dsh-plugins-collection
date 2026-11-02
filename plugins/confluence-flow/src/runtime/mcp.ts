import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfluenceService } from "./service.js";
import { toolShape, toolDescription } from "./schema.js";
import { message } from "./store.js";

export async function startMcp() {
  const service = new ConfluenceService();
  const server = new McpServer({ name: "confluence-flow", version: "0.5.0" });
  server.registerTool(
    "confluence_flow",
    {
      title: "Confluence 文档",
      description: toolDescription,
      inputSchema: toolShape,
    },
    async (args, extra) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await service.execute(args, extra.signal)),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: message(error) }],
        };
      }
    },
  );
  await server.connect(new StdioServerTransport());
  const close = async () => {
    service.dispose();
    await server.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  return { close };
}
