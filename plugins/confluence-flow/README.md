# Confluence Flow

Confluence 文档工作台：标准 wiki 读写、正文与右侧目录、页面版本检查，以及 DSH / CLI / MCP / Skills 共用的运行层。

## 当前能力（0.3.0）

- 搜索摘要、总数、空间/标签筛选、明确的多词匹配；按页面 ID 或 URL 精简读取、批量 scan、缓存、grep 和快照续读。
- 标准 Confluence wiki 转 storage，原生 two_right_sidebar + toc 布局。
- 指定父页新建、追加正文、替换章节、整页更新；预览、版本冲突检查和提交回执。
- 本机文件上传为页面附件（0.3.0）：同名附件生成新版本，先预览，逐个文件记录回执，结果不明不重传。
- DSH 全页与工作区分栏，页面加入当前会话草稿，保留已有输入。
- confluence_flow 原生工具和 stdio MCP；confluence-query / confluence-publish / confluence-update Skills。

读取会保留原始 storage 底稿。wiki 是阅读/编写表示，任意旧页面不保证无损反向转换。部分修改保留范围外的原始字符。复杂宏在本地预览显示占位或内容摘要；Jira 宏读取为 `{jira:key=…}` / `{jira:jqlQuery=…}` 引用，可交给 Jira 工具查询，写回时由 Confluence 的格式转换还原为宏；最终动态效果请打开 Confluence 原网页。附件可列表和上传（图片、SVG、drawio、PDF、Office 文档）；本地预览以文本标注图片引用。

局部章节编辑以 `read --format=outline` 返回的章节 items 为准；复杂宏或复杂容器内部的标题不会自动作为替换边界。

## 安装与运行

Node.js 20.19+。Windows 安装、构建和测试使用 scripts/run-bounded.ps1，它以 Job Object 管理进程树和超时。

```powershell
./scripts/run-bounded.ps1 -Executable node -CommandArgs @('C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js','install','--no-audit','--no-fund') -TimeoutSeconds 180
./scripts/run-bounded.ps1 -Executable node -CommandArgs @('scripts/build.mjs') -TimeoutSeconds 90
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add link:D:/dev/vscode/confluence-flow
```

使用 DSH 桌面端随附的 CLI 安装 desktop profile；系统 PATH 中另一版本的 dsh 可能不能管理 desktop。DSH 正常重启或宿主支持的插件重载后，打开“Confluence 文档”。安装是本地链接，移动项目后需要重新安装链接。

```powershell
node D:/dev/vscode/confluence-flow/dist/cli.js auth import-obsidian --source D:/vault/.obsidian/plugins/confluence-sync/data.json
node D:/dev/vscode/confluence-flow/dist/cli.js auth writes --enabled true
node D:/dev/vscode/confluence-flow/dist/cli.js doctor
node D:/dev/vscode/confluence-flow/dist/cli.js skills install
```

Skills 安装到 ~/.agents/skills、~/.codex/skills 和 ~/.claude/skills；已有同名目录保留，不自动覆盖。`--output` 可指定其他路径。DSH 插件同时注册随包的 Skills。每个 Skill 的 scripts/run.mjs 通过 ~/.confluence-flow/installation.json 定位 CLI；不依赖 DSH 保持运行。

## Agent 使用

DSH agent 直接调用 `confluence_flow`。Codex / Claude Code 可通过安装的 Skills 调用 CLI，也可以配置 MCP：

```json
{
  "mcpServers": {
    "confluence-flow": {
      "command": "node",
      "args": ["D:/dev/vscode/confluence-flow/dist/cli.js", "mcp"]
    }
  }
}
```

这是通用 JSON MCP 配置；客户端配置格式可能不同，Codex TOML 示例：

```toml
[mcp_servers.confluence-flow]
command = "node"
args = ["D:/dev/vscode/confluence-flow/dist/cli.js", "mcp"]
```

配置中无需账号、密码或 token。MCP 使用与 DSH 相同的工具名和参数。可用操作：profiles、doctor、search、read、scan、children、attachments、preview、create、update、commit、operation-status。`node dist/cli.js --help` 查看 CLI 参数。

本机交付已通过客户端命令注册，无需重复手动配置。其他机器可使用 `codex mcp add confluence-flow -- node <CLI绝对路径> mcp`，或 `claude mcp add --transport stdio --scope user confluence-flow -- node <CLI绝对路径> mcp`。官方接入说明：[Codex MCP](https://developers.openai.com/codex/mcp)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。

```powershell
node dist/cli.js search --query 接口 --parent 12345
node dist/cli.js read --page 12345
node dist/cli.js scan --pages "12345,23456" --grep "IDOC" --context 120
node dist/cli.js read --snapshot-id SNAPSHOT_ID --grep "字段"
node dist/cli.js call --input request.json --wiki-file document.wiki
node dist/cli.js commit --draft-id DRAFT_ID --request-id UNIQUE_REQUEST_ID
```

### 低开销读取

推荐先搜索一次，根据标题和 snippet 选候选；批量 scan 只拿命中数与首条上下文；再精读相关片段。`scan` 最多 50 页，最多 4 并发，去重，失败页独立返回且不重试。批量降低 agent 调用轮次，底层 Confluence 仍按页面请求。

| 参数/返回值 | 行为 |
| --- | --- |
| `read` / `--format=wiki` | 仅 wiki 与元数据，避免 html/章节/区域重复正文 |
| `--grep IDOC --context 120` | 字面匹配，返回完整正文命中数及两侧片段；默认忽略大小写，可用 `--case-sensitive true` |
| `--head 30` | 最多前 30 行；仍返回续读位置 |
| `--pages "123,456"` | read 批量正文，scan 批量摘要；结果过多按 scanId + nextStart 续读 |
| `--snapshot-id ID --offset N` | 固定版本本地续读；直接使用 nextOffset，单位是 UTF-16 字符位置 |
| `--snapshot-id ID --match-offset N` | grep 命中分页；保留相同 grep/context 条件 |
| `--format=outline [--start N]` | 区域、章节元数据，不含重复正文；按 kind 选 sectionId/regionId。storageStart/storageEnd 为 storage 下标（positionSpace=storage），不能当 offset；不接受 offset/grep/head/sectionId |
| `--refresh true` | 跳过 5 分钟阅读缓存；更新提交始终获取最新版本并校验 |
| `--max-bytes 8192` | read/scan/search 完整紧凑 JSON 的 UTF-8 字节预算，默认 8 KiB，可调 4096–65536 |

`truncated` 表示正文尚未读完；`nextOffset`、`nextMatchOffset`、`nextStart` 分别对应正文、命中、结果行分页。三者越界时报错并返回总数，不静默返回空结果。snapshotId 与 page/refresh 互斥；scanId 续读只需 start 和输出预算。快照与扫描结果复用不请求服务器。

搜索返回 `snippet / totalSize / updated`，按最近修改倒序；`--space` 替代默认根页检索范围，`--parent` 限子树，`--label` 限标签。多词 `--match all` 默认 AND，`any` 为 OR，`phrase` 使用索引短语；索引分词不等同字面匹配。totalSize 是匹配页面数，正文词频由 scan/read grep 提供。为保留候选 ID，输出预算不足时优先缩短 snippet，再分页。

**兼容变化：**0.1.0 的完整 read 改为显式 `--format=full`（wiki/html/sections/regions）；`--raw true` 还返回 storage。完整模式不受默认预算限制，仅用于完整表示或导出。DSH 文档界面已显式使用 full，正文与右侧目录、编辑功能保持可用。普通 agent 检索应使用默认 wiki/scan。预览、写入回执及附件/子页列表沿用原契约，不属于上述 8 KiB 预算范围。

### 写入

创建请求示例：

```json
{"operation":"create","parent":"12345","title":"接口说明","layout":"right-toc"}
```

正文通过 --wiki-file 读取；也可以在 JSON 中提供 wiki 字符串。create/update 默认生成预览草稿；明确授权后使用 commit，或 apply=true + requestId。局部更新需 expectedVersion，replace-section 需 outline 中 kind=section 的 id 作为 sectionId。章节替换保留标题并包含子章节。单个正文区域可自动选择，多区域 append 需 kind=region 的 id 作为 regionId。整篇替换可选择 right-toc 或 plain。

页面版本冲突需要重新读取。提交超时、pending 或 unknown 状态需要核实原页面，不自动重发。相同请求标识不能用于不同内容。预览不修改 Confluence 页面。

## 用户数据

默认 ~/.confluence-flow，可通过 CONFLUENCE_FLOW_HOME 指定。profiles 保存非秘密连接；credentials 保存 Windows DPAPI CurrentUser 密文；snapshots 保存读取底稿；read-cache 保存阅读缓存索引；scans 保存批量摘要及分页结果；drafts 保存待发布内容；operations 保存提交回执；installation.json 记录运行层位置。快照与草稿是用户资料，不属于仓库或测试文件。

每天第一次调用（CLI、MCP、DSH 或界面均可）会先做一次清理，再执行请求：snapshots、scans、read-cache、drafts 保留 7 天，operations 保留 30 天；profiles、credentials、installation.json 不动。同一进程当天后续调用不再检查；多个进程用 maintenance/ 下的当天标记文件抢占，只有一个执行。清理只扫描上述目录，实测十几毫秒，失败不影响本次请求。超过 7 天的 snapshotId 不再可用，需要重新读取；更早的页面内容可在 Confluence 页面历史中找回。

Windows 凭据通过子进程标准输入保护，不放入参数或工具结果。它依赖当前 Windows 用户，不能抵御同一用户下任意代码访问。其他系统使用 credentialStore=environment，变量名为 CONFLUENCE_FLOW_AUTH_<大写连接别名，非字母数字替换为下划线>，值为 basic 或 bearer 认证 JSON；不要在聊天、仓库或配置示例中写真实值。

连接设置支持常用发布位置别名。浏览根页面只影响默认检索，真实写入目标由父页或页面参数确定，并受 Confluence 自身权限约束。

## 独立界面与验证

`node dist/cli.js serve` 在 http://127.0.0.1:43138 提供相同文档面板，Ctrl+C 结束。该入口供用户主动使用，自动化验证启动的服务必须在验证后清理。

实施计划见 docs/implementation-plan.md；[0.2.0 读取优化实测](docs/read-efficiency-0.2.0.md)，首版验证见 docs/verification.md。部分基础设施改编自 MIT 许可的 Jira Flow，许可保留在 LICENSE。
