---
name: kimi-worker
description: 在本机 Windows Claude Code 中把任务交给 Kimi Code CLI，负责交接、精确会话续接、权限核对与结果验收。用于用户要求“交给 Kimi”“让 Kimi Code 干活”或调用 /kimi-worker 时。
---

# Kimi Code 执行助手

用户本次任务：$ARGUMENTS

调用 `${CLAUDE_SKILL_DIR}/scripts/Invoke-KimiTask.ps1`。适用于已安装的 **Kimi Code 2.3.1**，与旧 Python kimi-cli 的命令不同。

- 使用现有 Kimi 模型与登录配置；新建不传 Model 时采用配置默认模型，续接采用会话保存的模型。当前安装验证使用 `kimi-code/kimi-for-coding`、thinking max。用户指定其他模型时用 `-Model <已配置别名>`。
- 默认权限为 **auto**：通过 `-p/--prompt` 非交互模式实现。该版本禁止同时传 `--auto`、`--yolo` 或 `--plan`，不要追加这些开关，也不要改全局 permission 配置。
- auto 自动处理常规工具执行与问题，但静态 deny、工具自身限制及操作系统权限仍生效。脚本没有只读沙箱模式；用户需要强制只读时应使用支持该限制的执行器，不能把 Kimi 的 Plan 或提示词约束说成只读沙箱。
- CLI 没有独立 effort 开关，不要传 Codex 的 `-Effort`；thinking/effort 使用现有 Kimi 配置，修改它需要用户的具体指示。

## 交接

1. 确定当前项目绝对路径，遵守适用 AGENTS.md，记录现有修改、允许修改范围与正在执行的任务，避免并发修改同一文件。
2. 在 `<项目>/work/alpha/tmp/<任务>/` 写 UTF-8 交接文件，包含目标、背景、验收标准、验证命令和停止条件。
3. 传给脚本的 `-PromptFile`，并设置 `-Project`、`-Task`。总超时默认 1800 秒；必要时用 `-TimeoutSeconds` 调整，每项构建/测试仍需自身超时和清理。
4. 跟踪本轮 status/events。脚本把完整交接保存为 prompt.md，让 Kimi 通过工具读取，避免 Windows 长命令行截断；不要另写超长 -p 参数或依赖旧版 --print。
5. 确认 `state=finished`、`exitCode=0`、`sessionHintSeen=true`、非空 final、`cleanupVerified=true`；核对 `permissionVerified` 和 `appliedSettings`，再用实际 diff/测试验收业务结果。日志缺少权限证据时报告未核实。

```powershell
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NoProfile -File `
  '${CLAUDE_SKILL_DIR}/scripts/Invoke-KimiTask.ps1' `
  -Project 'D:/repo' -Task 'fix-example' -PromptFile 'D:/repo/work/alpha/tmp/fix-example/task.md'
```

Bash 工具里使用 Bash 的引号和续行规则调用 pwsh.exe，不粘贴 PowerShell 反引号续行。

## 续接与中止

- 通过本轮 status 中精确的 `sessionId` 续接：`-SessionId 'session_实际UUID'`。它一般在本轮结束时才由 CLI 输出，不能把 Codex/DSH 的会话 ID 混用。
- 只续接本流程在相同项目目录创建且已经退出的会话；脚本通过 `<项目>/work/alpha/sessions/kimi/` 的归属记录和互斥锁检查，不使用 --continue 或最近会话。
- 每轮 -p 都使用 auto 权限。外部会话、Plan 等待审批或权限拒绝不要用修改原生会话文件的方式绕过；需要用户处理时报告具体阻塞，停止重复下发。
- 超时、失败、正常退出均清理该次 Windows Job 内的进程；不能依赖本流程保留后台服务。中止前核对 status.runnerPid 身份，只停止该调度器，禁止按 node/java/pwsh 镜像名批量结束进程。
- 强杀后状态可能来不及更新。完成后核对本轮进程和临时文件，保留最小验收日志与后续续接所需的归属记录。

参数和限制见 [使用说明](references/usage.md)，实际验证见 [验证记录](references/validation.md)。本 skill 不修改 Claude Code 自身的工具审批规则。
