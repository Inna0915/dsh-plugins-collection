---
name: codex-worker
description: 在 Windows 上让 Claude Code 委派任务给本机 Codex CLI，默认 gpt-6.1-sol / max，并负责交接、会话续接和结果验收。用于用户要求“交给 Codex”“用 Codex 干活”或调用 /codex-worker 时。
---

# Codex 执行助手

在当前 Claude Code 会话中分析需求、交接任务并验收结果；使用此 skill 自带的调度脚本让 Codex 执行。
用户本次任务：$ARGUMENTS

## 调用入口

- 脚本：`${CLAUDE_SKILL_DIR}/scripts/Invoke-CodexTask.ps1`。
- 默认 **gpt-6.1-sol / max**；新建及续接都显式传入，不修改用户 Codex 全局配置。只有用户指定其他配置时才用 `-Model` / `-Effort` 覆盖。
- 按用户已确认的偏好，权限默认 **yolo / danger-full-access**：关闭 Codex 沙箱、无需审批；不再使用会触发本机 elevated 沙箱 ACL 故障的 workspace-write 默认值。该调整未修复 Windows ACL 本身，也不绕过操作系统权限。
- 用户要求 Fast 时加 **`-Fast`**（等同 `-ServiceTier fast`）。默认服务档位为 `default`，不擅自开启更高用量档位。不要再创建额外的 codex-fast.ps1 包装器；脚本已在新建及 resume 对应的位置传入档位和 feature 开关，详见 [Fast 与权限验证](references/fast-and-permissions.md)。
- Windows PowerShell 7：优先 `pwsh`；找不到时使用 `C:/Program Files/PowerShell/7/pwsh.exe`。
- 需要了解权限、状态文件或排错时读取 [调用细节](references/usage.md)，不必每次读取脚本源码或测试材料。

## 交接与执行

1. 从当前项目确定绝对工作路径。遵守适用的 AGENTS.md，保留用户已有修改；把工作树基线与当前授权范围写进交接。
2. 在 `<项目>/work/alpha/tmp/<任务名>/` 写 UTF-8 交接文件。包含目标、允许修改范围、必要背景、验收标准、验证命令及停止条件；不用完整历史对话替代清晰任务。任务名使用短名称，不含路径分隔符。
3. 将该文件传给脚本的 `-PromptFile`，项目路径传给 `-Project`。默认全访问；用户需要只读或工作区限制时，显式传 `-Mode read-only` / `workspace-write`。受限模式遇到 ACL/沙箱错误时报告原因，不擅自修改系统 ACL 或放宽用户指定的限制。
4. 调度器默认总超时 1800 秒；按任务设置有限的 `-TimeoutSeconds`，每项构建和测试仍需自身的超时及进程清理。宿主不能前台等待长任务时使用其后台运行能力，并持续检查本轮状态；不要因为暂时没有输出而重复下发。
5. 从脚本输出获得本轮 status、events 和 final 路径。确认状态、退出码、`cleanupVerified`，再检查业务结果。Fast 调用还要检查 `serviceTierVerified=true` 和 `appliedSettings.serviceTier=priority`；缺少证据就明确报告未核实，不能仅凭启动命令宣称 Fast 生效。退出码 0 不是业务验收完成的证明。

PowerShell 调用结构（替换项目、任务名和交接文件）：

```powershell
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NoProfile -File `
  '${CLAUDE_SKILL_DIR}/scripts/Invoke-CodexTask.ps1' `
  -Project 'D:/projects/current-project' `
  -Task 'fix-receipt' `
  -PromptFile 'D:/projects/current-project/work/alpha/tmp/fix-receipt/round1.md'
```

若从 Bash 工具启动，使用 Bash 支持的引号和续行语法调用 `pwsh.exe -File`；不要将 PowerShell 反引号续行直接粘贴到 Bash。

## 验收与续接

- 根据 git diff、实际文件及验证证据验收；发现缺项，写新的交接文件并通过 **本轮明确的 `sessionId`** 传入 `-SessionId` 续接。
- 不用 `--last`；同一会话禁止并发写入。IDE/桌面端也可能持有会话，遇到占用错误报告原因，不反复重试。
- 同一目标在现有授权内可以继续补充；目标改变时另开会话。不要让 Claude 和 Codex 同时修改同一文件。
- 没有有效修复进展、超时、登录失败或权限不足时，停止重复调度并报告具体阻塞。模型调用失败不得擅自换模型。
- 需要中止时依据本轮状态中的 `runnerPid` 确认进程身份后结束调度器；其作业对象会清理本轮后代进程。不要按 java/node/pwsh 等镜像名批量结束进程。
- 完成后停止本任务进程，清理已经不用的临时交接与中间文件。日志是验收记录，可保留；删除范围仅限本次任务确认拥有的文件。

## 参数证据与使用量

`requestedModel` / `requestedEffort` 是请求参数。需要更强的本地证据时可检查对应 Codex 会话的 `turn_context.model` 和 `effort`，将其称为 CLI 会话记录，不称为服务端独立认证。

续接的 `turn.completed.usage` 可能是会话累计值。统计单轮消耗前先判断其语义，必要时与上一轮累计值作差；不要直接把第二轮累计输入当作第二轮新增输入，也不要忽略缓存输入。详见 [已验证范围](references/validation.md)。

仅支持本机 Windows Claude Code；WSL、SSH、容器或云端不会自动获得这些本机脚本。
