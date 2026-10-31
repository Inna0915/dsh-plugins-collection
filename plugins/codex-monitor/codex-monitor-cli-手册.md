# Codex 监控 CLI 手册

CLI 脚本 `codex_monitor.py` 与插件源码同仓、同版本维护。它只调用 DSH 插件 HTTP API，不直接读取或修改 Codex SQLite、rollout 或 `$DSH_HOME\codex-monitor\running-history.json`。

## 调用入口

```powershell
$env:PYTHONIOENCODING = "utf-8"
$cm = "M:\master\workspace\deepseek\plugins\codex-monitor\codex_monitor.py"

# 列出当前看板快照中的会话
python $cm list

# 按看板泳道筛选：running（运行中）、review（待审核）、record（记录）
python $cm list --status review

# 工作目录和标题关键词均为不区分大小写的包含匹配，可组合使用
python $cm list --cwd "M:\master\workspace\deepseek" --keyword "monitor"

# 默认窗口：最近 7 天、最多 30 条
python $cm refresh

# 只刷新指定会话，不受默认时间窗口限制
python $cm refresh 01a058d0-0aa1-7f31-b751-8ce3e264e7bb
```

默认服务地址是 `http://127.0.0.1:3080`。可通过全局参数或环境变量覆盖：

```powershell
python $cm --base http://127.0.0.1:3090 refresh
$env:CODEX_MONITOR_BASE = "http://127.0.0.1:3090"
```

`--base`、`--timeout` 必须放在 `list` 或 `refresh` 前面。

`list` 读取服务端当前快照，不主动触发刷新。`--status` 使用看板泳道语义：已完成及可审核异常会话归入 `review`，未记录运行过程及不可审核异常会话归入 `record`。

## 输出契约

| 结果 | 通道 | 退出码 |
| --- | --- | --- |
| 会话列表查询成功 | stdout JSON：包含 `count`、`sessions`、`generatedAt`、`refreshing` 和 `window` | 0 |
| 刷新请求已接受 | stdout JSON：`{"ok":true,"accepted":true,"scope":"default|session"}` | 0 |
| 参数或 `session_id` 无效 | stderr JSON | 1 |
| DSH 未运行或连接超时 | stderr JSON | 2 |
| HTTP 错误或响应不是 JSON 对象 | stderr JSON | 3 |

接口返回 `202` 表示刷新已经进入插件队列，不表示状态查询已经完成。CLI 不轮询等待最终结果；已打开的看板每 5 秒读取一次快照，会自动显示刷新结果。

## Hook 接入

`codex-monitor-hook.ps1` 是单一职责适配器：读取 Hook stdin 中的 `hook_event_name` 和 `session_id`，调用本 CLI 的无参数 `refresh` 命令，不推导或写入会话状态。Hook 的 `session_id` 仅用于调试关联，不直接作为私有 SQLite `threads.id`；人工调用 CLI 时仍可显式传入已确认的 Codex 线程 ID 进行定向刷新。

完整的安装配置、`/hooks` 信任、调试日志和排查步骤见 [Codex 监控 Hook 手册](codex-monitor-hook-手册.md)。

Hook 配置应同时满足：

- 用 `UserPromptSubmit` 触发轮次开始附近的默认窗口刷新；
- 用 `Stop` 触发轮次结束附近的默认窗口刷新；
- 命令处理器设置 `"async": true`，Codex 不等待网络调用完成；
- Stop 的原有脚本可以保留，监控命令作为同一事件的另一个独立处理器；
- 首次添加或修改 Hook 后，在 Codex CLI 中用 `/hooks` 审阅并信任新定义。

多 handler、`async` 和信任流程以 [OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks) 当前发布行为为准。Codex 升级或 Hook 定义变化后，应重新通过 `/hooks` 审阅并以实际加载结果为准。

Hook 事件可能早于 rollout 写入对应状态事实：适配器在 `UserPromptSubmit` 后延迟 500ms，在 `Stop` 后延迟 5 秒，再触发刷新。适配器把 HTTP 超时限制为 2 秒；监控调用失败时仍输出 `{}` 并退出 0，不影响 Codex 轮次。

### Hook 调试日志

适配器顶部提供默认关闭的调试开关：

```powershell
# $enableDebugLog = $true
$enableDebugLog = $false
$debugLogPath = 'C:\Users\y\Desktop\codex\codex-turn-stop.log'
```

需要确认 Hook 是否触发时，取消 `$true` 行的注释并注释 `$false` 行。随后发送一次消息或结束一个轮次，日志会按 JSON Lines 逐条追加，记录触发时间、事件名、`session_id`、刷新范围、刷新请求结果和错误摘要，不记录 prompt 或会话正文。

`refresh-request-accepted` 表示 Hook 已触发，并且 DSH 接受了刷新请求；`refresh-request-failed` 或 `hook-error` 表示 Hook 已触发，但刷新链路失败。排查结束后应把开关恢复为 `$false`。

## 页面更新方式

当前不是 WebSocket，而是短轮询：

```text
Hook / CLI -> POST /codex-monitor/refresh -> 服务端刷新队列
                                               |
已打开看板 <- 每 5 秒 GET /codex-monitor/sessions <- 会话快照
```

这是本机单用户、低频、服务端到页面单向同步。一次刷新完成后，页面最坏约 5 秒可见；`Stop` 路径还会先等待 5 秒，避免过早读取到尚未落盘的完成事实。WebSocket 会增加连接、重连、宿主卸载和多页面广播成本，当前没有必要。
