# 本机交付补充

## 0.1.5 更新（2026-10-30）

适配 DSH Desktop 0.2.1-rc.5。旧版本精确声明只允许 rc.3，被新宿主的版本准入检查拒绝；已读取当前 app.asar 核对相关接口/结构，并通过官方 evaluatePluginCompatibility 验证新声明。继续支持已验证的 rc.3；未配置版本豁免。

已安装到原目录，真实宿主 PID 38996 回执为 0.1.5、active=true，时间 2026-10-30T03:42:14.907Z；engineStarts=0、enginePid=null、activeTask=null，保留按需启动。前端面板缓存版本同步为 0.1.5。部署后 profile 与升级前内容一致，其他插件、构建配置、历史、项目缓存和加密凭据均未改动；DSH 未重启。

JS 构建和 9 项 Node/React 测试通过。引擎与 Python 代码未改动，EXE SHA-256 仍为 5CD55532961E45FCCC7D5AEB4E1124F3A45E03B28A2BB98807D27E7A849ABD13；没有重跑未受影响的 Python/业务打包套件，也未触发真实 Maven、Git 写入、版本登记或加壳操作。发布包为 releases/dsh-project-package-0.1.5.tgz，附 SHA-256。

本次命令均有界执行并由 Job Object 回收。未新增临时脚本或服务，源码测试回执在测试 finally 中恢复到测试前内容；下方历史保留文件及目录未动。正式保留 compatibility-rc5.json、安装回执、源码、dist 和发布包。用户人工验证新版 DSH 中的入口和面板效果。

## 0.1.4 更新

已安装到本地 DSH 并完成 bundle 重载，宿主回执为 0.1.4，冷加载 engineStarts=0，未重启 DSH。安装前确认无运行中的打包任务；验证后释放测试租约。安装的独立引擎 SHA-256 与测试版本一致，回执及实际缓存扫描记录见 docs/installation/v0.1.4-*.json。

优化开始/停止打包：移除后台依赖监控的最多 40 秒等待；历史 POM 批量读取；版本资源准备使用可终止的独立进程；停止接口立即返回，后台通过 Job Object 回收所属进程树，状态每 400 ms 更新。开始前检测其他 Maven Java 构建，发现后中止本次启动，显示 PID 和项目路径，不终止外部进程。

验证通过：124 项快速 Python 测试、28 项版本边界 Git 集成测试、9 项 Node/React 测试、Chromium 交互回归、独立 EXE 准备入口及 Node→EXE 通信/空闲退出。实际 fms-p275 版本变更只读读取从 9677.3 ms 降为 5026.1 ms，144 条结果完全一致；进程预检 42.4 ms。准备阶段模拟阻塞时，取消响应 0.2 ms，所属进程树回收 46.1 ms；这不是实际业务构建总耗时承诺。未调用业务 Maven、版本登记或加壳服务。

本次构建/测试临时目录已自动清理，各有界命令结束时所属进程均为 0。清理辅助脚本 .task-temp/start-performance-v014.py 与源码测试回执 runtime-status.json 的命令被自动审批拒绝，原因仅为 blocked by policy，未绕过或换工具删除，这两个文件暂留且不进入发布包。旧 0.1.0 的四个留存目录继续保持原状，清单与原审批阻断说明见下方。正式源码、验证记录、安装备份和 releases/dsh-project-package-0.1.4.tgz 保留。

## 0.1.3 更新

包含中间任务看板移除、打包全部成功后跳到产物、右上角 Jenkins 实时浮窗，以及随后追加的项目列表缓存与项目切换提速。用户已确认 0.1.2 的 Jenkins 实际界面；0.1.3 保留该实现并优化加载路径。

验证：119 项 Python 快速测试、9 项 Node/React 测试、浏览器交互和缓存首屏测试通过。性能记录见 docs/switch-before-v0.1.3.json、docs/switch-after-v0.1.3.json；Jenkins 只读验证记录见 docs/jenkins-live-v0.1.2.json。正式截图、源码、运行引擎和发布包保留。辅助性能与联网探测脚本在完成后清理，构建中间目录在 finally 中清理，原 0.1.0 留存目录保持原状。

已安装至本地 DSH 并重新加载，回执为 0.1.3；冷加载 engineStarts=0。实际宿主识别 10 个项目，首次请求含引擎启动为 1892.5 ms，再次请求命中缓存为 24.4 ms。验证租约已释放，记录在 docs/installation/v0.1.3-cache-check.json。独立 EXE 退出后重开仍命中磁盘缓存，Node→EXE 通信及空闲回收检查通过。发布包 releases/dsh-project-package-0.1.3.tgz 含 37 个文件，附 SHA-256。

## 0.1.1 更新

已更新本地插件并重新加载 bundle，宿主版本回执为 0.1.1，未重启 DSH。Jenkins 依赖按任务合并为分组，业务项目按 module / WAR starter 配对识别，保留手动目录读取及最近项目。真实已注册工作区识别 5 个根目录；真实面板包含最近目录共 10 个业务目录，10 项依赖合为 4 个 Jenkins 分组。

本次通过 109 项 Python 快速测试、7 项 Node/React 测试，独立 EXE 与 Node 通信、按需启动/空闲退出、浏览器桌面/窄屏交互检查。原有 42 项 Git 集成测试未重跑，未执行真实业务构建或 Git 写入。新版分发包位于 releases/dsh-project-package-0.1.1.tgz，共 34 个文件，附 SHA-256。

本次生成的独立引擎构建目录已在 finally 中删除，测试命令所属进程树均报告 0 active processes；扫描/打包辅助脚本和测试产生的源码目录回执已清理。下方列出的 0.1.0 临时目录保持原状，本次未绕过原拒绝进行删除。正式发布输出、docs/images/dependencies-grouped.png、docs/discovery-v0.1.1.json 及 docs/installation/v0.1.1-*.json 为保留的验证记录。

## 0.1.0 交付

2026-10-28，dsh-project-package 0.1.0。

- 已安装：C:/Users/OMEN/.dsh/local-plugins/dsh-project-package。
- 源码：C:/Users/OMEN/Documents/助手/dsh-project-package。
- 分发包：releases/dsh-project-package-0.1.0.tgz；34 个文件，包含独立引擎，不包含测试夹具、原配置、manifest 备份或临时缓存。
- 安装方式：本地 bundle、目录 junction、原子更新 Desktop package.json，未重启或结束 DSH，未修改官方安装包。
- 真实宿主冷启动回执、首次打开回执、关闭后回执分别保存在 docs/installation/cold-start-receipt.json、first-open-receipt.json、closed-idle-receipt.json，仅含版本、时间和进程标识。
- 真实界面已确认入口位于会话看板上方。打开加载有效工作区项目，关闭空闲面板后 enginePid=null，相关 PackageEngine 进程均退出。
- 147 项 Python 与 6 项 Node 测试通过。独立引擎、实际 Node/EXE 通信、Chromium 桌面/窄屏交互另行通过。原软件仓库未修改，未触发真实业务打包、Git 写入、版本发布或加壳。

## 清理结果

已清理本次复制的 engine/core/__pycache__ 缓存和顶层临时 client.cjs、panel.cjs、PackageEngine.spec。全部测试、构建和验证引擎已退出，无任务所属 runner/JVM 残留。

递归删除构建临时目录被自动审批拒绝，原始理由为 `blocked by policy`，未提供更具体原因。未使用其他工具绕过拒绝。以下本次产生的目录留在 .task-temp/，不进入发布包：

- build-temp：独立引擎构建的临时工作区域。
- engine-tests-8atl7do9：首轮达到时限的测试夹具（临时 Git 仓库）。
- pyinstaller：独立引擎的编译缓存和中间产物。
- npm-cache：本地打包使用的 npm 缓存。

长期保留 runtime/PackageEngine.exe、dist/、releases/ 为正式发布输出；tests/ 为回归代码，docs/ 为最小验证与安装记录。
