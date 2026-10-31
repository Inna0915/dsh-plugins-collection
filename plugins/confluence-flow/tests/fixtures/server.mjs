import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  saveProfile,
  ConfluenceService,
  escapeHtml,
} from "../../dist/test-exports.js";

export const originalStorage =
  '<ac:layout><ac:layout-section ac:type="two_right_sidebar"><ac:layout-cell><h1>接口说明</h1><p>总体说明</p><h2>请求参数</h2><p>旧参数</p><h3>校验</h3><p>旧校验</p><h2>响应参数</h2><p>保留响应</p><ac:structured-macro ac:name="drawio" ac:macro-id="KEEP-EXACT"><ac:parameter ac:name="name">业务图</ac:parameter></ac:structured-macro></ac:layout-cell><ac:layout-cell><ac:structured-macro ac:name="toc" /></ac:layout-cell></ac:layout-section></ac:layout>';
function rawPage(id, storage, version = 3, title = "接口说明") {
  return {
    id,
    type: "page",
    title,
    space: { key: "DEMO" },
    ancestors: [{ id: "100" }],
    version: { number: version, when: "2026-10-30T08:00:00.000Z" },
    body: { storage: { value: storage, representation: "storage" } },
  };
}
export function fixtureConvert(wiki) {
  return wiki
    .split(/\n\s*\n/)
    .map((block) => {
      const heading = block.match(/^h([1-6])\. (.+)$/);
      if (heading) {
        return `<h${heading[1]}>${escapeHtml(heading[2])}</h${heading[1]}>`;
      }
      if (block.startsWith("||")) {
        return "<table><tbody><tr><th>字段</th><th>说明</th></tr><tr><td>orderNo</td><td>订单号</td></tr></tbody></table>";
      }
      return `<p>${escapeHtml(block)}</p>`;
    })
    .join("");
}
export async function setup(options = {}) {
  const temporaryRoot = path.resolve(".task-temp");
  await mkdir(temporaryRoot, { recursive: true });
  const home = await mkdtemp(path.join(temporaryRoot, "test-"));
  const oldHome = process.env.CONFLUENCE_FLOW_HOME;
  process.env.CONFLUENCE_FLOW_HOME = home;
  process.env.CONFLUENCE_FLOW_AUTH_FIXTURE = JSON.stringify({
    kind: "basic",
    username: "fixture-user",
    secret: "synthetic-credential",
  });
  const state = {
    pages: new Map([
      ["1", rawPage("1", originalStorage)],
      [
        "100",
        rawPage(
          "100",
          "<h1>项目文档</h1><p>示例项目的文档入口</p>",
          1,
          "项目文档",
        ),
      ],
    ]),
    writes: [],
    requests: [],
    failWrite: false,
    race: false,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    state.requests.push({
      method: req.method,
      url: url.pathname,
      query: url.searchParams.toString(),
      authorization: req.headers.authorization,
    });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let input;
    if (req.method === "POST" || req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (url.pathname === "/rest/api/user/current") {
      send(200, { displayName: "示例用户" });
      return;
    }
    if (url.pathname === "/rest/api/contentbody/convert/storage") {
      send(200, {
        value: fixtureConvert(input.value),
        representation: "storage",
      });
      return;
    }
    if (url.pathname === "/rest/api/search") {
      const start = Number(url.searchParams.get("start") || 0);
      const limit = Number(url.searchParams.get("limit") || 30);
      const pages = [...state.pages.values()];
      send(200, {
        results: pages
          .slice(start, start + limit)
          .map((content) => ({
            content,
            title: content.title,
            excerpt: "示例 <em>接口</em> @@@hl@@@IDOC@@@endhl@@@ 摘要",
            lastModified: content.version.when,
          })),
        start,
        limit,
        totalSize: pages.length,
        _links: start + limit < pages.length ? { next: "next" } : {},
      });
      return;
    }
    if (
      url.pathname === "/rest/api/content/search" ||
      (url.pathname === "/rest/api/content" && req.method === "GET")
    ) {
      send(200, { results: [...state.pages.values()], _links: {} });
      return;
    }
    if (url.pathname.endsWith("/child/page")) {
      send(200, { results: [state.pages.get("1")], _links: {} });
      return;
    }
    if (url.pathname.endsWith("/child/attachment")) {
      send(200, {
        results: [
          {
            id: "9",
            title: "示例.png",
            metadata: { mediaType: "image/png" },
            extensions: { fileSize: 1000 },
            _links: { download: "/download/attachments/1/example.png" },
          },
        ],
        _links: {},
      });
      return;
    }
    const id = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/)?.[1];
    if (id && req.method === "GET") {
      const page = state.pages.get(id);
      send(page ? 200 : 404, page || {});
      return;
    }
    if (req.method === "POST" && url.pathname === "/rest/api/content") {
      state.writes.push({ method: "POST", input });
      if (state.failWrite) {
        send(500, { message: "synthetic ambiguous failure" });
        return;
      }
      const created = rawPage(
        String(200 + state.writes.length),
        input.body.storage.value,
        1,
        input.title,
      );
      created.ancestors = input.ancestors;
      state.pages.set(created.id, created);
      send(200, created);
      return;
    }
    if (req.method === "PUT" && id) {
      state.writes.push({ method: "PUT", input });
      const current = state.pages.get(id);
      if (state.race) {
        current.version.number++;
        state.race = false;
      }
      if (input.version.number !== current.version.number + 1) {
        send(409, {});
        return;
      }
      if (state.failWrite) {
        send(500, {});
        return;
      }
      const updated = rawPage(
        id,
        input.body.storage.value,
        input.version.number,
        input.title,
      );
      state.pages.set(id, updated);
      send(200, updated);
      return;
    }
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  await saveProfile({
    id: "fixture",
    host,
    name: "示例知识库",
    spaceKey: "DEMO",
    rootPageIds: ["100"],
    targets: { 项目文档: "100" },
    allowWrites: options.allowWrites !== false,
    credentialStore: "environment",
  });
  const service = new ConfluenceService();
  return {
    state,
    host,
    home,
    service,
    async close() {
      service.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (oldHome === undefined) {
        delete process.env.CONFLUENCE_FLOW_HOME;
      } else {
        process.env.CONFLUENCE_FLOW_HOME = oldHome;
      }
      delete process.env.CONFLUENCE_FLOW_AUTH_FIXTURE;
      if (!path.resolve(home).startsWith(temporaryRoot + path.sep)) {
        throw new Error("拒绝清理临时区域以外路径");
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}
