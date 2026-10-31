# Codex 监控 Hook 手册

`codex-monitor-hook.ps1` 用于在 Codex 轮次开始和结束附近异步通知 Codex Monitor 刷新默认会话窗口。它不是状态来源，不读取 Codex SQLite 或 rollout，也不会替代已有的通知、休眠等 Stop Hook。为等待状态事实落盘，`UserPromptSubmit` 延迟 500ms、`Stop` 延迟 5 秒后再发送刷新请求。

```text
UserPromptSubmit / Stop
          |
          v
codex-monitor-hook.ps1
          |
          v
codex_monitor.py refresh
          |
          v
POST /codex-monitor/refresh -> DSH 插件重新读取会话状态
```

## 使用前提

- Codex Monitor 插件已安装，DSH 服务可访问；默认地址为 `http://127.0.0.1:3080`。
- `codex-monitor-hook.ps1` 与 `codex_monitor.py` 位于同一插件目录。
- Windows 可以通过 `python.exe` 启动 Python；也可以用 `CODEX_MONITOR_PYTHON` 指定解释器。
- Codex 用户目录可写；未自定义 `CODEX_HOME` 时，默认配置位置为 `%USERPROFILE%\.codex\hooks.json`。

Hook 是刷新加速入口。它保留输入中的 `session_id` 供调试，但不把该值当作私有 SQLite `threads.id`；真实会话由默认刷新从 Codex 状态源发现，避免不匹配的 Hook 标识生成异常占位卡。DSH 未启动或请求失败不会阻塞 Codex，插件启动、手动刷新和低频全量刷新仍负责兜底。

## 配置 Hook

编辑 `%USERPROFILE%\.codex\hooks.json`；自定义过 `CODEX_HOME` 时，使用该目录下的 `hooks.json`。如果文件已经包含其他 Hook，应合并下面两个监控处理器，不要覆盖原配置。

下面示例假设插件目录为 `D:\tools\codex-monitor`。JSON 中的 Windows 路径必须使用双反斜杠，使用时替换为实际绝对路径。

```json
{
  "description": "Personal Codex lifecycle hooks.",
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pwsh.exe -NoLogo -NoProfile -NonInteractive -File \"D:\\tools\\codex-monitor\\codex-monitor-hook.ps1\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pwsh.exe -NoLogo -NoProfile -NonInteractive -File \"D:\\tools\\codex-monitor\\codex-monitor-hook.ps1\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

两个事件的作用不同：

| 事件 | 作用 |
| --- | --- |
| `UserPromptSubmit` | 延迟 500ms 后触发默认窗口刷新，使当前活跃会话尽快进入“运行中” |
| `Stop` | 延迟 5 秒后触发默认窗口刷新，避免 rollout 的完成事实尚未落盘 |

同一事件允许配置多个命令。已有 Stop Hook 可以继续保留，把监控命令作为同一 `hooks` 数组中的另一个处理器即可；Codex 会并发启动所有匹配的命令。监控处理器必须保持 `"async": true`：异步由 Codex Hook 运行器负责，PowerShell 脚本本身无需再派生后台进程，因此脚本中的 5 秒等待不会阻塞 Codex 轮次结束。

## 审核并信任

非托管 Hook 在受信任前会被跳过。配置完成后：

1. 在 Codex CLI 中执行 `/hooks`。
2. 核对 `UserPromptSubmit` 和 `Stop` 中显示的脚本绝对路径。
3. 分别审核并信任两个监控处理器。
4. 再次打开 `/hooks`，确认它们已启用且不再处于待审核状态。

信任与当前 Hook 定义的哈希绑定。修改 `hooks.json` 中的命令、参数或定义后，需要重新执行 `/hooks` 审核；只修改被调用的 `.ps1` 内容不会改变 `hooks.json` 中的命令定义。

完成 `/hooks` 信任后通常无需重启 Codex，后续匹配事件即可触发。如果 `/hooks` 没有显示最新配置，再新建 Codex 会话；仍未加载时重启对应客户端，VS Code 中可执行“Developer: Reload Window”。

官方机制说明见 [OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks)。

## 验证刷新链路

先直接调用 CLI，排除 DSH、端口或 Python 环境问题：

```powershell
python D:\tools\codex-monitor\codex_monitor.py refresh
```

出现 `"accepted": true` 表示 DSH 已接受刷新请求。该结果只能证明 CLI 到 DSH 的链路可用，不能证明 Codex 已调用 Hook。

## 验证 Hook 触发

脚本顶部的调试日志默认关闭：

```powershell
# $enableDebugLog = $true
$enableDebugLog = $false
$debugLogPath = 'C:\Users\y\Desktop\codex\codex-turn-stop.log'
```

分享给其他 Windows 用户时，应先把 `$debugLogPath` 改为该用户可写的路径。调试步骤如下：

1. 取消 `$true` 行的注释，并注释 `$false` 行。
2. 保持 DSH 运行，在 Codex 中发送一条消息。
3. 等待该轮次结束。
4. 查看日志；应分别出现 `UserPromptSubmit` 和 `Stop` 记录。
5. 验证结束后恢复 `$enableDebugLog = $false`。

实时查看日志：

```powershell
Get-Content -LiteralPath 'C:\Users\y\Desktop\codex\codex-turn-stop.log' -Wait -Encoding UTF8
```

单条日志示例：

```json
{"received_at":"2026-09-01T14:16:22+08:00","source":"codex-monitor-hook","event":"UserPromptSubmit","session_id":"01a058d0-0aa1-7f31-b751-8ce3e264e7bb","refresh_scope":"default","status":"refresh-request-accepted","refresh_exit_code":0,"error":null}
```

| `status` | 含义 |
| --- | --- |
| `refresh-request-accepted` | Codex 已调用脚本，DSH 已接受刷新请求 |
| `refresh-request-failed` | Codex 已调用脚本，但 CLI 到 DSH 的刷新请求失败 |
| `hook-error` | Codex 已调用脚本，但输入解析、Python 定位或脚本执行失败 |

日志只记录触发时间、事件、`session_id`、刷新范围和结果，不记录 prompt 或会话正文。脚本始终返回 `{}` 并退出 `0`，调试日志写入失败也不会改变 Codex 轮次结果。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| `/hooks` 看不到监控处理器 | 检查 `hooks.json` 路径和 JSON 语法，并确认命令使用实际绝对路径 |
| Hook 显示待审核或修改后失效 | 重新执行 `/hooks`，信任当前定义 |
| 没有生成调试日志 | 检查 `$enableDebugLog` 是否为 `$true`、日志目录是否可写，以及是否真的发生了匹配事件 |
| 日志为 `refresh-request-failed` | 确认 DSH 正在运行、端口正确，并直接执行 CLI 查看错误 |
| 日志为 `hook-error` | 查看 `error` 字段，重点检查 stdin、`python.exe` 和脚本同目录的 `codex_monitor.py` |
| 已接受刷新但看板未立即变化 | `Stop` 会先等待 5 秒，刷新完成后页面每 5 秒读取一次快照；状态仍由 SQLite、rollout 和运行记录推导，不由 Hook 指定 |
| 发送消息后没有进入“运行中” | 确认出现 `UserPromptSubmit` 日志并且默认刷新已接受，再检查会话是否进入最近 7 天、最多 30 条的默认窗口 |

若 DSH 使用非默认地址，可以在启动 Codex 前设置 `CODEX_MONITOR_BASE`：

```powershell
$env:CODEX_MONITOR_BASE = 'http://127.0.0.1:3090'
```

若 `python.exe` 不在 `PATH`，设置解释器绝对路径：

```powershell
$env:CODEX_MONITOR_PYTHON = 'C:\Python313\python.exe'
```

环境变量必须存在于启动 Codex 客户端的进程环境中，Hook 子进程才能继承。
