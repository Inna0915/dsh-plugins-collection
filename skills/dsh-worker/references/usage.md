# 使用说明

安装位置：`C:/Users/OMEN/.claude/skills/dsh-worker`。在 VS Code Claude Code 插件或 Claude Code CLI 中调用 `/dsh-worker 任务内容`。若当前会话没有发现新 skill，新开一个 Claude Code 对话即可，不要中断正在运行的任务。

DSH 调度使用本机 npm 包 0.2.1-rc.2 的 headless profile。Node 24 路径和 DSH 包路径记录在 config/defaults.json；更新或移动程序后可修改这两个字段。系统 Node、桌面 profile 和 Codex skill 均不由此脚本修改。

## 默认与覆盖

默认 provider 为 magpie，模型为 clinepass/cline-pass/deepseek-v4.1-flash-1017，effort 为 max。DSH 权限为 danger-full-access，审批 never。此设置仅应用于本次 DSH 子进程。

每轮只从桌面配置的 llm-pi-ai.providers 中提取指定 provider；不启动桌面插件。当前 magpie 使用本地网关，必须保持该网关可用。它通过 MAGPIE_GATEWAY_KEY 引用认证；密钥继续使用现有 DSH 环境加载顺序：启动环境、项目 .env、DSH home .env。不要把密钥写进交接或日志。

命令入口：

```powershell
$script = 'C:/Users/OMEN/.claude/skills/dsh-worker/scripts/Invoke-DshTask.ps1'
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NoProfile -File $script `
  -Project 'D:/repo' -Task 'example' -PromptFile 'D:/repo/task.md'
```

以下参数追加到上述命令：

| 用途 | 参数 |
| --- | --- |
| 续接同一个会话 | `-SessionId 'session-实际ID'` |
| 单次改 effort | `-Effort high` |
| 换用桌面端已配置的模型 | `-Provider magpie -Model 'deepseek/deepseek-flash' -Effort high` |
| 只读 | `-Mode read-only` |
| 仅工作区写入 | `-Mode workspace-write` |
| 全访问 | 默认，或 `-Mode danger-full-access`（yolo 是别名） |
| 指定总超时 | `-TimeoutSeconds 1800` |
| 查看请求，不调用模型 | `-DryRun` |
| 仅作提示词范围约束 | `-Dir '子目录'`；这不是独立的沙箱边界 |

模型及 effort 必须存在于选定 provider 的模型声明中。该流程只支持桌面 llm-pi-ai 静态 provider 配置，不自动安装 provider 插件或转换桌面账号登录。未配置模型或不支持的 effort 会明确失败。模型和 effort 覆盖同样适用于续接。

DSH 会保存会话权限；续接时 Mode 必须与首次调用相同，想改变权限请新建会话。脚本在 `<项目>/work/alpha/sessions/dsh/` 保存最小会话归属记录，用于阻止权限不一致及误接管外部会话；后续还需续接时保留该记录。

## 输出

每次运行在 `<项目>/work/alpha/logs/<任务名>/` 生成 prompt.md、status.json、events.jsonl、stderr.log、final.md、worker.json。临时 provider 覆盖文件放在相应 tmp 目录，正常、失败、超时路径都会删除。

status.requestedModel/Effort 是请求意图；configuration 是启动器生成的配置，不是服务端模型身份证明。events 中的 tool_result、turn_end 和 final 用于验收，退出码 0 仍不足以证明业务正确。

超时返回 124。没有 completed turn_end 或非空 final 时，即使底层退出 0，调度器也判失败。stderr 可包含 DSH 警告，应结合事件和退出码判断。

## 兼容和排错

- 系统 Node 20 不支持 DSH 入口所用的 import.meta.main。此流程使用现有 Node 24，并显式调用 runCli，以避免旧 shim 静默退出；不修改全局 npm 包。
- 本机版本不接受新版文档的 --permission-mode / --approval-policy 参数，因此使用 CLI 最后层 --patch 明确指定 sandbox-policy 和 approval，同时设置子进程 DSH_PERMISSION_MODE。
- 网关拒绝或未启动：检查现有 Magpie 服务，不通过重启桌面或结束其他进程解决。
- 会话续接要求工作目录完全一致、会话真实存在且未被其他运行占用。脚本互斥只能约束此脚本，不能授权接管桌面会话。
- 强制杀死调度器后，进程作业会清理后代；调用方仍需清理已知 runId 的临时文件。不要将遗留 running 状态误判为仍在工作。

离线生命周期验证入口：`scripts/tests/Test-Dispatcher.ps1 -ScratchRoot <已存在的本任务临时目录>`。不调用模型，测试目录在 finally 中删除。
