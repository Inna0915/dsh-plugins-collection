# 参数与权限

本机可执行文件：`C:/Users/OMEN/.kimi-code/bin/kimi.exe`，当前版本 2.3.1。脚本不依赖 kimi 已进入 PATH。`KIMI_CODE_HOME` 可定位其他安装目录，或通过 -KimiPath 指定入口。

| 参数 | 作用 |
| --- | --- |
| -Project / -Task / -PromptFile | 必填；项目和 UTF-8 交接文件均使用绝对路径 |
| -Model | 当前 Kimi 配置中的模型别名；不传时使用默认/续接模型 |
| -SessionId | 本流程创建的精确 session_… ID，同一项目续接 |
| -Mode auto | 唯一支持模式，也是默认；由 CLI 的 -p 隐含启用 |
| -TimeoutSeconds | 默认 1800，必须有限；清理另有约 20 秒收尾上限 |
| -KimiPath | 可执行文件或 PowerShell 入口，用于更换安装路径/离线测试 |
| -Dir | 项目内提示词范围，不是文件系统沙箱 |
| -DryRun | 显示请求参数，不调用 CLI、不创建任务日志 |

正确的原生命令形态：

```powershell
& 'C:/Users/OMEN/.kimi-code/bin/kimi.exe' -p '任务说明' --output-format stream-json
& 'C:/Users/OMEN/.kimi-code/bin/kimi.exe' --session 'session_实际UUID' -p '补充任务' --output-format stream-json
```

非交互 -p 自动使用 auto，不能叠加 --auto、--yolo 或 --plan。新版 --yolo 是 Ask When Needed，仍可能询问高风险操作；--auto 是交互入口的 Never Ask。不要照搬旧 Python kimi-cli 的 --print/--afk 参数。当前 CLI 没有通用 -Effort 参数。

auto 不修改静态 deny 规则、不提升 Windows 用户权限。首次信任、凭据、模型权限或工具拒绝不能通过改配置/改原生会话日志来隐式绕过；请报告具体原因。本流程不自动安装 CLI，也不自动更改模型。

## 日志和实际权限

每轮日志位于 `<项目>/work/alpha/logs/<任务>/kimi-<runId>.*`，包含 prompt、events、stderr、final、status、worker。原始 stream-json 中的 `session.resume_hint` 提供精确会话 ID；成功同时要求 exit=0、结束提示及非空最终答案。原生 state.json 若报告非 completed，脚本也将本轮标为失败。

`appliedSettings` 只读提取本次原生会话的 profile.bind 和 permission.set_mode：模型别名、thinkingEffort 和权限模式。`permissionVerified=true` 表示记录为 auto，不是服务器模型身份证明。缺少或读取失败会显示未核实。

普通 stderr 可能包含兼容性警告或工具进度，不等于运行失败。本机既有 config.toml 含 max_retries_per_step 弃用警告；本次未改动该无关配置。

归属记录放在 `<项目>/work/alpha/sessions/kimi/`；需要继续任务时应保留。停止或超时后的进程被清理，但业务修改可能已经产生，需要 Claude 检查现场，不应把重试当作从未执行过。

离线验证：`scripts/tests/Test-Dispatcher.ps1 -ScratchRoot <本任务临时目录>`。测试不调用模型。

官方依据：[Kimi 命令和互斥规则](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)、[配置覆盖](https://moonshotai.github.io/kimi-code/en/configuration/overrides.html)。
