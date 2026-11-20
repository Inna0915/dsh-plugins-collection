import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createHttpHandler,
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
