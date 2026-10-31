# 调用细节

这是用户级 Claude Code skill，所有本机项目都可使用 `/codex-worker <任务>` 或自然语言“交给 Codex 执行”。全局维护位置为 `C:/Users/OMEN/.claude/skills/codex-worker/`；脚本完整放在 `scripts/`，不依赖最初的 `Documents/助手` 工作目录。

## 参数

| 参数 | 含义 |
| --- | --- |
| `-Project` | 必填，实际项目绝对目录。不会自动改成其他 Git 根 |
| `-Task` | 必填，短任务名，支持中文、字母、数字、下划线、连字符、点号 |
| `-PromptFile` | 必填，UTF-8 交接文件绝对路径 |
| `-Model` / `-Effort` | 默认 `gpt-6.1-sol` / `max`；每次新建、续接都显式传入 |
| `-Mode` | 默认 `yolo`（全访问）；`danger-full-access` 是别名；可显式选择 `read-only`、`workspace-write`、`auto` |
| `-Fast` / `-ServiceTier` | `-Fast` 等同 `-ServiceTier fast`；不传则为 `default`；续接同样显式应用 |
| `-TimeoutSeconds` | 默认 1800，允许 1–86400；清理还有约 20 秒收尾上限 |
| `-SessionId` | 明确的会话 UUID；不使用 --last |
| `-Dir` | 可选，项目内目录，作为交接范围；并不创建额外沙箱 |
| `-CodexPath` | 可选，明确的 .exe 或 .ps1 CLI 入口；默认优先本机原生 codex.exe |
| `-SkipGitRepoCheck` | 仅用于已确认的非 Git 项目 |
| `-DryRun` | 查看参数，不调用模型，不创建执行日志 |

权限：`read-only` 和 `workspace-write` 都使用 `approval_policy=never`，所以不能交互申请越界权限；`auto` 显式使用 workspace-write/on-request/auto_review；`yolo` 按用户已确认偏好作为默认值，关闭沙箱并跳过审批。Claude 自己的工具权限仍独立生效。本 skill 不写入任何全局自动批准规则。Windows/企业保护层仍可拒绝访问，不能把 YOLO 当作管理员提权。

模型与权限通过命令行覆盖；不更改 `~/.codex/config.toml`、登录信息、Claude 模型或 Claude effort。

## 日志

每次调用创建唯一的 `codex-<时间>-<随机后缀>`，材料位于调用项目：

```text
work/alpha/logs/<任务>/
  <runId>.status.json
  <runId>.events.jsonl
  <runId>.stderr.log
  <runId>.final.md
  <runId>.prompt.md
  <runId>.worker.json
work/alpha/tmp/<任务>/
```

日志可能包含业务数据，仅写必要内容并按项目约定保留。源代码差异与测试证据由 Claude 验收，不以 Codex 自述代替。

## 中止与进程

调度器把 worker 加入 Windows Job Object，随后才把任务写入 stdin，使后代进程归属于该次调用。正常结束、失败、超时或强杀调度器都终止本轮进程，不保留后台开发服务。

状态 `cleanupVerified=true` 表示调度器清理时作业对象中的进程数为 0。强杀时它可能来不及更新状态，因此 running 不一定意味着仍在执行。退出码成功为 0；CLI 错误保留原码；超时 124；可处理的中断 130。不能建立作业对象时直接失败，不回退为无生命周期管理的调用。

## 首次在其他项目使用

已有真实新建和续接验证，无须每个任务重复跑冒烟。换运行环境、升级 CLI 或排查连接时，可用 `../assets/smoke-prompt.md` 做只读测试；第二轮交接只询问上轮暗号，不把暗号再写入提示词。

大规模修改前先用小范围真实代码任务验证项目的沙箱、缓存目录、构建工具与验收流程。此前 FMS 验证只证明读取和续接正常，未验证代码修改、构建或数据库写入。

## 维护

维护此 skill 内的 `scripts/`；`scripts/tests/Test-Dispatcher.ps1 -ScratchRoot <本任务临时目录>` 为离线回归测试，不调用模型。修改进程生命周期、输入输出或参数拼装后运行对应测试。测试源码用于长期维护，测试脚本自动清理自己的临时目录。Fast 和 appliedSettings 详见 [验证方式](fast-and-permissions.md)。

安装后若已有 Claude Code 会话未显示命令，重新打开一个 Claude Code 会话；仍未出现时重新加载 VS Code 窗口。在 `/skills` 或 `/` 菜单检查 `codex-worker`。

参考：[Claude Code 个人 skills](https://code.claude.com/docs/zh-CN/skills)、[Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)。
