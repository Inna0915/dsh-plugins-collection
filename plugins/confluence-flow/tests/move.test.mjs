import test from "node:test";
import assert from "node:assert/strict";
import { setup, originalStorage } from "./fixtures/server.mjs";

const call = (context, args) =>
  context.service.execute({ profile: "fixture", ...args });
const puts = (ctx) => ctx.state.writes.filter((row) => row.method === "PUT");

// 合成页面树：100 为根，1 在 100 下且有子页 11，300 为目标目录，400 属于其他空间。
function tree(ctx) {
  const page = (id, title, ancestors, space = "DEMO") => ({
    id,
    type: "page",
    title,
    space: { key: space },
    ancestors: ancestors.map((row) => ({ id: row })),
    version: { number: 1, when: "2026-11-02T08:00:00.000Z" },
    body: { storage: { value: `<p>${title}</p>`, representation: "storage" } },
  });
  ctx.state.pages.get("100").ancestors = [];
  ctx.state.pages.set("11", page("11", "子页", ["100", "1"]));
  ctx.state.pages.set("300", page("300", "02 业务设计", ["100"]));
  ctx.state.pages.set("400", page("400", "其他空间", [], "OTHER"));
}

test("移动预览不写入，返回原父页与目标父页", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const preview = await call(ctx, {
      operation: "move",
      page: "1",
      parent: "300",
    });
    assert.equal(preview.status, "preview");
    assert.equal(preview.version, 3);
    assert.deepEqual(
      [preview.from.id, preview.from.title, preview.to.id, preview.to.title],
      ["100", "项目文档", "300", "02 业务设计"],
    );
    assert.equal(puts(ctx).length, 0);
  } finally {
    await ctx.close();
  }
});

test("提交移动原样回传标题与正文，按小改动提交，重复提交返回原回执", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const input = {
      operation: "move",
      page: "1",
      parent: "300",
      apply: true,
      requestId: "move-once",
    };
    const result = await call(ctx, input);
    assert.equal(result.status, "complete");
    assert.equal(result.changed, true);
    assert.equal(result.version, 4);
    assert.equal(result.to.id, "300");
    const [write] = puts(ctx);
    assert.equal(write.input.body.storage.value, originalStorage);
    assert.equal(write.input.title, "接口说明");
    assert.deepEqual(write.input.ancestors, [{ id: "300" }]);
    assert.equal(write.input.version.number, 4);
    assert.equal(write.input.version.minorEdit, true);
    assert.equal(ctx.state.pages.get("1").ancestors.at(-1).id, "300");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-credential/);

    assert.deepEqual(await call(ctx, input), result);
    assert.equal(puts(ctx).length, 1);
    const status = await call(ctx, {
      operation: "operation-status",
      requestId: "move-once",
    });
    assert.equal(status.kind, "move");
    assert.equal(status.status, "complete");

    // 同一 requestId 不能换目标，也不能挪作页面写入。
    await assert.rejects(
      call(ctx, { ...input, parent: "100" }),
      /已用于其他内容/,
    );
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 4,
        wiki: "正文",
        apply: true,
        requestId: "move-once",
      }),
      /已用于其他内容/,
    );
  } finally {
    await ctx.close();
  }
});

test("已在目标父页下时不发写请求", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const preview = await call(ctx, {
      operation: "move",
      page: "1",
      parent: "100",
    });
    assert.equal(preview.status, "no-change");
    const result = await call(ctx, {
      operation: "move",
      page: "1",
      parent: "100",
      apply: true,
      requestId: "move-noop",
    });
    assert.equal(result.changed, false);
    assert.equal(puts(ctx).length, 0);
  } finally {
    await ctx.close();
  }
});

test("不能移到自身、子页或其他空间，版本不符拒绝", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const move = (parent, extra = {}) =>
      call(ctx, { operation: "move", page: "1", parent, ...extra });
    await assert.rejects(move("1"), /自身或其子页面/);
    await assert.rejects(move("11"), /自身或其子页面/);
    await assert.rejects(move("400"), /其他空间/);
    await assert.rejects(move("300", { expectedVersion: 2 }), /版本 2 变为 3/);
    assert.equal(puts(ctx).length, 0);
  } finally {
    await ctx.close();
  }
});

test("服务器明确拒绝记 failed，回执不明记 unknown 且不再发送", async () => {
  const ctx = await setup();
  try {
    tree(ctx);
    const input = { operation: "move", page: "1", parent: "300", apply: true };
    ctx.state.race = true;
    await assert.rejects(
      call(ctx, { ...input, requestId: "move-race" }),
      /移动状态 failed/,
    );
    ctx.state.failWrite = true;
    await assert.rejects(
      call(ctx, { ...input, requestId: "move-uncertain" }),
      /移动状态 unknown.*禁止自动重发/,
    );
    ctx.state.failWrite = false;
    await assert.rejects(
      call(ctx, { ...input, requestId: "move-uncertain" }),
      /请求已有记录：unknown/,
    );
    assert.equal(puts(ctx).length, 2);
  } finally {
    await ctx.close();
  }
});

test("只读连接可预览移动，但不能提交", async () => {
  const ctx = await setup({ allowWrites: false });
  try {
    tree(ctx);
    const input = { operation: "move", page: "1", parent: "300" };
    assert.equal((await call(ctx, input)).status, "preview");
    await assert.rejects(
      call(ctx, { ...input, apply: true, requestId: "move-readonly" }),
      /未启用写入/,
    );
    assert.equal(puts(ctx).length, 0);
  } finally {
    await ctx.close();
  }
});
