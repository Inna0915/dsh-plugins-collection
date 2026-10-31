# Fast 和权限

2026-10-24，本机 Codex 0.163.0-alpha.10.2 已在独立新建/续接会话验证以下调用，模型 gpt-6.1-sol、effort max。

另外专门建立了普通档位会话，再以 -Fast 续接：第一轮实际 default，第二轮实际 priority，结束后的 serviceTierVerified=true。验证覆盖了把已保存的普通档位切换为 Fast，不只是保留已有 Fast。

## 推荐入口

```powershell
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NoProfile -File `
  'C:/Users/OMEN/.claude/skills/codex-worker/scripts/Invoke-CodexTask.ps1' `
  -Project 'D:/repo' -Task 'example' -PromptFile 'D:/repo/task.md' -Fast
```

续接时追加 `-SessionId '精确UUID'`；仍需带 `-Fast`，不能假定上一轮 Fast 会自动保留。普通档位用 `-ServiceTier default`。支持其他档位的参数不等于账号一定有权限；请求被拒绝时不得偷偷降档或换模型。

原生 CLI 等价结构（工作目录由 -C 指定，提示词通过 stdin）：

```powershell
# 新建
codex exec -C 'D:/repo' --dangerously-bypass-approvals-and-sandbox `
  --model gpt-6.1-sol -c 'model_reasoning_effort="max"' `
  -c 'features.fast_mode=true' -c 'service_tier="fast"' --json -

# 续接：把配置参数放到 resume 子命令之后
codex exec -C 'D:/repo' resume '精确UUID' `
  --dangerously-bypass-approvals-and-sandbox --model gpt-6.1-sol `
  -c 'model_reasoning_effort="max"' -c 'features.fast_mode=true' `
  -c 'service_tier="fast"' --json -
```

曾发现旧包装器只在 exec 后、resume 前插入 service_tier=fast，实际续接日志仍是 default。不要把旧包装器用于此 skill。上面的组合和位置已在本机验证；没有把“参数存在”当作“已应用”的证据，也没有据此推断所有 CLI 版本都相同。

## 核实实际设置

调度器结束时只读检查本轮时间范围内的原生 rollout，将最新 thread_settings_applied 保存到 status.appliedSettings。`serviceTierVerified` 检查它是否符合请求；Fast 对应 priority。该事件缺失、老版本不支持或日志读取失败时，结果为未核实，不伪装成功。

运行中的 status 尚未填写这些结束后核对字段，不能把此时的 false 当作 Fast 失败；运行中需要核对时使用下方的只读读取脚本。

- `appliedSettings.model` 应为请求模型，`effort` 应为 max。
- Fast 应显示 `serviceTier: priority`。
- 默认全访问应显示 `permissionProfile.type: disabled`、`approvalPolicy: never`。
- appliedSettings 是客户端实际应用记录，不是服务器独立的模型/服务档位回执。

需要单独读取时使用 `scripts/Read-CodexAppliedSettings.ps1 -SessionId UUID -Since <本轮 startedAt>`。必须限定本轮时间，避免把首次调用的 priority 当作最近续接的状态。

## 权限故障处理

本机此前失败在 elevated 沙箱设置 Windows ACL 的步骤，不是 Sol/max 模型权限不足。当前按用户授权默认全访问，以绕开该沙箱初始化故障；尚未宣称底层 ACL 已修复。用户显式选受限模式时保留该选择，遇到拒绝先报告原因。

默认值只影响以后启动的调用，不修改已有执行进程、业务文件、全局 config.toml 或其他会话。全访问仍应限定具体任务范围。详见 [原始诊断](windows-sandbox-issue-20261024.md)。

官方依据：[Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed)、[service_tier 配置](https://learn.chatgpt.com/docs/config-file/config-reference)、[CLI 参数](https://learn.chatgpt.com/docs/cli/reference)。
