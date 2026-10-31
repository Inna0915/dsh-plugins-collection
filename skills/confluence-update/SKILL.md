---
name: confluence-update
description: 修改已有 Confluence 页面，支持追加正文、替换指定章节和整页更新，保留未修改区域并校验页面版本。
---

# 修改 Confluence 页面

优先使用 `confluence_flow`；无该工具时运行本 Skill 的 `scripts/run.mjs`。更新依据用户明确的修改指令；已有授权无需重复确认。

先 `read` 目标页面；编辑前用 `refresh=true` 获取最新版本，使用返回的 `version` 作为 `expectedVersion`。再对同一 `snapshotId` 用 `format=outline` 获取 `items`，在 `kind=section` 项中找 `id` 作为 `sectionId`，在 `kind=region` 项中找 `id` 作为 `regionId`；有 `nextStart` 时用 `start=nextStart` 继续分页；items 的 storageStart/storageEnd 是 storage 下标，不是 wiki offset。用 `snapshotId + sectionId` 仅读取目标章节，正文未读完时按 `nextOffset` 续读。这些标识只对应本次读取版本；冲突后重新读取和定位。提交始终核对服务器版本，不受阅读缓存影响。

- `append`：追加到正文区域；多区域页面指定 `regionId`。
- `replace-section`：保留章节标题，替换其下正文及子章节，直到下一个同级或更高级标题。使用 `sectionId` 避免同名标题歧义。用户要求修改标题时可明确整页编辑，不能假装此模式改了标题。
- `replace-page`：仅用于用户要求整页重写，或明确授权整体编辑。原页面含复杂宏时，不能直接把有损 wiki 阅读表示覆盖整页。`layout` 只适用于此模式或新建；局部更新保留原布局。

```json
{"operation":"update","page":"12345","expectedVersion":7,"mode":"replace-section","sectionId":"r1-s2","wiki":"替换后的章节正文"}
```

预览返回 `draftId`、修改前后内容、影响范围和 warnings。核对范围后，用 `commit` 携带 `draftId` 和稳定 `requestId` 提交。也可在明确授权下通过 `update` 的 `apply=true`、`requestId` 直接提交。

```text
node <本Skill目录>/scripts/run.mjs read --page PAGE_ID --refresh true
node <本Skill目录>/scripts/run.mjs read --snapshot-id SNAPSHOT_ID --format=outline [--start NEXT_START]
node <本Skill目录>/scripts/run.mjs read --snapshot-id SNAPSHOT_ID --section-id SECTION_ID
node <本Skill目录>/scripts/run.mjs call --input update.json --wiki-file section.wiki
node <本Skill目录>/scripts/run.mjs commit --draft-id DRAFT_ID --request-id REQUEST_ID
node <本Skill目录>/scripts/run.mjs operation-status --request-id REQUEST_ID
```

HTTP 409 或版本变化时重新读取，保留他人的修改后生成新预览；不要递增版本号强行重试原稿。pending / unknown 表示结果待核实，不得换 requestId 重发。报告实际修改范围、页面链接和新版本。

运行层在本机用户目录保存原始 storage 快照，部分修改按源区间拼接；agent 不应自行从 Markdown 重建整页。凭据无需传给工具或写入参数文件。
