import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfluenceService } from "./service.js";
import { importObsidian, installationRoot, saveProfile } from "./config.js";
import { message } from "./store.js";

export function createHttpHandler(service: ConfluenceService) {
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress || "",
      )
    ) {
      send(res, 403, { error: "文档面板仅允许本机访问" });
      return;
    }
    try {
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL("http://" + req.headers.host).hostname,
        )
      ) {
        throw new Error();
      }
    } catch {
      send(res, 403, { error: "无效的本机 Host" });
      return;
    }
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) {
          throw new Error();
        }
      } catch {
        send(res, 403, { error: "来源不匹配" });
        return;
      }
    }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/confluence-flow/bootstrap" && req.method === "GET") {
      send(res, 200, { token, version: "0.4.0" });
      return;
    }
    const provided =
      typeof req.headers["x-confluence-flow-token"] === "string"
        ? req.headers["x-confluence-flow-token"]
        : "";
    const bytes = new TextEncoder().encode(provided);
    const expected = new TextEncoder().encode(token);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) {
      send(res, 403, {
        code: "PAGE_TOKEN_EXPIRED",
        error: "页面连接已失效，请刷新",
      });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120_000);
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });
    try {
      if (url.pathname !== "/confluence-flow/api" || req.method !== "POST") {
        send(res, 404, { error: "接口不存在" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        throw new Error("请求必须是 JSON");
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          throw new Error("请求内容超过限制");
        }
        chunks.push(new Uint8Array(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (input.operation === "settings.save") {
        result = await saveProfile(input.profile, input.auth);
      } else if (input.operation === "settings.import") {
        result = await importObsidian(input.source, input.allowWrites === true);
      } else {
        result = await service.execute(input, controller.signal);
      }
      if (!res.destroyed) {
        send(res, 200, { data: result });
      }
    } catch (error) {
      if (!res.destroyed) {
        send(res, 400, { error: message(error) });
      }
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  return {
    handler,
    dispose() {
      for (const controller of controllers) {
        controller.abort();
      }
    },
  };
}
export async function serve(port = 43138, service = new ConfluenceService()) {
  const api = createHttpHandler(service);
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/confluence-flow/")) {
      await api.handler(req, res);
      return;
    }
    const name =
      req.url?.split("?")[0] === "/standalone.js"
        ? "standalone.js"
        : "index.html";
    try {
      const content = await readFile(path.join(installationRoot, "dist", name));
      res.writeHead(200, {
        "Content-Type": name.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("请先构建 Confluence Flow");
    }
  });
  server.requestTimeout = 130_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    close: async () => {
      api.dispose();
      service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
