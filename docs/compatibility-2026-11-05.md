# Desktop 0.2.2-rc.1 兼容验证

日期：2026-11-05。目标版本来自实际安装的 Desktop `app.asar` 内 `@deepseek-ai/dsh` / `dsh-app-boot` 的 package.json；不使用系统 CLI 或旧的依赖缓存版本判断。

## 原因与修复

项目打包 0.1.6、最近会话 0.1.7 的 `engines.dsh` 仅声明 `0.2.1-rc.3 || 0.2.1-rc.5`。新版官方 `evaluatePluginCompatibility()` 拒绝这两个包，profile 加载器将其放入 `skippedBundles`，因此客户端入口也不出现。

- 项目打包更新至 0.1.7，最近会话更新至 0.1.8，补充经核查的 `0.2.2-rc.1`，保留原先两个版本。
- 同步包版本、最近会话 lockfile、宿主生命周期回执版本和构建产物。打包面板的懒加载版本继续由 package.json 注入。
- 新增 `scripts/Check-DshCompatibility.ps1`，使用真实 Desktop 的官方准入函数复现旧声明拒绝、验证新声明接受，并保留未核查的 0.3.0 拒绝检查。
- 核对主面板与侧栏 slots、工作区导航/折叠/置顶、会话状态、输入草稿与附件、右侧分栏、HTTP 路由、目录选择、会话查询/派发及审批接口。六个插件使用的接口仍存在；未发现需要修改其余四个插件业务代码的新版兼容问题。
- 不使用版本豁免，不改写官方安装文件。精确声明仅代表已核查的版本；后续升级仍需重跑检查和验收。

## 验证结果

| 插件 | 版本 | 结果 |
|---|---|---|
| 项目打包 | 0.1.7 | 构建通过；12 项客户端/宿主测试通过 |
| 最近会话与工作区折叠 | 0.1.8 | 构建通过；21 项行为测试及 dist 注册/卸载检查通过 |
| Jira 任务看板 | 0.1.8 | TypeScript 检查通过；54 项测试通过 |
| Confluence 文档 | 0.6.0 | TypeScript 检查通过；77 项测试通过 |
| 会话看板 | 0.6.0 | Node 测试 153 项、Python 测试 8 项通过 |
| 饭否午晚 | 1.0.0 | batch、reminder 两组模拟测试通过 |

合计 325 项测试及订餐两组检查。默认 Node 20 下发现的 SQLite/运行时差异已用 Desktop 内置 Node 24.21.0 复核，Jira 和会话看板全部通过。没有通过删改测试掩盖失败。

通过官方 `loadProfileDirectory()` 在隔离的 profile 副本中核查安装结果，六个本地 bundle 均成功解析、无跳过项。对比源码构建与安装副本的 SHA-256，项目打包的 manifest、host/client/runtime/panel 和引擎文件，以及最近会话的 manifest、host/client 文件全部一致。

2026-11-05 00:44（Asia/Shanghai），真实 Desktop 的两个回执均为新版本、`active: true`，属于同一个现存宿主；项目打包尚未启动引擎。用户随后确认界面手动验收完成。自动化界面操作在用户按 Esc 后停止，最终视觉验收采用用户确认。

验证限于插件加载契约、已有模拟/本地测试和用户界面验收。本次未执行真实项目的 Maven 构建、加壳、Jira/Confluence 写入或订餐提交。

## 进程与产物

构建、测试和宿主核查均使用仓库有界执行器；每次 Windows Job Object 清理报告为 0 个所属进程，收尾检查未发现本次测试进程残留。正式 dist、已安装插件和本条脱敏验证记录保留。

临时文件位于仓库 `.task-temp/dsh-compat-20261105/`，以及 jira-flow、confluence-flow、codex-monitor、meal-panel 四个插件各自的 `.task-temp/dsh-compat-20261105/`。其中包括宿主源码核查副本、测试脚本、日志和隔离 profile。已核对这些路径均在仓库内、无符号链接残留，但自动审核拒绝了递归删除（`blocked by policy`，未提供更具体原因），因此目录仍保留且不纳入提交。隔离 profile 指向真实 node_modules 的 junction 已由验证脚本 finally 移除。

安装器的 profile 备份保留在两个插件各自 `docs/installation/desktop-package-before-20261105-*.json`，仅用于本次安装恢复，不纳入提交。
