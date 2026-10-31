import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createHttpHandler,
  dshApply,
  captureCurrentComposer,
  openWorkspaceBoard,
} from "../dist/test-exports.js";
import { setup } from "./fixtures/server.mjs";

test("标准 MCP 客户端发现工具并调用实际读取和预览", async () => {
  const ctx = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "mcp"],
    env: { ...process.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "verification", version: "1.0.0" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "confluence_flow"));
    const read = await client.callTool({
      name: "confluence_flow",
      arguments: { operation: "read", profile: "fixture", page: "1" },
    });
    assert.equal(read.isError, undefined);
    assert.equal(JSON.parse(read.content[0].text).version, 3);
    assert.equal(JSON.parse(read.content[0].text).html, undefined);
    assert.ok(Buffer.byteLength(read.content[0].text) <= 8192);
    const scan = await client.callTool({
      name: "confluence_flow",
      arguments: {
        operation: "scan",
        profile: "fixture",
        pages: ["1", "1"],
        grep: "参数",
      },
    });
    const scanned = JSON.parse(scan.content[0].text);
    assert.equal(scanned.stats.fetched, 0);
    assert.equal(scanned.stats.cached, 1);
    assert.ok(scanned.results[0].matchCount > 0);
    assert.equal(scanned.results[0].wiki, undefined);
    const preview = await client.callTool({
      name: "confluence_flow",
      arguments: {
        operation: "create",
        profile: "fixture",
        parent: "100",
        title: "MCP 预览",
        wiki: "h1. MCP 预览",
      },
    });
    assert.equal(JSON.parse(preview.content[0].text).status, "preview");
    assert.equal(ctx.state.writes.length, 0);
  } finally {
    await client.close();
    await transport.close();
    await ctx.close();
  }
});
test("DSH 注册原生工具与三个 Skills，工具实际可调用", async () => {
  const ctx = await setup();
  const registered = [];
  const skills = [];
  const dispose = [];
  const routes = [];
  try {
    await dshApply({
      webServer: {
        register(route) {
          routes.push(route);
          return () => undefined;
        },
      },
      tools: {
        register(tool) {
          registered.push(tool);
        },
      },
      skills: {
        register(skill) {
          skills.push(skill);
        },
      },
      effect(effect) {
        const cleanup = effect();
        if (typeof cleanup === "function") {
          dispose.push(cleanup);
        }
      },
      logger: { info() {} },
    });
    assert.equal(registered[0].name, "confluence_flow");
    assert.equal(skills.length, 3);
    assert.equal(routes.length, 2);
    const read = await registered[0].execute(
      { operation: "read", profile: "fixture", page: "1" },
      { signal: new AbortController().signal },
    );
    assert.equal(read.version, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(read)), read);
    assert.equal(read.html, undefined);
    assert.ok(registered[0].parameters.properties.wiki);
  } finally {
    for (const cleanup of dispose.reverse()) {
      cleanup();
    }
    await ctx.close();
  }
});
test("HTTP 需要本机来源与页面令牌，浏览器请求可读文档", async () => {
  const ctx = await setup();
  const api = createHttpHandler(ctx.service);
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootstrap = await fetch(base + "/confluence-flow/bootstrap").then(
      (response) => response.json(),
    );
    assert.equal(
      (
        await fetch(base + "/confluence-flow/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/confluence-flow/bootstrap", {
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    const hostileHost = await new Promise((resolve) => {
      const req = request(
        base + "/confluence-flow/bootstrap",
        { headers: { Host: "evil.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.end();
    });
    assert.equal(hostileHost, 403);
    const response = await fetch(base + "/confluence-flow/api", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-confluence-flow-token": bootstrap.token,
      },
      body: JSON.stringify({
        operation: "read",
        profile: "fixture",
        page: "1",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.title, "接口说明");
  } finally {
    api.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ctx.close();
  }
});
test("加入会话使用最新草稿插入位置并保留原草稿", () => {
  let text = "已有草稿";
  let persisted = false;
  const actions = {
    captureInsertion: () => ({
      start: text.length,
      end: text.length,
      draftRev: 1,
    }),
    insertText(value, span) {
      text = text.slice(0, span.start) + value + text.slice(span.end);
      return true;
    },
    addAttachments: () => true,
    persistDraft() {
      persisted = true;
    },
  };
  const binding = { key: "session", props: { inputActions: actions } };
  const host = {
    uiSession: { adapter: { current: { getSnapshot: () => binding } } },
    layout: { selectPanel() {} },
  };
  const insert = captureCurrentComposer(host);
  text += "，加载期间继续输入";
  insert({ text: "页面正文", images: [], warnings: [] });
  assert.ok(text.startsWith("已有草稿，加载期间继续输入"));
  assert.ok(text.includes("页面正文"));
  assert.ok(persisted);
});
test("加入会话期间切换目标会话会停止插入", () => {
  let binding = { key: "one", props: { inputActions: {} } };
  const host = {
    uiSession: { adapter: { current: { getSnapshot: () => binding } } },
    layout: { selectPanel() {} },
  };
  const insert = captureCurrentComposer(host);
  binding = { key: "two", props: { inputActions: {} } };
  assert.throws(
    () => insert({ text: "正文", images: [], warnings: [] }),
    /切换/,
  );
});
test("工作区复用已打开的原生分栏", () => {
  let focused = "";
  let opened = false;
  openWorkspaceBoard(
    {
      layout: { selectPanel() {} },
      uiSession: {
        adapter: { current: { getSnapshot: () => ({ key: "s" }) } },
      },
      sidebarRight: {
        mounted: { getSnapshot: () => "s" },
        openTabs: {
          getSnapshot: () => [
            {
              sessionId: "s",
              tabId: "doc-tab",
              kind: "confluence-flow-documents",
            },
          ],
        },
        isExpanded: () => true,
        focus(id) {
          focused = id;
        },
        openTab() {
          opened = true;
        },
        toggleExpanded() {},
      },
    },
    (fn) => fn(),
  );
  assert.equal(focused, "doc-tab");
  assert.equal(opened, false);
});
