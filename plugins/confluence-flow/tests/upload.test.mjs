import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setup } from "./fixtures/server.mjs";

const call = (context, args) =>
  context.service.execute({ profile: "fixture", ...args });
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("synthetic image"),
]);
async function files(ctx) {
  const image = path.join(ctx.home, "示例.png");
  const diagram = path.join(ctx.home, "新图.drawio");
  await writeFile(image, PNG);
  await writeFile(diagram, '<mxfile host="test"><diagram id="d"/></mxfile>');
  return [image, diagram];
}

test("上传预览不写入，按文件名标明新版本或新增", async () => {
  const ctx = await setup();
  try {
    const preview = await call(ctx, {
      operation: "upload",
      page: "1",
      files: await files(ctx),
    });
    assert.equal(preview.status, "preview");
    assert.equal(preview.files[0].action, "new-version");
    assert.equal(preview.files[0].attachmentId, "9");
    assert.equal(preview.files[0].currentVersion, 1);
    assert.equal(preview.files[0].mediaType, "image/png");
    assert.equal(preview.files[1].action, "create");
    assert.equal(ctx.state.uploads.length, 0);
  } finally {
    await ctx.close();
  }
});

test("同名附件上传新版本、新文件新增，重复提交返回原回执不重传", async () => {
  const ctx = await setup();
  try {
    const paths = await files(ctx);
    const input = {
      operation: "upload",
      page: "1",
      files: paths,
      comment: "更新时序图",
      apply: true,
      requestId: "upload-once",
    };
    const result = await call(ctx, input);
    assert.equal(result.status, "complete");
    assert.equal(result.complete, true);
    assert.equal(result.files[0].action, "new-version");
    assert.equal(result.files[0].attachment.version, 2);
    assert.equal(result.files[1].action, "create");
    assert.ok(result.files[1].attachment.id);
    assert.equal(ctx.state.uploads.length, 2);
    assert.equal(ctx.state.uploads[0].attachmentId, "9");
    assert.equal(ctx.state.uploads[0].filename, "示例.png");
    assert.equal(ctx.state.uploads[0].minorEdit, "true");
    assert.equal(ctx.state.uploads[0].comment, "更新时序图");
    assert.equal(ctx.state.uploads[1].filename, "新图.drawio");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-credential/);

    assert.deepEqual(await call(ctx, input), result);
    assert.equal(ctx.state.uploads.length, 2);
    const status = await call(ctx, {
      operation: "operation-status",
      requestId: "upload-once",
    });
    assert.equal(status.kind, "upload");
    assert.equal(status.status, "complete");

    // 同一 requestId 不能换文件，也不能挪作页面写入。
    await assert.rejects(
      call(ctx, { ...input, files: [paths[0]] }),
      /已用于其他内容/,
    );
    await assert.rejects(
      call(ctx, {
        operation: "update",
        page: "1",
        expectedVersion: 3,
        wiki: "正文",
        apply: true,
        requestId: "upload-once",
      }),
      /已用于其他内容/,
    );
  } finally {
    await ctx.close();
  }
});

test("内容与扩展名不符、相对路径或不支持的格式在上传前拒绝", async () => {
  const ctx = await setup();
  try {
    const fake = path.join(ctx.home, "伪装.png");
    await writeFile(fake, "not an image");
    const program = path.join(ctx.home, "tool.exe");
    await writeFile(program, "MZ");
    const upload = (paths) =>
      call(ctx, {
        operation: "upload",
        page: "1",
        files: paths,
        apply: true,
        requestId: "upload-invalid-" + path.basename(String(paths[0])).length,
      });
    await assert.rejects(upload([fake]), /内容与扩展名不符/);
    await assert.rejects(upload(["relative.png"]), /绝对路径/);
    await assert.rejects(upload([program]), /不支持的附件格式/);
    assert.equal(ctx.state.uploads.length, 0);
  } finally {
    await ctx.close();
  }
});

test("回执不明记为 unknown，重复提交不再上传", async () => {
  const ctx = await setup();
  try {
    ctx.state.failUpload = true;
    const [image] = await files(ctx);
    const input = {
      operation: "upload",
      page: "1",
      files: [image],
      apply: true,
      requestId: "upload-uncertain",
    };
    const first = await call(ctx, input);
    assert.equal(first.status, "unknown");
    assert.equal(first.files[0].state, "unknown");
    assert.match(first.files[0].error, /不能自动重传/);
    ctx.state.failUpload = false;
    const second = await call(ctx, input);
    assert.equal(second.files[0].state, "unknown");
    assert.equal(ctx.state.uploads.length, 1);
  } finally {
    await ctx.close();
  }
});

test("服务器明确拒绝记为 failed，原 requestId 修正后可重试", async () => {
  const ctx = await setup();
  try {
    ctx.state.rejectUpload = true;
    const [image] = await files(ctx);
    const input = {
      operation: "upload",
      page: "1",
      files: [image],
      apply: true,
      requestId: "upload-retry",
    };
    const first = await call(ctx, input);
    assert.equal(first.status, "failed");
    assert.match(first.files[0].error, /大小限制/);
    ctx.state.rejectUpload = false;
    const second = await call(ctx, input);
    assert.equal(second.status, "complete");
    assert.equal(ctx.state.uploads.length, 2);
  } finally {
    await ctx.close();
  }
});

test("只读连接可预览上传，但不能提交", async () => {
  const ctx = await setup({ allowWrites: false });
  try {
    const paths = await files(ctx);
    const preview = await call(ctx, {
      operation: "upload",
      page: "1",
      files: paths,
    });
    assert.equal(preview.status, "preview");
    await assert.rejects(
      call(ctx, {
        operation: "upload",
        page: "1",
        files: paths,
        apply: true,
        requestId: "upload-readonly",
      }),
      /未启用写入/,
    );
    assert.equal(ctx.state.uploads.length, 0);
  } finally {
    await ctx.close();
  }
});
