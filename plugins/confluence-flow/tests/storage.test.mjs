import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeStorage,
  editStorage,
  withLayout,
} from "../dist/test-exports.js";
import { originalStorage } from "./fixtures/server.mjs";

test("原生布局提供正文区域、目录与不丢失的原文替换范围", () => {
  const result = analyzeStorage(originalStorage);
  assert.equal(result.defaultRegionId, "r1");
  assert.equal(result.sections.length, 4);
  assert.equal(result.sections[1].path, "接口说明 / 请求参数");
  assert.match(result.sections[1].wiki, /旧参数\s+h3\. 校验\s+旧校验/);
  assert.equal(result.lossy, true);
  assert.match(result.warnings.join(" "), /drawio/);
  const section = result.sections[1];
  const edited = editStorage(
    originalStorage,
    "<p>新参数</p>",
    "replace-section",
    section.id,
  );
  assert.equal(
    edited.storage,
    originalStorage.slice(0, section.bodyStart) +
      "<p>新参数</p>" +
      originalStorage.slice(section.end),
  );
  assert.ok(
    edited.storage.includes("<h2>请求参数</h2><p>新参数</p><h2>响应参数</h2>"),
  );
  assert.ok(edited.storage.includes('ac:macro-id="KEEP-EXACT"'));
  assert.ok(!edited.storage.includes("旧校验"));
});
test("追加进入正文而非目录区域", () => {
  const edited = editStorage(originalStorage, "<p>新增内容</p>", "append");
  assert.ok(
    edited.storage.includes(
      '<p>新增内容</p></ac:layout-cell><ac:layout-cell><ac:structured-macro ac:name="toc"',
    ),
  );
});
test("多正文区域拒绝猜选，支持显式区域", () => {
  const xml =
    '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>A</p></ac:layout-cell><ac:layout-cell><p>B</p></ac:layout-cell></ac:layout-section></ac:layout>';
  assert.throws(() => editStorage(xml, "<p>C</p>", "append"), /多个正文区域/);
  assert.ok(
    editStorage(xml, "<p>C</p>", "append", undefined, "r2").storage.includes(
      "<p>B</p><p>C</p>",
    ),
  );
});
test("重复标题用不同 sectionId 定位，保留标题与其他章节", () => {
  const xml = "<h2>参数</h2><p>A</p><h2>参数</h2><p>B</p>";
  const result = analyzeStorage(xml);
  assert.notEqual(result.sections[0].id, result.sections[1].id);
  assert.equal(
    editStorage(xml, "<p>C</p>", "replace-section", result.sections[1].id)
      .storage,
    "<h2>参数</h2><p>A</p><h2>参数</h2><p>C</p>",
  );
});
test("宏中的假标题不可作为顶层章节，代码内容不破坏范围", () => {
  const xml =
    '<h2>正文</h2><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<h1>not a heading</h1>]]></ac:plain-text-body></ac:structured-macro><h2>结束</h2><p>保留</p>';
  const result = analyzeStorage(xml);
  assert.equal(result.sections.length, 2);
  assert.match(result.wiki, /<h1>not a heading<\/h1>/);
});
test("实体只解码一次，中文与代理对不影响源位置", () => {
  const xml =
    "<h1>😀 中文</h1><p>&amp;lt; &lt; &nbsp;</p><h2>下一节</h2><p>结束</p>";
  const result = analyzeStorage(xml);
  assert.match(result.wiki, /&lt; </);
  assert.equal(result.sections[1].start, xml.indexOf("<h2>"));
});
test("合并单元格标记有损，预览保留跨度", () => {
  const result = analyzeStorage(
    '<table><tbody><tr><th>A</th></tr><tr><td colspan="2">B</td></tr></tbody></table>',
  );
  assert.ok(result.lossy);
  assert.match(result.html, /colspan="2"/);
  assert.match(result.wiki, /\|\|A\|\|/);
});
test("预览剥离脚本、事件属性和不安全 URL", () => {
  const result = analyzeStorage(
    '<p onclick="alert(1)">内容<script>alert(2)</script><a href="javascript:alert(3)">链接</a><img src="x" onerror="alert(4)" /></p>',
  );
  assert.doesNotMatch(result.html, /<script|onclick|onerror|javascript:/i);
});
test("right-toc 使用原生布局，完整 wiki 布局不重复包裹", () => {
  const xml = withLayout("<h1>标题</h1>", "right-toc");
  assert.match(xml, /two_right_sidebar/);
  assert.match(xml, /ac:name="toc"/);
  assert.throws(() => withLayout(xml, "right-toc"), /已包含布局/);
  assert.equal(withLayout(xml, "plain"), xml);
});
test("布局属性中的大于号不会截断区域边界", () => {
  const xml =
    '<ac:layout><ac:layout-section><ac:layout-cell data-test="a>b"><h2>标题</h2><p>内容</p></ac:layout-cell></ac:layout-section></ac:layout>';
  assert.equal(analyzeStorage(xml).regions[0].start, xml.indexOf("<h2>"));
});
test("代码 CDATA 中的实体与空行保持原义", () => {
  const code = 'const html = "&lt;tag&gt;";\n\n\nnext();';
  const result = analyzeStorage(
    `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`,
  );
  assert.ok(result.wiki.includes(code));
  assert.ok(result.html.includes("&amp;lt;tag&amp;gt;"));
});
