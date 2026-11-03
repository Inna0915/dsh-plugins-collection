# Confluence Flow 0.1.0 验证记录

日期：2026-10-30。

## 交付与安装

- 项目 D:/dev/vscode/confluence-flow；通过桌面端自带 CLI 将 dsh-confluence-flow 安装至 DSH desktop profile，依赖与 bundle 均已登记，本地 junction 指向本项目。
- 从用户指定的 Obsidian Confluence Sync 配置导入连接，凭据保存在 ~/.confluence-flow/credentials 的 DPAPI CurrentUser 密文中；读写功能已启用。真实凭据未写入源码、测试、Skill 或 MCP 配置。
- confluence-query、confluence-publish、confluence-update 安装到 ~/.agents/skills、~/.codex/skills、~/.claude/skills，并通过 DSH 插件注册。
- Codex 全局和 Claude Code user scope 均已配置 confluence-flow stdio MCP，命令使用本机 Node 的绝对路径。Codex get 显示 enabled=true；Claude Code get 显示 Connected。
- 用户正在使用的 DSH 未被重启。正常重启或插件重载后加载新插件；其他客户端的新会话可发现 MCP/Skills。

## 自动验证

- TypeScript 检查、构建通过，28 项测试全部通过。
- 覆盖实际 HTTP 读取/创建/更新，原生布局，章节边界与子章节，重复标题，区域选择，保留范围外宏和目录，XML 属性含大于号，中文与代理对，代码 CDATA、实体和空行，合并单元格标记，以及不完整响应拒绝写回。
- 覆盖预览不写入、同请求回执重放、不同内容拒绝复用请求 ID、提交前版本冲突、服务器竞争冲突、未知结果禁止重发、只读连接、异域页面链接拒绝发送认证。
- MCP 标准客户端实际发现 confluence_flow 并读取页面、生成预览；DSH 工具和 3 个 Skills 注册测试通过。HTTP 验证本机 Host、来源与页面令牌。
- 三个 Skills 通过 skill-creator 的 quick_validate.py；三个客户端安装目录的脚本入口均实际返回连接列表。

## 真实 Confluence 核验

- 服务器版本 7.19.4。新运行层认证、CQL 搜索、正文读取及 wiki 转 storage 成功。
- 通过运行层和标准 MCP 客户端读取同一真实页面成功；返回原始版本与 wiki 阅读表示，保存原始 storage 底稿。验证摘要仅记录数量，不将真实正文留在仓库。
- 使用合成 wiki 验证原生正文/右侧目录布局预览，转换结果包括标题与表格。
- 真实页面创建/修改请求为 0；生产页面的实际写入权限和动态宏最终渲染尚未进行写入验证。

## 界面与 DSH 宿主

- 独立模拟服务通过 UI 创建“订单接口说明”，发布为父页子页面，再替换“返回结果”章节，版本从 1 到 2，其他正文和目录保留。
- 使用已安装 DSH 的真实运行时，创建隔离 home 与合成 Confluence 数据，未调用模型或发送会话消息。
- DSH 侧边栏显示“Confluence 文档”；全页面板和原生工作区分栏加载成功，窄面板按容器宽度适配，正文与目录并排。
- “添加到会话”保留原草稿并加入页面内容、链接与版本；刷新后草稿和分栏仍在。模拟数据截图保存在 docs/assets/dsh-workspace.jpg，草稿场景截图保存在 docs/assets/dsh-draft.jpg。
- 浏览器控制台 error/warn 为空。

## 首版边界

- 普通正文和标准标题支持局部修改；复杂宏或复杂容器内部的标题不自动作为可编辑章节，工具会要求选择受支持的范围。
- wiki 是读取与编写表示，不保证任意旧页面无损反向还原；特殊宏和合并表格有提示，修改底稿保留原始 storage。
- 图片引用与附件列表可读取；首版不上传附件，本地预览不完整渲染图片或动态宏。

## 进程与临时文件

- 安装、构建、测试和验证均在带超时的 Windows Job Object 中运行，已结束命令的进程树活动数为 0。
- 独立模拟 UI 服务达到预设时限后由 Job Object 清理；隔离 DSH 宿主也已结束。43139、43140 测试端口均无监听，用户的实际 DSH 宿主未被停止。
- 已移除隔离宿主指向正式项目的临时 junction。整块临时目录递归删除及移除链接后的逐项清理均被自动安全审核拒绝，工具只返回 blocked by policy，未提供具体原因。
- 因此 .task-temp 暂留：native-host.mjs（隔离宿主脚本）、native-host（隔离宿主数据）、skill-validator（PyYAML 校验依赖）、test-M19os7 与 test-mzuA31（合成服务数据）。这些文件均不打包，不应误报为已清理。
- 正式保留的交付文件为源码/构建、发布包、本文档与模拟 UI 截图；用户目录中的连接密文、运行层位置与页面读取底稿服务于后续使用。

## 2026-10-31 Jira 宏阅读表示

改动：wiki 阅读表示与本地预览把带 key 或 jqlQuery 的 Jira 宏输出为 `{jira:key=…|server=…}` / `{jira:jqlQuery=…}`；仍标记 lossy 并保留原始 storage，编辑保护不变。写回时由 Confluence 的格式转换接口解析该语法。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 44/44 通过，新增合成用例覆盖表格内任务号引用（参数分隔符按单元格规则转义）、JQL 引用、lossy 与预览。

真实页面只读对照：一份含 4 个 Jira 宏的会议页，改动前 grep 任务号命中 0，改动后命中 4。未修改任何页面。

## 2026-10-31 本地数据每日清理

改动：service.execute 入口先调用 dailyMaintenance：snapshots、scans、read-cache、drafts 保留 7 天，operations 保留 30 天；profiles、credentials、installation.json 不动。同进程当天只检查一次，跨进程用 maintenance/<本地日期> 独占创建抢占，异常不影响请求。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 45/45 通过，新增用例覆盖各目录保留期、凭证与配置不动、同日与其他进程已执行时跳过。

用户目录实测：当天首次清理约 12 ms（无超龄文件，删除 0 个）；同进程再次调用约 0 ms；其他进程约 5 ms。

## 2026-11-02 附件上传（0.3.0）

改动：新增 `upload` 操作，把本机文件上传为页面附件；按文件名匹配，已有同名附件走 `/child/attachment/{id}/data` 上传新版本，否则新增。只收本机绝对路径（CLI 可用相对路径），白名单为图片、SVG、drawio、PDF、Office 文档，按文件头校验内容与扩展名一致；每批最多 10 个、单个 50 MB、合计 100 MB。先预览，`apply=true` + 稳定 requestId 提交；进度逐个文件记录在 operations 目录（与页面写入共用，requestId 不能跨用途复用），发送前先记 uploading，回执不明记 unknown 且不重传，服务器明确拒绝记 failed 可用原 requestId 重试。multipart 请求带 `X-Atlassian-Token: no-check`、按小改动提交、超时 120 s。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 51/51 通过，新增 6 个合成用例覆盖预览不写入、同名新版本与新增、重复提交不重传、requestId 不可换文件或挪作页面写入、格式/路径校验、unknown 不重传、failed 可重试、只读连接不能提交。

真实页面实测（用户指定的内部时序页）：CLI 预览识别 2 个文件均为新版本；提交后 drawio 与 PNG 各生成新版本，中文文件名保持不变，附件大小与本地一致；同一 requestId 再次提交返回原回执，未产生新版本。MCP 工具需重连后才加载 upload。

## 2026-11-02 页面移动（0.4.0）

改动：新增 `move` 操作，把页面连同子页面移到同空间新父页下。7.19 REST 没有独立移动接口（资源列表 `content/{id}/label` 之后即 `content/{id}/property`），按官方文档在 `PUT /rest/api/content/{id}` 中替换 `ancestors`；正文原样回传 GET 得到的 storage，版本 +1 并带 `minorEdit`，不通知关注者。新增 `node` 读取层级元数据（不含正文）。先预览，已在目标下返回 no-change 且不写；目标为自身/子孙或跨空间时拒绝；可选 expectedVersion。回执记在 operations（kind=move），requestId 不能与页面写入或上传共用；服务器明确拒绝记 failed，回执不明或父页不符记 unknown，禁止自动重发。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 57/57 通过，新增 6 个合成用例覆盖预览不写入、原样回传标题与正文、minorEdit 与版本号、重复提交返回原回执、requestId 不可换目标或挪作页面写入、无变化不写、成环/跨空间/版本不符拒绝、竞争 409 记 failed、回执不明记 unknown 不重发、只读连接不能提交。

真实空间实测（用户指定的 FMS 文档树重组）：只读预览识别 no-change 与原/目标父页；首个页面移动前后 storage 的 sha256 与长度一致，版本 4→5。随后 37 次移动全部 complete，逐页遍历结果原有 93 页齐全、无缺失。MCP 工具需重连后才加载 move；CLI 与 Skill 脚本立即可用。

## 2026-11-02 storage 正文输入（0.5.0）

改动：create/update/preview 可用 `storage`（CLI `--storage-file`）代替 `wiki`，二者只能提供一个，用于合并单元格等 wiki 无法表达的格式。storage 原样使用（right-toc 仍包装布局，update 三种模式均可），预览阶段经服务器 `convert/view` 非持久化转换校验：真实服务器对无法解析的 storage 仍返回 200，正文为 `fatal-render-error` 错误块，因此按错误块判定并带回解析位置。草稿的 wiki 为 storage 的阅读表示，提交、版本校验、回执与原流程相同。

真实服务器只读探测（非持久化转换）：合法 storage 的 rowspan 原样保留；未闭合标签、裸 `&`、交错闭合三类错误均返回 200 + fatal-render-error，并给出行列位置。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 62/62 通过，新增 5 个合成用例覆盖 storage 新建（不调用 wiki 转换、保留 rowspan、包装布局）、整页替换原样提交、章节替换保留范围外宏、无法解析时预览即拒绝并带回解析信息、wiki 与 storage 互斥及缺正文提示、独立预览渲染合并单元格。

真实页面实测（用户指定的 FMS 菜单文档两页）：以 storage 整页替换为合并单元格表格，服务器回读主表 115 行 / 26 处 rowspan、95 行 / 31 处 rowspan，按跨行推算网格零错误；表格 tbody 与提交内容逐字一致，正文其他位置仅有服务器实体规范化（如 → 存为 &rarr;）。

## 2026-11-03 删除到回收站（0.6.0）

改动：新增 `delete-preview`（只读）与独立工具 `confluence_flow_delete`，把页面连同子页面，或只把某页下的子页面（`keepRoot`）移到回收站，单次最多 100 页；新增 `restore` 按删除记录自上而下恢复并放回原父页。预览令牌 30 分钟有效，绑定页面集合与版本，提交前重新列出比对。拒绝空间首页、连接配置的根页/发布位置，以及当前账号没有删除权限的页面（`expand=operations`），权限整体预检，避免删到一半。删除自最深层逐页进行，每页先记 deleting；4xx 记 failed、其他记 unknown，均立即停止不重发。底层请求把 204 识别为成功。

授权：DSH 工具在顶层会话中核对用户本人最近消息是否明确指定（删除指令、页面 ID/链接/完整标题、范围一致，排除否定、询问、局部删除），否则经 `ctx.approval` 在本次工具调用上弹窗；全访问会话（policy never）不能弹窗，未明确指定时拒绝并提示。MCP 工具标注 destructiveHint，由客户端确认。CLI `delete` 需交互式终端输入根页标题。通用工具、本机面板接口不接受删除。

检查（均经 run-bounded.ps1）：build、`tsc --noEmit` 通过；`node --test` 77/77 通过，新增 15 个合成用例覆盖预览不写入与 keepRoot、保护页与上限、权限整体预检、自下而上顺序与 204、重复提交不再授权、参数不符与授权拒绝不留记录、预览后变化拒绝、中途 failed/unknown 停止不重发、只读连接、恢复与移回原父页、恢复权限不足、“明确指定”判定、DSH 明确指定/弹窗/全访问/子代理、MCP 注解、面板接口与非交互 CLI 拒绝删除。

真实服务器实测（用户指定删除 FMS 接口目录下全部文档、保留该页）：只读预览列出 13 页（深 2 层，无他人近期修改）；用户原话经“明确指定”判定为 keepRoot 范围一致。首个叶子页 DELETE 返回 403，运行层立即停止记 failed，13 页全部保留。只读探测确认 7.19 支持 `expand=operations`：当前账号对自己创建的根页有 `delete:page`，对其他作者创建的 13 个子页只有 read/update。据此加入权限预检后重跑预览，直接拒绝并列出 13/13 页无删除权限，未发出任何删除请求。删除成功（204）与恢复路径尚未在真实服务器验证。

删除成功路径（用户指定删除 FMS 归档目录下的一篇说明单页）：只读预览为 1 页、无子页、权限预检通过；用户原话经“明确指定”判定通过后执行，真实服务器 DELETE 返回 204，回执 complete。只读核实：页面状态 trashed，`?status=trashed` 可读到且版本不变（v3），原父页子页列表已无该页，`restore` 预览显示可恢复。回收站中页面的 REST 响应不含 ancestors，恢复依赖删除记录中保存的原父页 ID。恢复（apply）尚未在真实服务器执行。
