import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfluenceService } from "./service.js";
import {
  toolShape,
  toolDescription,
  deleteShape,
  deleteDescription,
} from "./schema.js";
import { message } from "./store.js";

export async function startMcp() {
  const service = new ConfluenceService();
  const server = new McpServer({ name: "confluence-flow", version: "0.6.0" });
  const respond = async (task: () => Promise<unknown>) => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await task()) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: message(error) }],
      };
    }
  };
  server.registerTool(
    "confluence_flow",
    {
      title: "Confluence 文档",
      description: toolDescription,
      inputSchema: toolShape,
    },
    async (args, extra) => respond(() => service.execute(args, extra.signal)),
  );
  // 删除单独成工具，客户端可对它单独要求每次确认（不要加入自动允许列表）；
  // 宿主批准这次调用即视为授权，令牌、页面核对与逐页回执仍由运行层负责。
  server.registerTool(
    "confluence_flow_delete",
    {
      title: "Confluence 删除（移到回收站）",
      description: deleteDescription,
      inputSchema: deleteShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      respond(() =>
        service.executeDelete(
          args,
          async () => ({ method: "host" }),
          extra.signal,
        ),
      ),
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
