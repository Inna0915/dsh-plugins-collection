import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setup, originalStorage } from "./fixtures/server.mjs";

const call = (context, args) =>
  context.service.execute({ profile: "fixture", ...args });
test("不完整的页面响应不会当作空正文覆盖", async () => {
  const ctx = await setup();
  try {
    delete ctx.state.pages.get("1").body;
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 3,
        wiki: "新内容",
        apply: true,
        requestId: "incomplete",
      }),
      /不能作为修改底稿/,
    );
    assert.equal(ctx.state.writes.length, 0);
  } finally {
    await ctx.close();
  }
});
test("读取、搜索、子页、附件经真实 HTTP 返回，不暴露凭据", async () => {
  const ctx = await setup();
  try {
    const page = await call(ctx, {
      operation: "read",
      page: ctx.host + "/pages/viewpage.action?pageId=1",
      format: "full",
    });
    assert.equal(page.version, 3);
    assert.equal(page.storage, undefined);
    assert.equal(page.sections.length, 4);
    const snapshot = JSON.parse(
      await readFile(
        path.join(ctx.home, "snapshots", page.snapshotId + ".json"),
        "utf8",
      ),
    );
    assert.equal(snapshot.storage, originalStorage);
    assert.ok(
      (await call(ctx, { operation: "search", query: "接口" })).results.length,
    );
    assert.equal(
      (await call(ctx, { operation: "children", page: "100" })).results[0].id,
      "1",
    );
    assert.equal(
      (await call(ctx, { operation: "attachments", page: "1" })).results[0]
        .title,
      "示例.png",
    );
    assert.doesNotMatch(JSON.stringify(page), /synthetic-credential/);
  } finally {
    await ctx.close();
  }
});
test("新建预览不写入，提交到指定父页，重复提交返回同一回执", async () => {
  const ctx = await setup();
  try {
    const draft = await call(ctx, {
      operation: "create",
      parent: "项目文档",
      title: "新文档",
      wiki: "h1. 新文档\n\n正文",
    });
    assert.equal(ctx.state.writes.length, 0);
    assert.equal(draft.parentId, "100");
    const result = await call(ctx, {
      operation: "commit",
      draftId: draft.draftId,
      requestId: "create-once",
    });
    assert.equal(result.status, "complete");
    assert.equal(ctx.state.writes[0].input.space.key, "DEMO");
    assert.equal(ctx.state.writes[0].input.ancestors[0].id, "100");
    assert.match(
      ctx.state.writes[0].input.body.storage.value,
      /two_right_sidebar/,
    );
    assert.deepEqual(
      await call(ctx, {
        operation: "commit",
        draftId: draft.draftId,
        requestId: "create-once",
      }),
      result,
    );
    assert.equal(ctx.state.writes.length, 1);
  } finally {
    await ctx.close();
  }
});
test("章节更新保留其他宏，版本递增", async () => {
  const ctx = await setup();
  try {
    const result = await call(ctx, {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      mode: "replace-section",
      sectionId: "r1-s2",
      wiki: "新参数",
      apply: true,
      requestId: "update-section",
    });
    assert.equal(result.version, 4);
    const value = ctx.state.pages.get("1").body.storage.value;
    assert.ok(
      value.includes("<h2>请求参数</h2><p>新参数</p><h2>响应参数</h2>"),
    );
    assert.ok(value.includes("KEEP-EXACT"));
    assert.match(value, /ac:name="toc"/);
  } finally {
    await ctx.close();
  }
});
test("重复 apply 请求在页面版本变化后也返回原回执", async () => {
  const ctx = await setup();
  try {
    const input = {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      mode: "append",
      wiki: "追加",
      apply: true,
      requestId: "stable-apply",
    };
    const result = await call(ctx, input);
    assert.deepEqual(await call(ctx, input), result);
    assert.equal(ctx.state.writes.length, 1);
    await assert.rejects(
      call(ctx, { ...input, wiki: "不同的内容" }),
      /其他内容/,
    );
  } finally {
    await ctx.close();
  }
});
test("预览之后他人修改则拒绝提交，不覆盖新版本", async () => {
  const ctx = await setup();
  try {
    const draft = await call(ctx, {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      wiki: "追加",
    });
    ctx.state.pages.get("1").version.number = 4;
    await assert.rejects(
      call(ctx, {
        operation: "commit",
        draftId: draft.draftId,
        requestId: "conflict",
      }),
      /版本 4/,
    );
    assert.equal(ctx.state.writes.length, 0);
  } finally {
    await ctx.close();
  }
});
test("提交竞争由服务器版本检查拒绝，记录失败", async () => {
  const ctx = await setup();
  try {
    ctx.state.race = true;
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 3,
        wiki: "追加",
        apply: true,
        requestId: "race",
      }),
      /failed/,
    );
    assert.equal(
      (await call(ctx, { operation: "operation-status", requestId: "race" }))
        .status,
      "failed",
    );
  } finally {
    await ctx.close();
  }
});
test("不确定写入记录 unknown，重复提交不再发请求", async () => {
  const ctx = await setup();
  try {
    ctx.state.failWrite = true;
    const input = {
      operation: "create",
      parent: "100",
      title: "新文档",
      wiki: "正文",
      apply: true,
      requestId: "uncertain",
    };
    await assert.rejects(call(ctx, input), /unknown/);
    await assert.rejects(call(ctx, input), /unknown/);
    assert.equal(ctx.state.writes.length, 1);
  } finally {
    await ctx.close();
  }
});
test("只读连接可预览，但不能提交", async () => {
  const ctx = await setup({ allowWrites: false });
  try {
    const draft = await call(ctx, {
      operation: "create",
      parent: "100",
      title: "预览",
      wiki: "正文",
    });
    await assert.rejects(
      call(ctx, {
        operation: "commit",
        draftId: draft.draftId,
        requestId: "readonly",
      }),
      /未启用写入/,
    );
    assert.equal(ctx.state.writes.length, 0);
  } finally {
    await ctx.close();
  }
});
test("不向页面链接中的其他主机发送认证", async () => {
  const ctx = await setup();
  try {
    const count = ctx.state.requests.length;
    await assert.rejects(
      call(ctx, {
        operation: "read",
        page: "http://other.invalid/pages/viewpage.action?pageId=1",
      }),
      /不属于/,
    );
    assert.equal(ctx.state.requests.length, count);
  } finally {
    await ctx.close();
  }
});
test("更新必须提供读取版本，局部更新不修改布局", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      call(ctx, { operation: "update", page: "1", wiki: "内容" }),
      /expectedVersion/,
    );
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 3,
        wiki: "内容",
        layout: "plain",
      }),
      /局部修改保留原布局/,
    );
  } finally {
    await ctx.close();
  }
});
