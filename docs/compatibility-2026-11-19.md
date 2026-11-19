# Desktop 0.2.2-rc.5 兼容验证与版本限制放宽

日期：2026-11-19。目标版本取自实际安装的 Desktop：`DeepSeek Harness.exe` FileVersion 与 `dsh-app-boot` 的 `getDshRuntimeVersion()` 均为 `0.2.2-rc.5`。

## 原因与修复

本机 Desktop 从 0.2.2-rc.3 升级至 0.2.2-rc.5 后，最近会话 0.1.9 与项目打包 0.1.8 的 `engines.dsh` 均精确枚举到 `0.2.2-rc.3`，重启时被官方 `evaluatePluginCompatibility()` 跳过；两者的 `runtime-status.json` 在升级关停后保持 `active: false`。

核对 `@deepseek-ai/dsh-app-boot` 的准入实现，确认 `satisfies()` 使用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（不声明 `engines.dsh` 或声明下限范围时，后续 prerelease 与正式版均会自动通过）。按用户要求放宽版本号限制：

- **最近会话**升级至 **0.1.11**：`engines.dsh` 由精确枚举改为下限范围 `>=0.2.1-rc.3`，并新增可卸载的 `workspace.picker.directoryFlow` 按需兼容垫片（解决第三方工作区替代插件 `@iroha1145/dsh-modern-ui <= 0.1.22` 未声明 0.2.2-rc.3+ 新增槽位导致官方目录选择器永久阻塞、侧边栏/新建页「添加工作区」消失的问题；当官方 `ui-workspace` 或未来新版第三方插件已声明该槽位时自动静默退让）。
- **项目打包**升级至 **0.1.9**，`engines.dsh` 同步改为 `>=0.2.1-rc.3`。
- **小说阅读**（仓库内未安装）升级至 **0.1.1**，`engines.dsh` 由 `0.2.2-rc.1` 改为 `>=0.2.2-rc.1`。
- 同步更新包版本、最近会话 `package-lock.json`、宿主生命周期回执版本、`dist/` 构建产物、`README.md` 与 `scripts/check-dsh-compatibility.cjs` 版本断言。
- 不使用版本豁免，不改动官方安装文件。

## rc.3 → rc.5 接口核对

将实际安装的 `0.2.2-rc.5` ASAR 内 27 个官方包与 11-14 留存的 `0.2.2-rc.3` 副本逐文件比对：

- 25 个官方包（含 `dsh-client-ui-workspace`、`dsh-client-ui-session`、`dsh-client-ui-layout`、`dsh-client-ui-conversation`、`dsh-client-ui-sidebar-right`、`dsh-workspace`、`dsh-host-webserver`、`dsh-host-directory-picker-native`、`dsh-app-boot`、`dsh-plugin-manager` 等）代码字节级完全一致，仅 `package.json` 版本号递增。
- 仅 `dsh-client-modules/lib/index.js`（`commit` 字符串）和 `dsh-client-ui-sidebar/lib/client.js`（`localBuildVersion()` 返回的版本字符串）有字面量变更，DOM 结构、CSS 类名及客户端/宿主接口均无变化。

## 验证结果

| 项目 | 结果 |
|---|---|
| `Check-DshCompatibility.ps1`（rc.5） | 仓库全部 7 个插件兼容；6 组客户端、6 组宿主接口特征通过；`exemptionsUsed: false` |
| 最近会话 0.1.11 | 24 项测试通过（含 3 项目录选择槽位兼容垫片测试），构建通过，`check-dist.mjs` 注册/卸载检查通过 |
| 项目打包 0.1.9 | 构建通过（client/panel 同步注入 0.1.9），12 项客户端/宿主测试通过 |
| 小说阅读 0.1.1 | 1 项客户端加载注册测试通过 |
| 本地安装与真实 profile 校验 | 通过 PowerShell 7 (`pwsh`) 同步发布文件到 `~/.dsh/local-plugins`（避免 Windows PowerShell 5.1 触发透明加密头）；在 `DeepSeek Harness.exe` 下验证全部安装文件明文可读、SHA-256 与构建产物一致；官方 `loadProfileDirectory()` 解析当前 Desktop profile 全部 12 个 bundle、`skippedBundles: []` |

安装期间未重启运行中的 Desktop；重启 DSH 后将自动加载更新后的插件，届时可核对两个安装目录 `runtime-status.json` 的版本号、`active: true` 与界面展示。
