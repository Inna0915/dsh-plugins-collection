---
name: confluence-update
description: 修改已有 Confluence 页面，支持追加正文、替换指定章节和整页更新，保留未修改区域并校验页面版本；也可把本机文件上传为页面附件（同名附件生成新版本），或把页面连同子页面移动到同空间的新父页下。
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

需要合并单元格等 wiki 无法表达的格式时，用 `storage`（CLI `--storage-file`）代替 `wiki` 提交 storage XHTML，三种模式都适用；正文原样使用，预览时经服务器解析校验，无法解析即拒绝。

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

## 上传附件

`upload` 把本机文件上传为页面附件，按文件名匹配：页面已有同名附件时上传为新版本（页面里引用该附件的图片和链接自动指向新版本，不用改正文），否则新增附件。只上传用户指定的文件；要替换已有附件，先把本机文件命名为与附件相同的名称。

- `files` 为本机绝对路径（CLI 可用相对路径，英文逗号分隔），每批最多 10 个、单个 50 MB、合计 100 MB；同批文件名不能重复。
- 支持 PNG/JPEG/GIF/WebP/BMP/SVG、`.drawio`、PDF、DOCX/XLSX/PPTX，按文件头校验内容与扩展名一致。
- 先不带 `apply` 预览，确认每个文件的 `action`（`new-version` / `create`）和目标附件；再用相同参数加 `apply=true` 与稳定 `requestId` 上传。`comment` 写入附件版本备注；上传按小改动提交，不通知关注者。

```json
{"operation":"upload","page":"12345","files":["D:\\docs\\时序.drawio","D:\\docs\\时序.png"],"comment":"更新时序图"}
```

```text
node <本Skill目录>/scripts/run.mjs upload --page PAGE_ID --files 时序.drawio,时序.png --comment 更新时序图
node <本Skill目录>/scripts/run.mjs upload --page PAGE_ID --files 时序.drawio,时序.png --comment 更新时序图 --apply true --request-id REQUEST_ID
```

返回逐个文件的 `state`：`uploaded` 带附件 ID 与版本；`failed` 为服务器明确拒绝或上传前校验失败，修正后可用同一 `requestId` 重试；`unknown` 表示回执不明，先用 `attachments` 核实附件，不得自动重传或换 requestId 重发。requestId 不能与页面写入共用。

## 移动页面

`move` 把页面连同全部子页面移到同一空间的新父页下，用于调整页面树。Confluence 7.19 没有独立移动接口，运行层按官方做法在更新请求中替换父页并原样回传正文，因此页面会多一个正文不变的小改动版本，不通知关注者；标题、正文、附件、评论和页面 ID 不变。

- 先不带 `apply` 预览，核对 `from`（原父页）和 `to`（目标父页）；`status=no-change` 表示已在目标下，提交也不会写入。
- 目标是页面自身或其子孙、或在其他空间时拒绝；跨空间移动请在 Confluence 界面操作。可选 `expectedVersion` 防止移动他人刚修改过的页面。
- 确认后用相同参数加 `apply=true` 与稳定 `requestId` 提交；每次移动使用独立 requestId，不与页面写入或上传共用。

```json
{"operation":"move","page":"12345","parent":"67890"}
```

```text
node <本Skill目录>/scripts/run.mjs move --page PAGE_ID --parent NEW_PARENT_ID
node <本Skill目录>/scripts/run.mjs move --page PAGE_ID --parent NEW_PARENT_ID --apply true --request-id REQUEST_ID
```

回执 `changed=true` 带新版本号。服务器明确拒绝（如版本冲突 409）记 failed，重新预览后换新 requestId；`unknown` 表示结果不明，先用 `children` 查看目标父页核实位置，不得自动重发。批量调整先建好目标父页，再逐页移动，整棵子树只需移动其根页。
