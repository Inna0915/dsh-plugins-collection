# 项目打包看板

2026-10-30 兼容修订：0.1.5 支持 DSH 0.2.1-rc.3 和 rc.5。复现旧声明被新宿主拒绝，核对 main/sidebar slot、layout、workspaceRegistry、目录选择、webServer 注册契约；更新宿主回执与懒加载面板缓存版本。Python 引擎及业务配置不变，不执行真实业务打包来验证兼容性。

用户已授权实施并接入本机 DSH。完整迁移 PackageTool 1.6.1；原软件源码与安装不改动。

- 入口在会话看板（order -4）正上方，使用 order -5；原生 main 面板，卡片、状态栏及详细操作区。
- 冷启动仅注册入口、面板壳和 HTTP 路由；首次主动打开才下载面板代码、启动引擎、读取配置及扫描工作区。无启动轮询。
- DSH workspaceRegistry 提供可信工作区路径；识别有效 POM、聚合模块和 WAR 模块，保留手选目录与最近目录。
- 核心模块从 D:/dev/code/tools/project-package/core（aa63f5c）复制作为可分发源代码。Python 无界面服务复用全部业务逻辑；发布随包携带引擎。
- Git、构建、加壳互斥，构建项目上下文固定。关闭面板停止依赖监控，运行中任务继续；空闲关闭引擎。卸载取消所属进程树。
- Windows Job Object 管理引擎及子进程，操作有超时。测试使用 scripts/run-bounded.ps1；不运行用户项目构建或调用版本登记/加壳服务作为测试。
- 功能核对：环境检查、目录缓存/浏览、Git 状态/刷新/切换/拉取/确认重置、版本服务设置、Maven 日志/终止、说明预览/复制/文件导出、加壳配置/自动与手动/测试版、产物复制/定位、Jenkins 关联/认证/提醒/已知晓/包内核验。
- 临时文件仅 .task-temp；发布输出 runtime、dist、releases 保留。安装只登记自己的本地 bundle，不修改官方包，不重启 DSH。
