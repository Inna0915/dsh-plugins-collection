import { z } from "zod";
import { ConfluenceService } from "../runtime/service.js";
import { createHttpHandler } from "../runtime/http.js";
import { bundledSkills } from "../runtime/skills.js";
import { toolSchema, toolDescription } from "../runtime/schema.js";

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
  ctx.tools.register({
    name: "confluence_flow",
    description: toolDescription,
    parameters: z.toJSONSchema(toolSchema, { target: "draft-7", io: "input" }),
    output: {
      schema: {},
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: JSON.stringify(value) },
      ],
    },
    async execute(args: unknown, exec: any) {
      return service.execute(args, exec.signal);
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
  ctx.logger.info("Confluence 文档 0.2.0 ready");
}
