import { z } from "zod";
import { ConfluenceService } from "../runtime/service.js";
import { createHttpHandler } from "../runtime/http.js";
import { bundledSkills } from "../runtime/skills.js";
import {
  toolSchema,
  toolDescription,
  deleteSchema,
  deleteDescription,
} from "../runtime/schema.js";
import { DELETE_TOOL, authorizeInDsh } from "./approval.js";

export const name = "confluence-flow";
export const inject = ["webServer", "tools", "skills"];
export async function apply(ctx: any): Promise<void> {
  const service = new ConfluenceService();
  const api = createHttpHandler(service);
  for (const route of ["/confluence-flow/bootstrap", "/confluence-flow/api"]) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: route,
          handler: api.handler,
        }),
      `confluence-flow: ${route}`,
    );
  }
  const output = {
    schema: {},
    render: (_args: unknown, value: unknown) => [
      { type: "text", text: JSON.stringify(value) },
    ],
  };
  ctx.tools.register({
    name: "confluence_flow",
    description: toolDescription,
    parameters: z.toJSONSchema(toolSchema, { target: "draft-7", io: "input" }),
    output,
    async execute(args: unknown, exec: any) {
      return service.execute(args, exec.signal);
    },
  });
  // 删除单独成工具：授权在工具内完成（用户消息明确指定或宿主弹窗），不依赖其他前置拦截的顺序。
  ctx.tools.register({
    name: DELETE_TOOL,
    description: deleteDescription,
    parameters: z.toJSONSchema(deleteSchema, {
      target: "draft-7",
      io: "input",
    }),
    output,
    async execute(args: unknown, exec: any) {
      return service.executeDelete(
        args,
        (target) => authorizeInDsh(ctx, exec, target),
        exec.signal,
      );
    },
  });
  for (const skill of await bundledSkills()) {
    ctx.skills.register(skill);
  }
  ctx.effect(
    () => () => {
      api.dispose();
      service.dispose();
    },
    "confluence-flow: request cleanup",
  );
  ctx.logger.info("Confluence 文档 0.6.0 ready");
}
