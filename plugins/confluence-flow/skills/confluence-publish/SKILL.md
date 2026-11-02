---
name: confluence-publish
description: 将标准 Confluence wiki 内容（或需要合并单元格等格式时的 storage XHTML）发布为指定父页面下的子页面，支持正文在左、目录在右的布局及发布预览。
---

# 发布 Confluence 文档

优先调用 `confluence_flow`；不可用时使用本 Skill 的 `scripts/run.mjs`。凭据由独立运行层处理。

实际发布依据用户明确的发布指令；已有授权且目标清楚时无需重复确认。没有明确目标时先查找候选父页，不凭标题猜选。父页可用 ID、完整页面链接或配置的位置别名；空间由父页确定。

正文用标准 wiki：`h1.` / `h2.` 标题，`||表头||` / `|单元格|` 表格，`{code:language=java}` 代码宏，`[文字|URL]` 链接。不要把 Markdown 代码围栏直接当作 wiki。普通正文默认 `layout="right-toc"`；正文已经包含 section/column 或完整布局时用 `layout="plain"`，避免重复嵌套。

wiki 无法表达合并单元格（rowspan/colspan）。需要合并单元格时改用 `storage` 字段（CLI `--storage-file`）提交 Confluence storage XHTML，与 `wiki` 二选一：表格用 `<td rowspan="N">`，页面链接用 `<ac:link><ri:page ri:content-title="标题"/></ac:link>`，文本中的 `&`、`<`、`>` 转义。正文原样提交，预览时由服务器解析校验，无法解析会带回行列位置。合并单元格的表格在 Confluence 中通常不能按表头排序。

推荐生成预览后提交同一草稿：

```json
{"operation":"create","parent":"12345","title":"接口说明","wiki":"h1. 接口说明\n\nh2. 参数\n\n正文","layout":"right-toc"}
```

预览返回 `draftId`、目标信息、变化内容和 warnings。确认它符合当前用户要求后调用：

```json
{"operation":"commit","draftId":"预览返回值","requestId":"本次发布唯一且稳定的标识"}
```

CLI 可把参数放入 JSON 文件、正文放入 UTF-8 `.wiki` 文件：

```text
node <本Skill目录>/scripts/run.mjs call --input request.json --wiki-file content.wiki
node <本Skill目录>/scripts/run.mjs commit --draft-id DRAFT_ID --request-id REQUEST_ID
```

也可在 `create` 中设置 `apply=true` 和 `requestId` 直接发布。连接需启用写入。保持同次提交的 requestId 不变；遇到超时、pending 或 unknown，先查询 `operation-status` 并核实目标页面，不能更换 ID 自动重建。报告最终页面链接、版本和失败情况。第一版不上传附件，不能宣称引用的本地图片已上传。
