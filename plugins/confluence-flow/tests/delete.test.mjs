import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  designation,
  dshApply,
  createHttpHandler,
} from "../dist/test-exports.js";
import { setup } from "./fixtures/server.mjs";

const exec = promisify(execFile);
const call = (ctx, args) => ctx.service.execute({ profile: "fixture", ...args });
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/**
 * 合成页面树：100 为空间首页与浏览根页，1 在其下；500「示例接口目录」在 1 下，
 * 子页 501（含孙页 511）与 502（他人近期修改）。
 */
function tree(ctx) {
  const page = (id, title, ancestors, by = "fixture-user", when = "2026-10-01T08:00:00.000Z") => ({
    id,
    type: "page",
    title,
    space: { key: "DEMO" },
    ancestors: ancestors.map((row) => ({ id: row })),
    version: { number: 2, when, by: { username: by, displayName: by } },
    body: { storage: { value: `<p>${title}</p>`, representation: "storage" } },
  });
  ctx.state.pages.get("100").ancestors = [];
  ctx.state.pages.set("500", page("500", "示例接口目录", ["100", "1"]));
  ctx.state.pages.set("501", page("501", "订单接口", ["100", "1", "500"]));
  ctx.state.pages.set("511", page("511", "订单字段", ["100", "1", "500", "501"]));
  ctx.state.pages.set("502", page("502", "库存接口", ["100", "1", "500"], "other-user", RECENT));
  return page;
}
async function preview(ctx, page = "500", keepRoot) {
  return call(ctx, { operation: "delete-preview", page, keepRoot });
}
function remove(ctx, plan, extra = {}, authorize = async () => ({ method: "host" })) {
  return ctx.service.executeDelete(
    {
      profile: "fixture",
      page: plan.root.id,
      token: plan.token,
      title: plan.root.title,
      count: plan.count,
      requestId: "delete-once",
      ...extra,
    },
    authorize,
  );
}
const status = (ctx, id) => ctx.state.pages.get(id).status || "current";

test("删除预览列出整棵子树与他人近期修改，不写入；keepRoot 只列子页面", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const plan = await preview(ctx);
    assert.equal(plan.status, "preview");
    assert.equal(plan.count, 4);
    assert.equal(plan.keepRoot, false);
    assert.deepEqual(plan.pages.map((row) => row.id), ["500", "501", "511", "502"]);
    assert.deepEqual(plan.pages.map((row) => row.depth), [0, 1, 2, 1]);
    assert.equal(plan.maxDepth, 2);
    assert.equal(plan.parent.id, "1");
    assert.deepEqual(plan.recentByOthers.map((row) => row.id), ["502"]);
    assert.ok(plan.token);
    assert.doesNotMatch(JSON.stringify(plan), /modifierKey/);
    const children = await preview(ctx, "500", true);
    assert.equal(children.keepRoot, true);
    assert.equal(children.count, 3);
    assert.deepEqual(children.pages.map((row) => row.id), ["501", "511", "502"]);
    assert.match(children.message, /保留该页面本身/);
    assert.equal(ctx.state.deletes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("拒绝删除浏览根页、发布位置、空间首页和超过上限的子树", async () => {
  const ctx = await setup();
  try {
    const page = tree(ctx);
    await assert.rejects(preview(ctx, "100"), /浏览根页（100）.*发布位置“项目文档”/);
    ctx.state.homepageId = "500";
    await assert.rejects(preview(ctx, "500"), /空间首页/);
    // 保留根页时首页本身不删除，可以删除其子页面。
    assert.equal((await preview(ctx, "500", true)).count, 3);
    ctx.state.homepageId = "100";
    await assert.rejects(preview(ctx, "511", true), /没有子页面/);
    ctx.state.pages.set("600", page("600", "大目录", ["100", "1"]));
    for (let index = 0; index < 100; index++) {
      const id = String(7000 + index);
      ctx.state.pages.set(id, page(id, `子页 ${index}`, ["100", "1", "600"]));
    }
    assert.equal((await preview(ctx, "600", true)).count, 100);
    await assert.rejects(preview(ctx, "600"), /超过 100 页/);
    assert.equal(ctx.state.deletes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("任何一页没有删除权限时，预览与提交都整体拒绝，一页都不删", async () => {
  const ctx = await setup();
  const readOnly = [
    { operation: "read", targetType: "page" },
    { operation: "update", targetType: "page" },
  ];
  try {
    tree(ctx);
    // 服务器返回了 operations 且含 delete 才视为可删；未返回时为未知，不拦截。
    ctx.state.pages.get("501").operations = [...readOnly, { operation: "delete", targetType: "page" }];
    ctx.state.pages.get("511").operations = readOnly;
    await assert.rejects(
      preview(ctx, "500", true),
      /对其中 1\/3 页没有删除权限：《订单字段》（511）。未删除任何页面/,
    );
    delete ctx.state.pages.get("511").operations;
    const plan = await preview(ctx, "500", true);
    ctx.state.pages.get("502").operations = readOnly;
    await assert.rejects(remove(ctx, plan), /没有删除权限：《库存接口》（502）/);
    assert.equal(ctx.state.deletes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("按令牌自下而上删除整棵子树，204 视为成功，重复提交返回原回执且不再授权", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const plan = await preview(ctx);
    const targets = [];
    const authorize = async (target) => {
      targets.push(target);
      return { method: "approved" };
    };
    const result = await remove(ctx, plan, {}, authorize);
    assert.equal(result.status, "complete");
    assert.equal(result.deleted, 4);
    assert.equal(result.authorization, "approved");
    assert.deepEqual(ctx.state.deletes, ["511", "501", "502", "500"]);
    for (const id of ["500", "501", "511", "502"]) {
      assert.equal(status(ctx, id), "trashed");
    }
    assert.equal(status(ctx, "1"), "current");
    assert.deepEqual(
      [targets[0].id, targets[0].title, targets[0].count, targets[0].keepRoot],
      ["500", "示例接口目录", 4, false],
    );
    assert.deepEqual(await remove(ctx, plan, {}, authorize), result);
    assert.equal(targets.length, 1);
    assert.equal(ctx.state.deletes.length, 4);
    const record = await call(ctx, { operation: "operation-status", requestId: "delete-once" });
    assert.equal(record.kind, "delete");
    assert.equal(record.status, "complete");
    assert.ok(record.pages.every((row) => row.state === "trashed"));
    await assert.rejects(
      call(ctx, { operation: "read", page: "500", refresh: true }),
      /页面或接口不存在/,
    );
  } finally {
    await ctx.close();
  }
});

test("keepRoot 只删除子页面，保留根页本身", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const plan = await preview(ctx, "500", true);
    const result = await remove(ctx, plan);
    assert.equal(result.keepRoot, true);
    assert.equal(result.deleted, 3);
    assert.match(result.message, /该页面本身保留/);
    assert.deepEqual(ctx.state.deletes, ["511", "501", "502"]);
    assert.equal(status(ctx, "500"), "current");
  } finally {
    await ctx.close();
  }
});

test("title/count 不符或令牌无效时不授权不删除；授权被拒绝不留记录", async () => {
  const ctx = await setup();
  let asked = 0;
  const authorize = async () => {
    asked++;
    return { method: "host" };
  };
  try {
    tree(ctx);
    const plan = await preview(ctx);
    await assert.rejects(remove(ctx, plan, { count: 3 }, authorize), /与预览不一致/);
    await assert.rejects(remove(ctx, plan, { title: "其他" }, authorize), /与预览不一致/);
    await assert.rejects(remove(ctx, plan, { token: "missing-token" }, authorize), /令牌无效/);
    await assert.rejects(remove(ctx, plan, { page: "501" }, authorize), /不是同一次预览/);
    assert.equal(asked, 0);
    await assert.rejects(
      remove(ctx, plan, {}, async () => {
        throw new Error("用户在确认弹窗中拒绝了删除");
      }),
      /拒绝了删除/,
    );
    assert.equal(ctx.state.deletes.length, 0);
    assert.deepEqual(
      await call(ctx, { operation: "operation-status", requestId: "delete-once" }),
      { status: "not-found" },
    );
    // 未删除任何页面，同一 requestId 可在用户确认后继续使用。
    assert.equal((await remove(ctx, plan, {}, authorize)).status, "complete");
  } finally {
    await ctx.close();
  }
});

test("预览后子树变化（新增子页或页面被修改）时拒绝，不删除任何页面", async () => {
  const ctx = await setup();
  try {
    const page = tree(ctx);
    const plan = await preview(ctx);
    ctx.state.pages.set("503", page("503", "新增接口", ["100", "1", "500"]));
    await assert.rejects(remove(ctx, plan), /子树已变化/);
    ctx.state.pages.delete("503");
    ctx.state.pages.get("511").version.number++;
    await assert.rejects(remove(ctx, plan), /子树已变化/);
    assert.equal(ctx.state.deletes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("中途被拒绝时停止并记录逐页状态；结果不明时停止且不重发", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    ctx.state.rejectDelete = "501";
    const plan = await preview(ctx);
    await assert.rejects(remove(ctx, plan), /已删除 1\/4 页后停止：《订单接口》没有操作权限；删除状态 failed/);
    assert.deepEqual(ctx.state.deletes, ["511", "501"]);
    const record = await call(ctx, { operation: "operation-status", requestId: "delete-once" });
    assert.deepEqual(
      Object.fromEntries(record.pages.map((row) => [row.id, row.state])),
      { 500: "pending", 501: "failed", 511: "trashed", 502: "pending" },
    );
    await assert.rejects(remove(ctx, plan), /已有记录：failed/);
    assert.equal(ctx.state.deletes.length, 2);
  } finally {
    await ctx.close();
  }
  const other = await setup();
  try {
    tree(other);
    other.state.failDelete = "511";
    const plan = await preview(other);
    await assert.rejects(remove(other, plan), /删除状态 unknown.*禁止自动重发/);
    await assert.rejects(remove(other, plan), /已有记录：unknown/);
    assert.deepEqual(other.state.deletes, ["511"]);
  } finally {
    await other.close();
  }
});

test("只读连接可以预览但不能删除", async () => {
  const ctx = await setup({ allowWrites: false });
  try {
    tree(ctx);
    const plan = await preview(ctx);
    await assert.rejects(remove(ctx, plan), /尚未启用写入/);
    assert.equal(ctx.state.deletes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("restore 自上而下恢复并放回原父页，重复提交返回原回执", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    await remove(ctx, await preview(ctx));
    const draft = await call(ctx, { operation: "restore", deleteRequestId: "delete-once" });
    assert.equal(draft.status, "preview");
    assert.equal(draft.restorable, 4);
    assert.deepEqual(draft.pages.map((row) => row.id), ["500", "501", "502", "511"]);
    assert.equal(ctx.state.restores.length, 0);
    await assert.rejects(
      call(ctx, { operation: "restore", deleteRequestId: "delete-once", apply: true, requestId: "delete-once" }),
      /新的 requestId/,
    );
    // 模拟恢复到空间顶层的情况：运行层须把页面移回原父页。
    ctx.state.restoreToTop = true;
    const input = { operation: "restore", deleteRequestId: "delete-once", apply: true, requestId: "restore-once" };
    const result = await call(ctx, input);
    assert.equal(result.status, "complete");
    assert.equal(result.restored, 4);
    assert.deepEqual(ctx.state.restores.map((row) => row.id), ["500", "501", "502", "511"]);
    assert.deepEqual(ctx.state.restores[0].input.status, "current");
    assert.equal(ctx.state.restores[0].input.version.number, 3);
    const parent = (id) => String(ctx.state.pages.get(id).ancestors.at(-1).id);
    assert.deepEqual(
      ["500", "501", "511", "502"].map((id) => [status(ctx, id), parent(id)]),
      [["current", "1"], ["current", "500"], ["current", "501"], ["current", "500"]],
    );
    assert.ok(result.notes.every((row) => row.note === "已移回原父页面"));
    assert.deepEqual(await call(ctx, input), result);
    assert.equal(ctx.state.restores.length, 4);
  } finally {
    await ctx.close();
  }
});

test("恢复被拒绝时提示需要空间管理员权限", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    await remove(ctx, await preview(ctx, "500", true));
    ctx.state.rejectRestore = true;
    await assert.rejects(
      call(ctx, { operation: "restore", deleteRequestId: "delete-once", apply: true, requestId: "restore-1" }),
      /已恢复 0\/3 页后停止：《订单接口》没有恢复权限（恢复回收站页面通常需要空间管理员）/,
    );
  } finally {
    await ctx.close();
  }
});

test("明确指定：须是用户的删除指令，并写明页面与范围", () => {
  const whole = { id: "500", title: "示例接口目录", count: 4 };
  const children = { ...whole, count: 3, keepRoot: true };
  const ok = (messages, target) => designation(messages, target).ok;
  const request = "测试删除示例接口目录这个页面下的所有文档，但是不包括这个页面";
  assert.equal(ok([request], children), true);
  assert.equal(ok([request], whole), false);
  assert.equal(ok(["删除 https://wiki/pages/viewpage.action?pageId=500 及子页"], whole), true);
  assert.equal(ok(["把 示例接口目录连同子页面删掉"], whole), true);
  assert.equal(ok(["删除这个页面及子页 500"], whole), true);
  assert.equal(ok(["删除 500"], whole), false);
  assert.equal(ok(["删除 500"], { ...whole, count: 1 }), true);
  assert.equal(ok(["删除 500 下的所有页面"], whole), false);
  assert.equal(ok(["删除 500 下的所有页面"], children), true);
  assert.equal(ok(["删除 500，不含子页"], whole), false);
  assert.equal(ok(["删除 500 不含子页"], children), false);
  assert.equal(ok(["要删除 500 及子页吗？"], whole), false);
  assert.equal(ok(["怎么删除 500 及子页"], whole), false);
  assert.equal(ok(["删掉 500 页面里的表格"], { ...whole, count: 1 }), false);
  assert.equal(ok(["删除 500 及子页", "等等，先别删"], whole), false);
  assert.equal(ok(["删除 500 及子页", "好的，确认"], whole), true);
  assert.equal(ok(["删除 500 及子页", "500 先看一下"], whole), false);
  assert.equal(ok(["删除 5001 及子页"], whole), false);
  assert.equal(ok(["删除 500 及子页", "a", "b", "c", "d", "e", "f"], whole), false);
  const short = { id: "9", title: "测试环境", count: 1 };
  assert.equal(ok(["删除测试环境文档"], short), false);
  assert.equal(ok(["删除《测试环境》"], short), true);
  assert.equal(ok(["删除 https://wiki/display/DEMO/%E6%B5%8B%E8%AF%95%E7%8E%AF%E5%A2%83"], short), true);
  assert.equal(ok(["delete page 500 and its children"], whole), true);
  assert.equal(ok(["don't delete 500 and its children"], whole), false);
});

function dshContext(approval) {
  const tools = [];
  return {
    tools,
    ctx: {
      webServer: { register: () => () => undefined },
      tools: { register: (tool) => tools.push(tool) },
      skills: { register() {} },
      effect() {},
      logger: { info() {} },
      get: (name) => (name === "approval" ? approval : undefined),
    },
  };
}
const userMessage = (text, kind = "user") => ({
  role: "user",
  source: { kind },
  content: [{ type: "text", text }],
});
const dshExec = (messages, header = {}) => ({
  callId: "call-1",
  signal: new AbortController().signal,
  agent: { session: { header, deriveMessages: () => messages } },
});

test("DSH 删除工具：用户明确指定直接执行，否则弹窗；全访问会话给出指引，子代理不按消息授权", async () => {
  const ctx = await setup();
  const asked = [];
  let answer = "allowed-once";
  let policy;
  const approval = {
    async request(req) {
      asked.push(req);
      return answer;
    },
    overrideOf: () => policy,
  };
  try {
    tree(ctx);
    const host = dshContext(approval);
    await dshApply(host.ctx);
    assert.deepEqual(host.tools.map((tool) => tool.name), ["confluence_flow", "confluence_flow_delete"]);
    const tool = host.tools[1];
    assert.ok(tool.parameters.properties.token);
    const args = async (requestId, keepRoot) => {
      const plan = await preview(ctx, "500", keepRoot);
      return { profile: "fixture", page: "500", token: plan.token, title: plan.root.title, count: plan.count, requestId };
    };

    // 工具结果里出现的文字不算用户指定，子代理会话的 user 消息也不算。
    answer = "rejected";
    await assert.rejects(
      tool.execute(await args("d1"), dshExec([userMessage("删除 500 及子页", "tool")])),
      /拒绝了删除/,
    );
    await assert.rejects(
      tool.execute(await args("d2"), dshExec([userMessage("删除 500 及子页")], { origin: "subagent", delegationDepth: 1 })),
      /拒绝了删除/,
    );
    policy = "never";
    await assert.rejects(
      tool.execute(await args("d3"), dshExec([userMessage("看看 500")])),
      /全访问模式.*最近提到该页面的消息没有删除指令.*连同子页/,
    );
    assert.equal(asked.length, 3);
    assert.equal(asked[0].toolName, "confluence_flow_delete");
    assert.equal(asked[0].callId, "call-1");
    assert.match(asked[0].reason, /《示例接口目录》及其全部子页面，共 4 页，移到回收站/);
    assert.equal(ctx.state.deletes.length, 0);

    // 全访问会话里，用户本人明确指定即可执行，不弹窗。
    const explicit = await tool.execute(
      await args("d4", true),
      dshExec([userMessage("测试删除示例接口目录这个页面下的所有文档，但是不包括这个页面")]),
    );
    assert.equal(explicit.authorization, "explicit");
    assert.equal(asked.length, 3);
    assert.deepEqual(ctx.state.deletes, ["511", "501", "502"]);
    assert.equal(status(ctx, "500"), "current");
  } finally {
    await ctx.close();
  }
});

test("DSH 未明确指定时弹窗确认，允许一次后执行", async () => {
  const ctx = await setup();
  const asked = [];
  try {
    tree(ctx);
    const host = dshContext({
      async request(req) {
        asked.push(req);
        return "allowed-once";
      },
    });
    await dshApply(host.ctx);
    const plan = await preview(ctx, "500", true);
    const result = await host.tools[1].execute(
      { profile: "fixture", page: "500", token: plan.token, title: plan.root.title, count: plan.count, requestId: "d1" },
      dshExec([userMessage("清理一下旧接口文档")]),
    );
    assert.equal(result.authorization, "approved");
    assert.match(asked[0].reason, /《示例接口目录》下的全部子页面共 3 页（保留该页面本身）/);
    assert.equal(ctx.state.deletes.length, 3);
  } finally {
    await ctx.close();
  }
});

test("MCP 单独提供删除工具并标注破坏性；面板接口与非交互 CLI 不能删除", async () => {
  const ctx = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "mcp"],
    env: { ...process.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "verification", version: "1.0.0" });
  const api = createHttpHandler(ctx.service);
  try {
    tree(ctx);
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find((row) => row.name === "confluence_flow_delete");
    assert.equal(tool.annotations.destructiveHint, true);
    assert.ok(tool.inputSchema.required.includes("token"));
    const plan = await preview(ctx, "500", true);
    const deleted = await client.callTool({
      name: "confluence_flow_delete",
      arguments: { profile: "fixture", page: "500", token: plan.token, title: plan.root.title, count: plan.count, requestId: "mcp-1" },
    });
    assert.equal(JSON.parse(deleted.content[0].text).authorization, "host");
    assert.equal(ctx.state.deletes.length, 3);

    // 面板 HTTP 接口只转发通用操作，删除不在其中。
    const sent = [];
    const response = {
      destroyed: false,
      writeHead: (code) => sent.push(code),
      end: (body) => sent.push(JSON.parse(body)),
      on() {},
    };
    const bootstrap = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1" }, url: "/confluence-flow/bootstrap", method: "GET" };
    await api.handler(bootstrap, response);
    const token = sent[1].token;
    sent.length = 0;
    const body = JSON.stringify({ operation: "delete", profile: "fixture", page: "500" });
    const request = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-confluence-flow-token": token },
      url: "/confluence-flow/api",
      method: "POST",
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    };
    await api.handler(request, response);
    assert.equal(sent[0], 400);

    const second = await preview(ctx, "1", true);
    await assert.rejects(
      exec(process.execPath, [
        path.resolve("dist/cli.js"), "delete", "--profile", "fixture", "--page", "1",
        "--token", second.token, "--title", second.root.title, "--count", String(second.count), "--request-id", "cli-1",
      ], { timeout: 30_000, windowsHide: true }),
      (error) => /交互式终端/.test(error.stderr),
    );
    assert.equal(ctx.state.deletes.length, 3);
  } finally {
    api.dispose();
    await client.close();
    await transport.close();
    await ctx.close();
  }
});
