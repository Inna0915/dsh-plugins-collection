# Desktop 0.2.2-rc.3 兼容验证

日期：2026-11-14。目标版本取自实际安装的 Desktop：`DeepSeek Harness.exe` FileVersion 与 `dsh-app-boot` 的 `getDshRuntimeVersion()` 均为 `0.2.2-rc.3`。

## 原因与修复

插件页把项目打包 0.1.7、最近会话 0.1.8 标为“已安装，与当前 dsh 不兼容”。两者的 `engines.dsh` 只声明到 `0.2.2-rc.1`，官方 `evaluatePluginCompatibility()` 拒绝了 rc.3。

- 项目打包升级到 0.1.8，最近会话升级到 0.1.9，补充声明 `0.2.2-rc.3`，原有三个版本保留。rc.2 未在本机运行过（2026-11-12 更新时安装器失败），因此不声明。
- 同步了包版本、最近会话 lockfile、宿主运行时回执版本和构建产物。
- 不使用版本豁免，不改动官方安装文件。

## 接口核对

从 rc.3 ASAR 提取官方包，与 11-05 留存的 rc.1 副本对比。rc.3 的官方客户端包改为压缩产物，原检查脚本因此在 `{ wide }` 这一特征上误报。展开压缩代码后逐项核对，两个插件依赖的接口都还在：

- 客户端：`sidebar.footer.action`（仍传入 `{ wide }`）、`main` keyed slot、`layout.selectPanel`、`uiWorkspace.openSession/pinSession/unpinSession/selection`、`view.setGroupExpanded` 与 `dsh.workspace.view.v5`、`uiSession.sessionStatus`；共享模块 `dsh-client-store`（`createSnapshotStore`）、`dsh-client-ui-primitives`（`StateDot`）仍由前端提供。
- DOM：`data-slot` 锚点、`role="tree"`、`data-row-key="workspace:…"`、HoverCard 包装、头部 `span` 标签加 `input[type=text]` 搜索框，以及 `_rowActions`、`_projectText` 类名片段，都保持不变。最近会话样式中的 `[class*="_fade"]` 在 rc.3 已没有可匹配的元素，它原本只用来隐藏装饰层，匹配不到不影响功能。
- 宿主：`webServer.register`（exact）、`workspaceRegistry.list()`、`directoryPicker.capability().pick` 未变；rc.3 的 `dsh-workspace` 只新增了归档后续事件。

`scripts/check-dsh-compatibility.cjs` 现在先去掉空白、统一引号风格，再比对接口特征。对 rc.1 和 rc.3 副本，这套规则都能全部匹配。版本断言补充了 rc.3 应被接受，未核查的 rc.2 和 0.3.0 应被拒绝。

## 验证结果

| 项目 | 结果 |
|---|---|
| `Check-DshCompatibility.ps1`（rc.3） | 项目打包 0.1.8、最近会话 0.1.9 及其余四个已登记插件全部兼容；6 组客户端、6 组宿主接口特征通过；`exemptionsUsed: false` |
| 最近会话 0.1.9 | 21 项测试通过，构建通过，dist 注册/卸载检查通过 |
| 项目打包 0.1.8 | 构建通过（client/panel 注入版本 0.1.8），12 项客户端/宿主测试通过；Python 引擎未改动，未重跑 |
| 本地安装 | 两个插件已复制到 `~/.dsh/local-plugins`，profile 登记内容不变 |

检查脚本同时把未提交、未安装的 `dsh-novel-reader`（只声明 `0.2.2-rc.1`）报为不兼容，本次未处理。

安装时 Desktop 正在运行。被跳过的插件需要重启 DSH 才会加载；重启后核对两个安装目录 `runtime-status.json` 里的版本、当前宿主 PID 和 `active: true`，再做界面验收。

临时提取的宿主副本与脚本位于 `.task-temp/dsh-compat-20261114/`，不纳入提交。
