你是本需求的 DSH 实现方，用户已明确要求 Codex 负责规划和验收、由 DSH 自己开发。请先读 AGENTS.md 和 docs/development-plan.md，然后直接落实插件开发，不只输出方案。方案中的默认交互已经确定。

工作目录：C:/Users/OMEN/Documents/助手/dsh-sidebar-recents。只在这里写项目代码，临时材料放 .task-temp/。本次外层调用最多 1800 秒，按明确阶段完成并及时写 docs/progress.md 供 Codex 查看。优先 15 分钟内给出可构建第一版，避免漫无边界调研；若必要 API 缺失，给出可复核的源码位置和最小可逆适配实现。

请核实实际 Desktop runtime API 后开发。不允许改官方安装目录，不修改凭据、模型、代理、全局安全配置；不要停止用户已有 Desktop 进程。安装前请先完成构建与测试，并写出安装方案。若可通过受支持的热加载安装本地插件而不重启，可以执行；若需要退出 Desktop，先保留已完成包并报告。

每个测试/构建都必须用有超时、finally 清理整个进程树的方式。可只读参考 D:/dev/vscode/jira-flow/scripts/run-bounded.ps1 的 Windows Job Object 方法，在本项目制作自有维护脚本。所有辅助服务和子进程由本次命令所有，结束时清理，禁止按名称杀进程。

请自行完成实现与自测，输出 docs/implementation-report.md、README 安装/卸载步骤、实际命令结果、package/tgz 路径、仍需真实 UI 验收的项目。Codex 会独立验收，未真实验证不可写通过。不要创建额外 agent 或调用 Codex 替你写代码，不推送远程仓库。
