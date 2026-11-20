# 闲庭探针（dsh-vibe-reader-spike）

验证用原型，不是产品插件。回答两个问题：

1. 插件后端能否在不进入任何会话的前提下单次调用 `ctx.llm`（书童的基础）。
2. 侧栏前端能否拿到**全部会话**的运行状态（「Agent 跑久了才提示可读、跑完或需要审批时提醒回去」的基础）。
3. 右侧栏按会话保存布局，阅读器能否跟着你切换会话。

## 结论（2026-11-20）

| 问题 | 结论 | 依据 |
|---|---|---|
| 后端单次调用 `ctx.llm` | **可行，CLI 和 Desktop 都已实跑** | headless CLI 0.2.2-rc.1 四次运行均成功，首字 1.7–3.3 秒，全文 2.4–4.4 秒；Desktop rc.5 点「试问书童」首字 1.05 秒，全文 1.8 秒，125 入 / 63 出 token。均为 `magpie / workbuddy/deepseek-v4.1-flash`，effort 自动取 `off`。`usage` 字段为 `{ inputTokens, outputTokens, totalTokens }` |
| 调用是否进入会话日志 | **不进入，已实跑** | 解压测试会话日志，书童 system prompt 未出现；该会话只有 Agent 自身 1 条 `request/header` |
| 回退到默认模型 | 可行 | `agentDefaultModel` 已注入，`currentSelection()` 可作为未配置时的路由 |
| 插件注册 Agent 工具 | 可行，已实跑 | headless Agent 调用了 `vibe_reader_spike_check` |
| 前端会话运行状态 | **Desktop rc.5 实机可用** | `ctx.uiSession.sessionStatus`：`getSnapshot()` 返回 `Map<sessionId, { running, pendingInteraction, completionUnread }>`，`subscribe(fn)` 订阅。快照覆盖全部会话（实测 255 个） |
| 会话标题、跳转 | **Desktop rc.5 实机可用** | 第二轮截图：标题、主视图标记、用时都正确，顶层 219 / 共 255 个会话。标题来自 `ctx.sessions.list`，跳转用 `ctx.uiWorkspace.openSession(id)` |
| 跨会话跟随 | **Desktop rc.5 实机可用** | 实测切换会话后标签消失（右侧栏每个会话一份布局）。探针订阅 `ctx.sidebarRight.mounted`，若离开的会话里探针可见，就在新会话 `ctx.sidebarRight.openTab(kind)` |

注意：主视图正在看的会话不会得到 `completionUnread`（宿主会清掉），所以它的「已完成」要靠自己记录 `running: true → false` 的跳变，保留 60 秒；其他会话的 `completionUnread` 会保留到你打开它为止。

## 文件

| 文件 | 内容 |
|---|---|
| `index.js` | 宿主端：`GET/POST api/vibe-reader-spike/ask`；`VIBE_READER_SPIKE_SELFTEST` 自检；自检时才注册的工具 |
| `client.js` | 右侧栏「闲庭探针」：汇总全部顶层会话，分「需要你 / 已完成，待查看 / 运行中」三组列出，点击跳到对应会话；顶部总状态按 需要你 > 已完成 > 可读 > 等待中 > 空闲 取一个；按钮触发一次书童调用 |
| `spike.test.mjs` | 13 个单测（假 llm、假 sessionStatus、假会话列表、假 mounted） |
| `run-headless-selftest.mjs` | 用 headless CLI 实跑后端，并检查会话日志隔离 |

## 重跑

```bash
NODE=node                                   # Node 24+（自检需要 zlib.zstdDecompressSync）
"$NODE" --test spike.test.mjs
"$NODE" run-headless-selftest.mjs          # 加 --keep 保留 .task-tmp/<runId>/ 下的事件和 stderr
```

自检使用临时 `DSH_HOME`（只复制 `~/.dsh/profiles/headless` 的配置），网关密钥从 `~/.dsh/.env` 读入子进程内存，不落盘；测试会话不会出现在你的会话列表里。超时 180 秒，超时或异常时按 PID 结束整棵进程树。会产生一次很小的模型调用和一个极短的 Agent 回合。

两个实测得到的坑：

- `--patch` 叠加层里插件的 `name` 按 **profile 目录**解析，不按叠加文件位置解析；本地插件要写 `file:///…/index.js`。
- `desktop` profile 只能由 Electron 管理，`dsh plugin --profile desktop` 和 `--dump-config` 都会拒绝。

## Desktop 实机检查

- 第一轮（2026-11-20）通过：`sessionStatus` 可读到 255 个会话，「试问书童」1.8 秒返回。
- 第二轮通过：全部会话视图正常；发现切换会话后右侧栏的探针标签消失。

第三轮检查跨会话跟随（已通过）：

1. 加载新的 `client.js`：关掉再打开探针标签；页面上没有「二、切换会话」一节，就重启 Desktop。
2. 探针开着且可见时，从左侧切到另一个会话：新会话的右侧栏应自动打开探针，「跟随记录」多一条。
3. 在新会话里切到别的标签（或收起右侧栏）再切会话：这次不应自动打开。
4. 探针可见时点「已完成 / 运行中」里的某一条：跳过去后探针仍在。
5. 取消勾选「自动在新会话里打开它」再切会话：不应自动打开。

验证完在插件管理里移除即可；探针不写任何文件。移除后各会话布局里可能还留着探针标签的记录（宿主的 localStorage），如果哪个会话出现空白标签，手动关掉即可。
