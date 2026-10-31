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
