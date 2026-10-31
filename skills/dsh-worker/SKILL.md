---
name: dsh-worker
description: 在 Windows Claude Code 中把任务交给本机 DSH CLI，负责交接、精确会话续接和结果验收。用于用户要求“让 DSH 干活”“交给 DeepSeek Harness”或调用 /dsh-worker 时。暂时默认使用桌面端 magpie 的 DeepSeek V4.1 Flash 1017 / max，DSH 权限默认全访问。
---

# DSH 执行助手

Claude Code 负责理解需求、准备交接和验收，DSH headless CLI 负责执行。
用户本次任务：$ARGUMENTS

## 调用

- 入口：`${CLAUDE_SKILL_DIR}/scripts/Invoke-DshTask.ps1`。
- 默认值来自 [defaults.json](config/defaults.json)：`magpie / clinepass/cline-pass/deepseek-v4.1-flash-1017 / max`。
- 按用户授权，DSH 默认 `danger-full-access`、审批策略 `never`；不需要另加 yolo 参数。全权限不扩展具体任务范围。
- 连接信息每轮读取桌面端所选 provider 配置；默认模型固定在 defaults.json，不跟随桌面端切换。API Key 通过已有环境变量引用读取。
- 通过 `-Provider`、`-Model`、`-Effort` 覆盖单次调用，只有用户指定时才换模型。权限可用 `-Mode read-only` 或 `workspace-write` 收紧。
- 使用 PowerShell 7，优先 `C:/Program Files/PowerShell/7/pwsh.exe`。不要直接调用系统 Node 20 下的 dsh shim；脚本已指定本机 Node 24。

## 交接流程

1. 确定当前项目的绝对路径，读取适用的 AGENTS.md，检查用户已有修改和正在执行的任务。不要接管当前 Codex/DSH 桌面会话，不要与它们同时修改相同文件。
2. 在 `<项目>/work/alpha/tmp/<任务名>/` 写 UTF-8 交接文件：目标、允许修改范围、必要背景、验收标准、验证命令及停止条件。无需复制全部对话。
3. 传入 `-Project`、`-Task`、`-PromptFile`。默认总超时 1800 秒，可通过 `-TimeoutSeconds` 调整，禁止无限等待。构建、测试仍需单独限定超时并清理其进程。
4. 持续检查脚本输出的 status 和 events 文件。宿主需后台执行长任务时，使用宿主的后台任务能力并持续追踪该次调用；不要因暂时无输出而重复下发。
5. 检查 `state=finished`、`exitCode=0`、`turnCompleted=true`、`cleanupVerified=true`、`overlayRemoved=true` 和非空 final.md，再通过实际文件、diff 和测试记录验收业务结果。

PowerShell 示例：

```powershell
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NoProfile -File `
  '${CLAUDE_SKILL_DIR}/scripts/Invoke-DshTask.ps1' `
  -Project 'D:/projects/current-project' -Task 'fix-receipt' `
  -PromptFile 'D:/projects/current-project/work/alpha/tmp/fix-receipt/round1.md'
```

Bash 工具中请使用 Bash 引号和续行规则调用 `pwsh.exe -File`，不要粘贴 PowerShell 的反引号续行。

## 续接和清理

- 需要补充工作时写新的交接文件，并传入本次 status 中精确的 `sessionId`：`-SessionId 'session-…'`。项目工作目录保持一致；每轮都应用当前脚本的模型、effort 配置。
- 仅续接这个流程自己创建且上一轮已经退出的会话。同一会话不能并发，不使用“最近会话”，不抢占桌面端或其他调度器的会话。
- DSH 会保留会话权限；续接必须与首次调用的 Mode 一致。脚本用 `<项目>/work/alpha/sessions/dsh/` 中的归属记录检查，不一致就明确拒绝；需要改变权限时另开会话，不修改旧会话日志。
- 登录、网关、模型权限或协议错误必须如实报告。不得偷偷换模型，不得反复无限重试。
- 正常、失败和超时退出会清理整个本次进程作业。中止时先核对 status.runnerPid 和进程命令行，再停止该调度器；Windows Job 会清理后代进程，禁止按 node/java/pwsh 镜像名批量结束。
- 强制结束父进程时，状态文件可能仍显示 running，临时覆盖文件也可能保留。确认本次进程已停止后，只删除对应 runId 的 `.patch.json` 和本任务不再使用的交接文件。
- 完成后清理本任务临时文件；日志是验收记录，可保留。DSH 会话保存在用户 DSH home 中，可用于后续续接。

详见 [参数、日志与排错](references/usage.md) 和 [安装验证](references/validation.md)。该 skill 只在本机 Windows Claude Code 中生效；它不修改 Claude Code 本身的工具审批设置。
