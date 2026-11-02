import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./fixtures/server.mjs";

const call = (context, args) =>
  context.service.execute({ profile: "fixture", ...args });
const merged =
  '<table><tbody><tr><th>菜单</th><th>页面</th></tr><tr><td rowspan="2">库位监控</td><td>库位信息</td></tr><tr><td>温度信息</td></tr></tbody></table>';

test("storage 新建：预览经服务器校验不写入，提交原样保留合并单元格并包装布局", async () => {
  const ctx = await setup();
  try {
    const draft = await call(ctx, {
      operation: "create",
      parent: "项目文档",
      title: "菜单",
      storage: merged,
    });
    assert.equal(ctx.state.writes.length, 0);
    assert.equal(ctx.state.storageChecks, 1);
    assert.equal(ctx.state.wikiConversions, undefined);
    assert.match(draft.html, /rowspan="2"/);
    assert.match(draft.wiki, /库位监控/);
    const result = await call(ctx, {
      operation: "commit",
      draftId: draft.draftId,
      requestId: "storage-create",
    });
    assert.equal(result.status, "complete");
    const value = ctx.state.writes[0].input.body.storage.value;
    assert.ok(value.includes(merged));
    assert.match(value, /two_right_sidebar/);
  } finally {
    await ctx.close();
  }
});

test("storage 整页替换：plain 布局下提交正文与输入完全一致，版本递增", async () => {
  const ctx = await setup();
  try {
    const result = await call(ctx, {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      mode: "replace-page",
      layout: "plain",
      storage: merged,
      apply: true,
      requestId: "storage-replace",
    });
    assert.equal(result.version, 4);
    assert.equal(ctx.state.pages.get("1").body.storage.value, merged);
    assert.equal(ctx.state.wikiConversions, undefined);
  } finally {
    await ctx.close();
  }
});

test("storage 替换章节：只换选中章节，范围外宏保持原样", async () => {
  const ctx = await setup();
  try {
    await call(ctx, {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      mode: "replace-section",
      sectionId: "r1-s2",
      storage: merged,
      apply: true,
      requestId: "storage-section",
    });
    const value = ctx.state.pages.get("1").body.storage.value;
    assert.ok(value.includes(`<h2>请求参数</h2>${merged}<h2>响应参数</h2>`));
    assert.ok(value.includes("KEEP-EXACT"));
  } finally {
    await ctx.close();
  }
});

test("storage 无法解析时在预览阶段拒绝并带回解析信息；wiki 与 storage 不能同时提供", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 3,
        mode: "replace-page",
        storage: "<p><strong>UNPARSEABLE</p></strong>",
      }),
      /storage 无法解析：.*Unexpected close tag <\/strong>/,
    );
    await assert.rejects(
      call(ctx, {
        operation: "create",
        parent: "项目文档",
        title: "冲突",
        wiki: "正文",
        storage: merged,
      }),
      /只能提供一个/,
    );
    await assert.rejects(
      call(ctx, { operation: "create", parent: "项目文档", title: "空" }),
      /缺少wiki 或 storage 正文/,
    );
    assert.equal(ctx.state.writes.length, 0);
  } finally {
    await ctx.close();
  }
});

test("独立预览接受 storage 并渲染合并单元格", async () => {
  const ctx = await setup();
  try {
    const preview = await call(ctx, {
      operation: "preview",
      storage: merged,
      layout: "plain",
    });
    assert.equal(preview.status, "preview");
    assert.match(preview.html, /rowspan="2"/);
    assert.equal(ctx.state.storageChecks, 1);
  } finally {
    await ctx.close();
  }
});
