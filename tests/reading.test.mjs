import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setup } from "./fixtures/server.mjs";
import {
  ConfluenceService,
  jsonOutput,
  literalMatches,
} from "../dist/test-exports.js";
const exec = promisify(execFile);
const call = (ctx, args) =>
  ctx.service.execute({ profile: "fixture", ...args });
const gets = (ctx) =>
  ctx.state.requests.filter(
    (row) =>
      row.method === "GET" && /^\/rest\/api\/content\/\d+$/.test(row.url),
  ).length;
function page(ctx, id, text) {
  const raw = structuredClone(ctx.state.pages.get("1"));
  raw.id = id;
  raw.title = "Fixture " + id;
  raw.body.storage.value = text;
  ctx.state.pages.set(id, raw);
}

test("默认只返回 wiki，完整 JSON 不超过 8 KiB，并从固定快照无损续读", async () => {
  const ctx = await setup();
  try {
    page(
      ctx,
      "2",
      "<h1>长文</h1><p>" + '中文😀\\"\t IDOC '.repeat(1800) + "</p>",
    );
    const full = await call(ctx, {
      operation: "read",
      page: "2",
      format: "full",
    });
    const first = await call(ctx, { operation: "read", page: "2" });
    assert.equal(first.html, undefined);
    assert.equal(first.sections, undefined);
    assert.equal(first.regions, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
    assert.equal(first.truncated, true);
    const before = gets(ctx);
    let combined = first.wiki;
    let offset = first.nextOffset;
    while (offset !== null) {
      const next = await call(ctx, {
        operation: "read",
        snapshotId: first.snapshotId,
        offset,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 8192);
      assert.ok(next.nextOffset === null || next.nextOffset > offset);
      combined += next.wiki;
      offset = next.nextOffset;
    }
    assert.equal(combined, full.wiki);
    assert.equal(gets(ctx), before);
  } finally {
    await ctx.close();
  }
});
test("缓存跨运行层实例复用，refresh 强制抓取，snapshot 固定版本", async () => {
  const ctx = await setup();
  const other = new ConfluenceService();
  try {
    const first = await call(ctx, { operation: "read", page: "1" });
    const before = gets(ctx);
    ctx.state.pages.get("1").version.number++;
    ctx.state.pages.get("1").body.storage.value = "<p>新版本</p>";
    const cached = await other.execute({
      operation: "read",
      profile: "fixture",
      page: "1",
    });
    assert.equal(cached.source, "cache");
    assert.equal(cached.version, 3);
    assert.equal(gets(ctx), before);
    const fresh = await call(ctx, {
      operation: "read",
      page: "1",
      refresh: true,
    });
    assert.equal(fresh.version, 4);
    assert.equal(gets(ctx), before + 1);
    const old = await call(ctx, {
      operation: "read",
      snapshotId: first.snapshotId,
    });
    assert.equal(old.version, 3);
    assert.equal(gets(ctx), before + 1);
  } finally {
    other.dispose();
    await ctx.close();
  }
});
test("grep 为字面匹配并返回完整计数，可分页命中，不展开正文", async () => {
  const ctx = await setup();
  try {
    page(ctx, "2", "<p>前文 IDoc 参数 idoc 结束 IDOC 与 a.b 和 axb</p>");
    const first = await call(ctx, {
      operation: "read",
      page: "2",
      grep: "idoc",
      context: 3,
      maxMatches: 1,
    });
    assert.equal(first.matchCount, 3);
    assert.equal(first.matches.length, 1);
    assert.equal(first.nextMatchOffset, 1);
    assert.equal(first.wiki, undefined);
    const second = await call(ctx, {
      operation: "read",
      snapshotId: first.snapshotId,
      grep: "idoc",
      context: 3,
      matchOffset: 1,
    });
    assert.equal(second.matches.length, 2);
    assert.equal(second.nextMatchOffset, null);
    assert.equal(
      (await call(ctx, { operation: "read", page: "2", grep: "a.b" }))
        .matchCount,
      1,
    );
    assert.equal(
      (
        await call(ctx, {
          operation: "read",
          page: "2",
          grep: "IDOC",
          caseSensitive: true,
        })
      ).matchCount,
      1,
    );
    assert.equal(
      (await call(ctx, { operation: "read", page: "2", grep: "missing" }))
        .matchCount,
      0,
    );
  } finally {
    await ctx.close();
  }
});
test("Unicode 不区分大小写匹配保留原文偏移", () => {
  const text = "İ前文 😀 IdOc";
  const match = literalMatches(text, "idoc", false, 0)[0];
  assert.equal(match.offset, text.indexOf("IdOc"));
  assert.equal(match.text, "IdOc");
});
test("head 明确返回续读位置，outline 无重复正文，章节局部读取基于同一快照", async () => {
  const ctx = await setup();
  try {
    const first = await call(ctx, { operation: "read", page: "1", head: 2 });
    assert.ok(first.nextOffset > 0);
    assert.ok(first.wiki.split("\n").length <= 3);
    const outline = await call(ctx, {
      operation: "read",
      snapshotId: first.snapshotId,
      format: "outline",
    });
    const section = outline.items.find(
      (row) => row.kind === "section" && row.title === "请求参数",
    );
    assert.ok(section.id);
    assert.equal(section.wiki, undefined);
    const selected = await call(ctx, {
      operation: "read",
      snapshotId: first.snapshotId,
      sectionId: section.id,
    });
    assert.match(selected.wiki, /旧参数/);
    assert.doesNotMatch(selected.wiki, /保留响应/);
  } finally {
    await ctx.close();
  }
});
test("scan 去重、并发读取、部分失败隔离；后续批次分页仅使用本地结果", async () => {
  const ctx = await setup();
  try {
    for (let i = 2; i < 24; i++) {
      page(
        ctx,
        String(i),
        "<p>" + "上下文".repeat(100) + "IDOC" + "后文".repeat(80) + "</p>",
      );
    }
    const refs = [
      "1",
      "1",
      ...Array.from({ length: 22 }, (_, i) => String(i + 2)),
      "404",
    ];
    const first = await call(ctx, {
      operation: "scan",
      pages: refs,
      grep: "IDOC",
    });
    assert.equal(first.stats.requested, 25);
    assert.equal(first.stats.unique, 24);
    assert.equal(first.stats.failed, 1);
    assert.equal(gets(ctx), 24);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
    const rows = [...first.results];
    let start = first.nextStart;
    while (start !== null) {
      const next = await call(ctx, {
        operation: "scan",
        scanId: first.scanId,
        start,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 8192);
      rows.push(...next.results);
      start = next.nextStart;
    }
    assert.equal(rows.length, 24);
    assert.equal(gets(ctx), 24);
    assert.equal(rows.filter((row) => row.status === "error").length, 1);
    assert.ok(
      rows
        .filter((row) => row.id !== "1" && row.status === "ok")
        .every((row) => row.matchCount === 1 && row.matches.length === 1),
    );
    const again = await call(ctx, {
      operation: "scan",
      pages: ["2", "3"],
      grep: "IDOC",
    });
    assert.equal(again.stats.cached, 2);
    assert.equal(again.stats.fetched, 0);
    assert.equal(gets(ctx), 24);
  } finally {
    await ctx.close();
  }
});
test("批量 read 输出可继续到下一页，每页有独立的快照正文续读位置", async () => {
  const ctx = await setup();
  try {
    page(ctx, "2", "<p>" + "内容".repeat(9000) + "</p>");
    page(ctx, "3", "<p>" + "正文".repeat(9000) + "</p>");
    const result = await call(ctx, { operation: "read", pages: ["2", "3"] });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    assert.ok(result.results[0].nextOffset > 0);
    assert.equal(result.nextStart, 1);
    const next = await call(ctx, {
      operation: "read",
      scanId: result.scanId,
      start: 1,
    });
    assert.equal(next.results[0].id, "3");
    assert.equal(gets(ctx), 2);
  } finally {
    await ctx.close();
  }
});
test("写入成功后阅读缓存失效，不返回更新前正文", async () => {
  const ctx = await setup();
  try {
    await call(ctx, { operation: "read", page: "1" });
    await call(ctx, {
      operation: "update",
      page: "1",
      expectedVersion: 3,
      wiki: "追加标记",
      apply: true,
      requestId: "cache-invalidation",
    });
    const result = await call(ctx, { operation: "read", page: "1" });
    assert.equal(result.version, 4);
    assert.match(result.wiki, /追加标记/);
    assert.equal(result.source, "live");
  } finally {
    await ctx.close();
  }
});
test("快照不能跨 profile 使用", async () => {
  const ctx = await setup();
  try {
    const first = await call(ctx, { operation: "read", page: "1" });
    const file = path.join(ctx.home, "snapshots", first.snapshotId + ".json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.profile, "fixture");
    const { saveProfile } = await import("../dist/test-exports.js");
    await saveProfile({
      id: "other",
      host: ctx.host,
      credentialStore: "environment",
    });
    await assert.rejects(
      ctx.service.execute({
        operation: "read",
        profile: "other",
        snapshotId: first.snapshotId,
      }),
      /不属于/,
    );
  } finally {
    await ctx.close();
  }
});
test("搜索返回摘要、总数和更新时间；多词 AND、phrase、空间标签及分页均明确", async () => {
  const ctx = await setup();
  try {
    const result = await call(ctx, {
      operation: "search",
      query: "SAP IDOC",
      space: "DEMO",
      label: "interface",
      limit: 1,
    });
    assert.equal(result.totalSize, 2);
    assert.equal(result.nextStart, 1);
    assert.match(result.results[0].snippet, /IDOC/);
    assert.doesNotMatch(result.results[0].snippet, /<em>|@@@/);
    const cql = new URLSearchParams(ctx.state.requests.at(-1).query).get("cql");
    assert.match(cql, /text~"SAP" AND text~"IDOC"/);
    assert.match(cql, /space="DEMO"/);
    assert.match(cql, /label="interface"/);
    assert.match(cql, /ORDER BY lastmodified DESC/);
    await call(ctx, {
      operation: "search",
      query: "SAP IDOC",
      match: "phrase",
    });
    const phrase = new URLSearchParams(ctx.state.requests.at(-1).query).get(
      "cql",
    );
    assert.ok(phrase.includes('text~"\\"SAP IDOC\\""'));
  } finally {
    await ctx.close();
  }
});
test("严格 JSON 返回处理 undefined，不清洗原始 storage；控制字符能合法传输", async () => {
  const ctx = await setup();
  try {
    page(
      ctx,
      "2",
      '<ac:layout><ac:layout-section><ac:layout-cell><p>A</p></ac:layout-cell><ac:layout-cell><p>B</p><ac:structured-macro ac:name="jira" /></ac:layout-cell></ac:layout-section></ac:layout>',
    );
    const result = await call(ctx, {
      operation: "read",
      page: "2",
      format: "full",
    });
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    assert.equal(Object.hasOwn(result, "defaultRegionId"), false);
    const abnormal = {
      text: "A\u0000\u0001\ud800B😀",
      missing: undefined,
      nested: [undefined, NaN],
    };
    const safe = jsonOutput(abnormal);
    assert.match(safe.text, /\uFFFD/);
    assert.ok(safe.text.includes("\u0000"));
    assert.deepEqual(safe, JSON.parse(JSON.stringify(safe)));
    assert.equal(abnormal.text, "A\u0000\u0001\ud800B😀");
  } finally {
    await ctx.close();
  }
});
test("CLI --format=wiki 和 --pages= 批量入口可执行且输出受限", async () => {
  const ctx = await setup();
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "scan",
        "--profile=fixture",
        "--pages=1,100",
        "--grep=接口",
        "--context=10",
      ],
      { timeout: 20000, windowsHide: true, env: process.env },
    );
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.stats.unique, 2);
    assert.ok(Buffer.byteLength(stdout) <= 8193);
    const read = await exec(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "read",
        "--profile=fixture",
        "--page=1",
        "--format=wiki",
      ],
      { timeout: 20000, windowsHide: true, env: process.env },
    );
    assert.equal(JSON.parse(read.stdout).format, "wiki");
  } finally {
    await ctx.close();
  }
});
test("outline 位置显式标为 storage 坐标，与 wiki offset 不混用", async () => {
  const ctx = await setup();
  try {
    const storage =
      '<h1>版本说明</h1><p><span style="color: rgb(255,0,0);">' +
      "说明".repeat(50) +
      "</span></p><h2>maraidb</h2><p>配置</p>";
    page(ctx, "2", storage);
    const outline = await call(ctx, {
      operation: "read",
      page: "2",
      format: "outline",
    });
    assert.equal(outline.positionSpace, "storage");
    const section = outline.items.find(
      (row) => row.kind === "section" && row.title === "maraidb",
    );
    assert.equal(section.start, undefined);
    assert.equal(section.storageStart, storage.indexOf("<h2>"));
    const read = await call(ctx, {
      operation: "read",
      snapshotId: outline.snapshotId,
    });
    assert.ok(read.wiki.indexOf("maraidb") < section.storageStart);
  } finally {
    await ctx.close();
  }
});
test("越界的 offset、matchOffset、start 明确报错，不静默返回空", async () => {
  const ctx = await setup();
  try {
    page(ctx, "2", "<p>前文 IDOC 结束</p>");
    const first = await call(ctx, { operation: "read", page: "2" });
    const snapshotId = first.snapshotId;
    await assert.rejects(
      call(ctx, { operation: "read", snapshotId, offset: first.totalChars + 5 }),
      /offset.*totalChars=/,
    );
    await assert.rejects(
      call(ctx, { operation: "read", snapshotId, grep: "IDOC", matchOffset: 3 }),
      /matchOffset.*matchCount=1/,
    );
    const outline = await call(ctx, {
      operation: "read",
      snapshotId,
      format: "outline",
    });
    await assert.rejects(
      call(ctx, {
        operation: "read",
        snapshotId,
        format: "outline",
        start: outline.totalItems + 1,
      }),
      /start.*totalItems=/,
    );
    const batch = await call(ctx, { operation: "scan", pages: ["2"] });
    await assert.rejects(
      call(ctx, { operation: "scan", scanId: batch.scanId, start: 5 }),
      /start.*totalResults=1/,
    );
    const tail = await call(ctx, {
      operation: "read",
      snapshotId,
      offset: first.totalChars - 2,
    });
    assert.equal(tail.wiki.length, 2);
    assert.equal(tail.nextOffset, null);
  } finally {
    await ctx.close();
  }
});
test("outline 不接受 offset/grep/head/sectionId，wiki 单页读取不接受 start", async () => {
  const ctx = await setup();
  try {
    const first = await call(ctx, { operation: "read", page: "1" });
    const snapshotId = first.snapshotId;
    for (const extra of [
      { offset: 10 },
      { grep: "接口" },
      { head: 3 },
      { sectionId: "r1-s1" },
    ]) {
      await assert.rejects(
        call(ctx, { operation: "read", snapshotId, format: "outline", ...extra }),
        /outline.*start/,
      );
    }
    await assert.rejects(
      call(ctx, { operation: "read", snapshotId, start: 2 }),
      /offset/,
    );
  } finally {
    await ctx.close();
  }
});
