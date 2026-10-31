# 续接整改：立即修复，不重复调研

用户现在明确说“你来安装验收吧”。安装和真实 UI 验收由 Codex 进行，你只负责修复代码、构建和自测。原开发会话曾因用户 Esc 停止 UI 而被监督方结束，保留文件可继续。

首先读 docs/codex-review-round1.md。请逐项落实，重点：

1. data-dsr-hidden 目前没有 display:none 规则，第一版并没有真的隐藏。立即修复并增加实际显示相关回归验证。
2. 将工作区分页控件和最近列表放到工作区树的紧下方（建议已有 footer slot 只作为组件生命周期入口，React portal 到精确定位的新 sibling 容器，宿主原树不改写）。与工作区共享合理滚动区域，不能底部大空白隔开，也不能挤掉原有底部导航和账户。限制 DOM observer 范围，避免自己更改触发无限渲染。
3. 使用官方 root standard hook usePanelInfo，处于全局面板时不高亮 recent，导航回会话再高亮。保证展开5/10/全部与收回5；切换会话保持数量。
4. 去掉未用于产品的 topLevelWorkspaceIds 等逻辑。关键 DOM 测试缺依赖应失败，不能 skip 然后宣称全通过。
5. 核对真实 slot 挂载标记与 DOM 层级，特别是 data-slot 名是否正确、HoverCard 的包装、当前 workspace tree 结构，写最小测试。

原运行时核实已充分，Desktop 就是 0.2.1-rc.3；不要从头查包/重新解析 asar。已有源码在 .task-temp（如有）以及 docs/feasibility.md 记录。主流程直接改现有 src。Codex 正在本项目安装 esbuild/linkedom 的本地依赖，不再依赖其他项目路径（请不要并发 npm install）。可新增 react-dom external（宿主已有）以实现 portal。

这轮目标 8 分钟内完成，外层硬超时 900 秒。所有测试/构建继续通过 scripts/run-bounded.ps1。不要操作 UI，不安装到用户 profile，不结束已有 Desktop 主进程。版本升为 0.1.1，构建并生成标准 tgz，修订 README 与 docs/implementation-report.md；如 npm pack 有 sandbox cache 问题用 --cache .task-temp/npm-cache，不要用全局缓存。不要写声称已 UI 验收的内容。docs/acceptance.md 由 Codex 维护，不要覆盖。

完成后给出简短修复结果与实际验证数字，余下交给 Codex 安装验收。
