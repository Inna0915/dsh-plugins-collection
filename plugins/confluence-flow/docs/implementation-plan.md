# Confluence Flow 首版实施计划

日期：2026-10-30。交付范围：开发并安装 DSH 插件，提供 DSH 原生工具、可独立执行的 CLI、stdio MCP，以及 Codex / Claude Code / DSH 可用的 Skills。

## 已验证的基础

- 现有 Obsidian confluence-sync 1.4.0 可以读取私有 Confluence；实际服务器版本为 7.19.4。
- 已用非持久化转换请求验证 wiki 标题、表格、section/column 和 toc 转为 storage。
- 现有插件拆除布局后输出 Markdown，不能作为部分修改的写回底稿。
- Jira Flow 已提供可借鉴的 DPAPI CurrentUser、DSH 工具注册、原生工作区标签和当前会话草稿插入实现。
- 尚未在真实 Confluence 创建或更新页面；真实写入测试需要明确的测试目标。

## 产品与模块

项目位于 D:/dev/vscode/confluence-flow，包名 dsh-confluence-flow，界面名称“Confluence 文档”，工具名 confluence_flow。

核心与 DSH 解耦：core 负责 REST 与 storage；runtime 负责配置、凭据、草稿及提交；dsh 提供原生工具；client 提供搜索、正文/目录、wiki 编辑与预览；cli/mcp 共享同一服务；skills 定义阅读、发布、修改工作流。

首版包含搜索、按 ID/URL 读取、子页面、附件列表、wiki 编写、原生右侧目录布局、新建子页、追加、章节替换、整页更新、版本冲突、提交去重、当前会话草稿插入和工作区分栏。附件上传与全库双向同步后续再评估。

## 配置与凭据

用户目录 ~/.confluence-flow：profiles（非秘密配置）、credentials（DPAPI）、snapshots（读取底稿）、drafts（预览内容）、operations（提交回执）、installation.json（Skill 定位运行层）。配置从用户指定的 Obsidian data.json 导入；不复制内容缓存或密码到项目。新连接默认只读，设置可以启用写入；发布/修改仍需明确指令和 apply=true 或 commit。

Confluence 凭据独立保存，引用 Jira Flow 的保护实现。Windows 用户范围保护并非同一用户下的强隔离。非 Windows 可提供环境变量凭据。工具和 UI 不返回秘密值；UI 的连接管理接口与 agent 工具操作分开。

## 内容与更新契约

- 内容输入是标准 Confluence wiki。服务器完成 wiki → storage 转换；新页面默认包装为 two_right_sidebar，右栏使用 toc 宏。
- 读取返回页面 ID、URL、space、父页、version、wiki、目录、区域和转换限制，同时保存原始 storage。wiki 是阅读/编写表示，不承诺任意旧页面无损反向还原。
- 使用带源位置的 XML 解析树定位可编辑区域和标题；修改时按原始字符区间拼接，区域外内容逐字保留。
- 新建：显式父页 ID/URL，父页所属空间为准。常用父页可保存别名。浏览根页与写入目的地不混用。
- 追加：单正文区域可自动确定；多区域需从 read 返回结果中指定 regionId。
- 章节替换：用 read 返回的 sectionId 定位，保留标题，替换其后的内容至同级或更高级标题之前；包含子章节时在预览中显示完整替换范围。
- 更新必须提供 expectedVersion。预览与提交再次核对版本；HTTP 409 返回冲突，不自动覆盖。
- 原始页面的整页更新是明确操作；存在不能转成 wiki 的宏时不把有损阅读结果自动当成整篇编辑源。
- 草稿绑定连接、目标、内容和预期版本。commit 使用 draftId 与稳定 requestId；同一请求成功后返回原回执；提交超时或响应不明时标记 unknown，禁止自动重发。
- DSH 预览使用安全的本地渲染；服务器动态宏的最终外观以原网页为准。目录根据正文标题构建。

## Agent 入口

DSH 原生工具与 MCP 使用相同 confluence_flow 参数契约：profiles、doctor、search、read、children、attachments、preview、create、update、commit、operation-status。CLI 支持 JSON 文件输入，避免多行 wiki 的 shell 转义。Skills：confluence-query、confluence-publish、confluence-update；在 DSH 注册，并安装到通用 agent、Codex 与 Claude Code 的 Skill 目录。MCP 提供无凭据配置示例，CLI 在安装后立即可用。

## 实施顺序与验收

1. 建立项目、凭据提供器、API 客户端和可执行 CLI；只读连接可用且不输出秘密。
2. 完成 storage 的 wiki/目录转换及保留原文的修改；覆盖布局、宏、重复标题、中文和代码块。
3. 完成草稿、提交、版本冲突和回执；模拟服务验证真实 HTTP 新建、更新、冲突、未知结果不重复提交。
4. 完成 DSH 工具、MCP 和三个 Skills；标准 MCP 客户端验证发现与调用，CLI/Skill 实际读取验证。
5. 完成轻量文档面板，验证左右布局、搜索、发布预览、章节选择、草稿插入和工作区入口。
6. 打包、导入已有凭据、安装 DSH 和 Skills，留下脱敏验证记录和使用说明。

所有安装、构建、测试运行在带超时的 Windows Job Object 中；测试进程退出后检查并清理临时目录。正式安装宿主与用户导出不属于测试清理范围。

## 参考

0.2.0 已落地共享读取层：默认 wiki、8 KiB 输出预算、grep/head、批量 scan、五分钟缓存、快照续读、搜索摘要及总数、返回边界的严格 JSON 规范化。局部编辑标识改用 `read format=outline` 获取，原完整返回可显式使用 `format=full`。实测和兼容说明见 [读取优化记录](read-efficiency-0.2.0.md)。

- https://docs.atlassian.com/ConfluenceServer/rest/7.19.0/
- https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
- https://confluence.atlassian.com/doc/confluence-wiki-markup-251003035.html
- https://confluence.atlassian.com/doc/table-of-contents-macro-182682099.html
- D:/dev/vscode/jira-flow/src/runtime/config.ts
- D:/dev/vscode/jira-flow/src/client/dsh.tsx
- D:/dev/vscode/jira-flow/src/client/composer.ts
