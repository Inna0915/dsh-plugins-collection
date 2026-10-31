# 任务看板 0.1.8

Jira Story / Bug 工作台、可跨 agent 使用的 Skills、独立 CLI 与 MCP。DSH 看板和其他 agent 使用同一套 Jira 业务逻辑，凭证不进入 Skill 或任务包。

## 0.1.8 创建时上传图片与失败补传

- `jira-create` 可在创建 Task/Bug/Story 时上传用户指定的截图；`jira-update-progress` 可给已有任务补充图片。CLI 使用可重复的 `--image`，MCP / DSH 使用 `imagePaths`；图片实际上传到 Jira 附件区，不自动改写正文。
- 不带 `--apply` 先预览，检查文件头、扩展名、大小及 Jira 附件开关。支持 PNG/JPEG/GIF/WebP/BMP，单批最多 20 张、单张 20 MiB、合计 50 MiB，同时遵守 Jira 更小的限制。文件须在运行层机器本地可读，不接受网址/网络路径；全局开启附件不等于具有项目上传权限。
- 创建回执先落盘，再逐张上传。返回 `created=true` 且 `uploads.complete=false` 时，任务已经存在，需报告哪些图片未完成。修复明确失败原因后，复用原创建请求和 requestId，或对返回编号执行 `attach` 并复用 `uploadRequestId`、原始完整图片列表与顺序。已成功图片会跳过，原图内容变化会阻止补传。
- 超时、断线、异常回执或上传中断标记为 `unknown`，先在 Jira 核实，不自动重复上传。成功创建与逐图上传回执分别保存于本机 `~/.jira-flow/operations/`、`uploads/`；记录文件信息和结果，不保存凭证或图片字节。

```powershell
# 创建预览：不写 Jira
node dist/cli.js create --type Bug --summary "查询页面超时" --body-file D:/work/bug.md --image D:/work/screenshot.png
# 用户已要求创建后，保持相同参数，加 --apply --request-id <预览返回值>

# 已有任务上传预览；正式提交同样使用预览 requestId
node dist/cli.js attach PROJ-123 --image D:/work/screenshot.png --image D:/work/details.jpg
# 创建成功后的补传，携带原始全部图片，不重新建单
node dist/cli.js attach PROJ-123 --image D:/work/screenshot.png --apply --request-id <创建返回的uploadRequestId>
node dist/cli.js attachment-settings
```

实现依据：[Jira Server 附件 API](https://developer.atlassian.com/server/jira/platform/rest/v10000/api-group-issue/)、[Jira 附件上传与元数据](https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issue-attachments/)。上传使用 multipart 的 `file` 字段和 Jira 要求的 `X-Atlassian-Token` 标头，由 FormData 生成边界。

## 0.1.7 创建任务与默认查询

- 新增 `jira-create`，通过 CLI / MCP / DSH 创建 Task、Bug、Story，读取项目真实类型、必填字段和允许值。Task 自动匹配项目中的“任务”；创建页面要求报告人时默认当前登录用户。
- 默认经办人为当前 Jira 用户，默认迭代为项目唯一的 active 迭代；支持明确指定用户和 active 迭代 ID/名称。多个/没有 active 迭代时报告候选；只有明确使用 `none` 才放入待办池。用户查找使用项目可分配用户接口，姓名不唯一时要求使用 username/accountId。
- `create` 不带 `--apply` 返回预览和 requestId；提交使用相同参数和该 requestId，成功重试返回原回执。结果未知时不自动重建。只读预览不创建操作记录，补全必填字段后可以再次预览。
- `search` 默认 `assignee = currentUser() AND sprint in openSprints()`，包括当前迭代已完成任务。支持 `--assignee me|all|用户`、`--sprint current|all|none|迭代` 和 `--type Bug`；明确的 `--jql` 覆盖这些默认维度，不允许与结构化筛选混用。看板继续使用其明确配置的 JQL，周报继续按历史区间查询。
- 新增只读 `create-context`、`users`；迭代列表补齐看板/迭代分页及多项目范围。MCP / DSH 同时补齐已有结果导入操作 `results.import`，不将导入等同 Jira 回写。

```powershell
node dist/cli.js search
node dist/cli.js search --type Bug --assignee alice --sprint 123
node dist/cli.js users --query alice
node dist/cli.js create-context --type Bug
node dist/cli.js create --type Bug --summary "查询页面超时" --body-file D:/work/bug.md
# 用户已要求创建且预览信息完整后，复用预览 requestId 提交：
node dist/cli.js create --type Bug --summary "查询页面超时" --body-file D:/work/bug.md --apply --request-id <预览标识>
```

关于进一步拆分 Skill：用户与迭代查找归入 `jira-query`，指派/状态更新归入 `jira-update-progress`；现阶段不新增重复 Skill。批量迭代巡检（缺少验收条件、无人负责、长期停滞）可先组合 query/analyze/weekly；有稳定的独立规则和产物后再考虑 `jira-triage`。

接口依据：[Jira 创建元数据与创建示例](https://developer.atlassian.com/server/jira/platform/jira-rest-api-examples/)、[创建时设置 Sprint](https://support.atlassian.com/jira/kb/creating-an-issue-in-a-sprint-using-the-jira-rest-api/)、[Jira 可分配用户查询](https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-user-search/)。

## 0.1.6 添加到当前会话

- 卡片“添加到会话”、详情“添加到当前会话”、批量选择栏与任务包弹窗均可把完整任务正文、评论和图片加入当前 DSH 草稿。全页看板添加后回到会话，分栏看板继续保留。
- 使用宿主 `uiSession` 标准输入动作及原生图片附件；在原光标/选区末尾插入，原有文字、文件引用和附件保留，由用户补充要求并发送。读取期间继续编辑草稿也会保留；切换目标会话时拒绝插入并保留任务包供重新添加。
- 每次最多附带 20 张 PNG/JPEG/WebP/GIF、合计 25 MB，正文上限 18 万字符。资源缺口写入草稿并显示提示，所有已下载资源保留在任务包。DSH 当前的图片草稿仅保存在浏览器运行期，重新加载后可从任务包重新添加图片。
- 输入框不可编辑或会话已切换时，可从保留的任务包再次点击“添加到当前会话”。“交给 DSH agent”仍是独立的直接派发入口。

### 可用的 Jira Skills

| Skill                  | 能力                                                    | 示例指令                                     |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `jira-query`           | 默认查询本人当前迭代；支持任务、用户、详情、迭代与历史  | 查询我负责的当前迭代 Bug                     |
| `jira-create`          | 创建 Task/Bug/Story，指定迭代与用户，默认自己和当前迭代 | 创建这个 Bug，分配给指定用户并加入进行中迭代 |
| `jira-export`          | 单条/批量导出 Markdown、图片、任务索引与 ZIP            | 将这两条任务导出为含图片任务包               |
| `jira-analyze`         | 提取复现/验收条件，定位代码，形成方案                   | 分析任务包中的 Bug，先给出方案               |
| `jira-fix-bug`         | 复现、定位、修复、回归并生成逐条结果                    | 在指定项目修复这个 Bug 并验证                |
| `jira-implement-story` | 按 Story 验收条件实现、测试并登记结果                   | 在指定项目实现这个 Story                     |
| `jira-update-progress` | 更新字段/经办人、评论、合法状态流转，导入执行结果       | 将此任务改为指定状态，并追加这段进度说明     |
| `jira-weekly-report`   | 根据状态历史生成可追溯周报                              | 统计本周我负责的任务，区分开发完成和最终状态 |

其他 agent 可加载 `~/.agents/skills` 中的 Skills；支持 DSH 原生工具、MCP 和独立 CLI。在线操作复用本机凭证存储，Skill 内没有凭证；只用图文任务包时可离线执行。代码实施需要指定对应项目目录。Jira 经办人分配与指定执行 agent 分开处理，完成代码不会自动关闭任务。

## 0.1.5 原生工作区分栏

- 在全页看板顶部点击“在工作区打开”，回到当前会话并打开看板标签页；已有看板会被定位，不重复创建。会话顶部也有看板入口。
- 也可从 DSH 右侧工作区的新标签页选择“任务看板”。使用宿主自带的分栏、宽度调节、拖动标签页、浮窗、收回与全屏控件，和会话、文件或终端一起使用；“全页查看”返回原来的全页看板。
- 原生方案使用 `sidebarRightTabs.register`、`sidebar.right.pane.tab` 与 `sidebarRight.openTab`，通过 `useTabInfo` 绑定当前标签及刷新命令，没有修改宿主布局。Windows 桌面的原生页面刷新快捷键为 Ctrl+R，Web 为 Ctrl+Alt+R，以 DSH 当前配置为准。
- 按分栏宽度适配工具栏，窄分栏的 Kanban 横向滚动；详情、流转和图片浮层限制在看板内。切换标签及浮窗保留当前筛选，标签页布局由 DSH 按会话保存并在重新加载时恢复。
- 当前 DSH 最多支持两个停靠分栏；空间不足时打开为同格标签，极窄窗口由宿主自动切换全屏。需先选择一个会话，布局按会话区分，不是所有会话共享同一分栏。

## 0.1.4 流转版本校验修复

- 修复 Jira 搜索接口截断更新时间毫秒，导致列表任务反复提示“任务已变化”的问题。弹窗和拖拽在展示流转节点前获取详情中的精确版本，提交时继续严格检查并发修改。
- 流转信息加载完成前禁用提交；遇到冲突可以在弹窗内“刷新任务与流转”，保留备注和仍可用的目标，重新确认后提交。不会自动重放写操作。

## 0.1.3 跟随式流转

- 拖动时显示紧凑卡片预览，节点列表在卡片旁纵向排列，随拖动位置移动；到窗口边缘自动换侧并限制在插件区域内。
- 朝节点移动时列表停稳，方便准确放入；离开选择区域后恢复跟随。节点高亮并提示“松手”，保留必填信息流程和服务端确认后的卡片移动动画。
- 点击拖动图标时同样在卡片旁打开列表，支持键盘选择及 Esc 取消；减少动画设置继续生效。

## 0.1.2 看板与拖拽

- 界面和 DSH 侧栏统一显示“任务看板”，保留 `dsh-jira-flow` 包标识、现有连接与 Skills 安装路径。
- 紧凑工具栏、同步状态行和四列占满可用高度；各列独立滚动，搜索、迭代和刷新常驻顶部。
- 刷新会读取最新 Jira 数据并报告变化数量。宿主重载导致页面令牌过期时自动重连一次；查询超时可重试，旧查询不会覆盖新结果。Jira 权限错误和结果不明的写入不自动重试。
- 拖动卡片即读取并显示真实可流转节点，拖到节点后松开直接执行；有必填字段/评论的节点先打开已选中目标的表单。拖到空白处、Esc 或取消均不写入。点击卡片拖动图标也可用键盘选择节点。
- 卡片在服务端确认后移动，提供目标高亮、等待状态、跨列移动与落点动画，并尊重系统减少动画设置。

## 0.1.1 交互改进

- Bug 使用红色侧边与警示图标，Story 使用绿色侧边与文档图标。
- 打开看板自动同步，默认选择列表中的第一个迭代；仍可手动选择所有迭代。
- 详情压缩为紧凑标题和元信息，正文不再重复展示；点击遮罩空白或 Esc 关闭。顶部操作栏始终可见，并避开宿主窗口顶部。
- 图片在应用内放大，支持适应窗口、100% 原图、缩放与滚动；Esc 只关闭最上层预览。同一张图不再在正文与附件列表重复显示，完整复制和任务包仍保留全部信息。
- 流转选项直接平铺，选中后显示必填字段，提交后局部更新卡片。
- 合并并发读取，短期复用详情、图片和凭证解密结果；手动同步及写入后失效，减少网络请求与界面重载。客户端缓存仅存于当前页面内存。

## 已实现

- DSH 全局四列 Kanban：筛选、搜索、迭代、详情、完整 Markdown、鉴权图片。
- 多选任务，批量复制正文，导出逐条 Markdown、图片、汇总索引、资源清单和 ZIP。
- 指定已有 DSH 会话，或按预设和代码目录创建专属会话。图片可直接进入 DSH 消息；忙碌会话排队；派发 ID 防止重复投递。
- 查询、字段更新、评论、动态流转表单、乐观并发检查与写操作记录。
- 导入外部 agent 的结果文件；结果与 Jira 写入分开，详情中可将结果填入进度评论。
- 状态历史、周报事实清单与历史缺口说明。
- 8 个 Skills，独立 CLI、标准 MCP stdio 服务及 DSH 原生 `jira_flow` 工具。

## 本机使用

此项目构建输出位于 `dist/`。需要 Node.js 20.19 或更新版本。

```powershell
node D:/dev/vscode/jira-flow/dist/cli.js doctor
node D:/dev/vscode/jira-flow/dist/cli.js search
node D:/dev/vscode/jira-flow/dist/cli.js issue PROJ-123 --format markdown
node D:/dev/vscode/jira-flow/dist/cli.js export PROJ-123 PROJ-124 --output D:/work/tasks --zip
node D:/dev/vscode/jira-flow/dist/cli.js weekly --format markdown
```

### DSH 插件

安装前先构建本项目。使用 DSH 自带的 CLI：

```powershell
dsh plugin --profile desktop add link:D:/dev/vscode/jira-flow
```

也可在 DSH 插件管理中选择本地项目路径。当前运行实例未热加载时，正常退出并重新打开 DSH。左侧会出现 **任务看板**，点击进入全局看板；无需先选择一个聊天。

项目已在用户本机 desktop profile 安装为本地链接。不要移动项目目录，否则应重新安装链接。

### 独立看板

```powershell
node D:/dev/vscode/jira-flow/dist/cli.js serve
```

打开 `http://127.0.0.1:43127`。Ctrl+C 停止。这是用户主动启动的服务；测试服务器不应留在后台。

独立看板支持相同的查询、导出和 Jira 更新；直接派发 DSH 会话需要在 DSH 内使用插件。其他 agent 可读取导出的任务包。

### Skills

```powershell
node D:/dev/vscode/jira-flow/dist/cli.js skills install
```

默认安装到 `~/.agents/skills/`，已有同名目录会保留，不覆盖。可用 `--output <目录>` 安装到其他客户端支持的目录。

Skills：`jira-create`、`jira-query`、`jira-export`、`jira-analyze`、`jira-implement-story`、`jira-fix-bug`、`jira-update-progress`、`jira-weekly-report`。

各 Skill 的 `scripts/run.mjs` 根据 `~/.jira-flow/installation.json` 找到独立运行层。复制 Skill 到另一台电脑后，需要在该电脑安装运行层和配置连接；不复制原始凭证。

### MCP

支持 MCP 的客户端配置 stdio 启动项。例如：

```json
{
  "mcpServers": {
    "jira-flow": {
      "command": "node",
      "args": ["D:/dev/vscode/jira-flow/dist/cli.js", "mcp"]
    }
  }
}
```

各客户端配置文件位置可能不同。工具名为 `jira_flow`，参数 `operation` 选择查询、详情、导出等操作。MCP 配置无需包含 Jira 密码或 token。

## 连接和凭证

看板的“连接设置”可配置地址、项目、自定义字段、工作目录与默认预设，也可导入现有 Obsidian Jira Flow `data.json`：

```powershell
node dist/cli.js auth import-obsidian --source D:/vault/.obsidian/plugins/obsidian-jira-flow/data.json
```

导入只读取原配置，不修改 Obsidian。Windows 使用 DPAPI CurrentUser 保存认证信息；明文通过子进程标准输入传入保护程序，不放在命令参数、代码仓库或工具输出中。受保护凭证通常需要同一 Windows 用户和机器读取。

用户数据默认在 `~/.jira-flow/`，可通过 `JIRA_FLOW_HOME` 指定独立目录：

```text
profiles/       非秘密连接配置
credentials/    Windows 用户保护的凭证
cache/          最近查询快照
exports/        默认导出目录（用户产物）
packages/       导出目录索引
runs/           DSH 派发记录
operations/     Jira 写操作记录
results/        导入的 agent 执行结果
installation.json
```

其他系统可使用 `credentialStore: "environment"`，运行环境提供 `JIRA_FLOW_AUTH_<大写连接别名，非字母数字替换为下划线>` 的 JSON 值，格式为 `{ "kind":"basic", "username":"...", "secret":"..." }` 或 Bearer 格式。不要将真实值写进 Skill、MCP 配置示例、项目或聊天。

系统凭证存储减少明文泄漏，不是对同一用户下任意命令的强隔离。需要完全不给执行 agent Jira 权限时，使用图文任务包模式。任务正文和图片本身仍是企业资料，应交付给用户选择的可信环境。

默认连接为只读。需要更新时由用户在连接设置启用“允许更新 Jira”；每个写操作还需明确提交（CLI `--apply`）。测试不需要修改真实业务任务。

## 常用操作

```powershell
# 保留项目边界，查询条件整体加括号
node dist/cli.js search --jql 'assignee = currentUser() AND statusCategory != Done'

# 查看当前可用流转与必填字段
node dist/cli.js transitions PROJ-123

# 字段和备注用 UTF-8 文件传入，避免 shell 转义
node dist/cli.js update PROJ-123 --fields-file fields.json --expected-updated '<最新updated>' --apply
node dist/cli.js transition PROJ-123 --transition-id 41 --fields-file fields.json --apply
node dist/cli.js comment PROJ-123 --body-file progress.md --apply

# 只登记结果，不修改 Jira
node dist/cli.js results import --source results.json

# 明确区间：开始包含，结束不包含
node dist/cli.js weekly --start 2026-10-19T00:00:00+08:00 --end 2026-10-26T00:00:00+08:00 --format markdown
```

完整命令：`node dist/cli.js --help`。写操作可指定稳定的 `--request-id`；结果不明时先核实 Jira，不改 ID 盲目重试。Jira 不提供跨“检查更新时间＋修改”的原子比较时，乐观检查仍有很短的并发窗口。

## 图文任务包

看板多选 → “生成图文任务包” → 选择目录与附件范围 → “复制执行指令”。

- 本机 agent：让它读取索引路径、任务正文和图片。
- 远端或沙箱 agent：实际上传整个目录/ZIP；不能只粘贴本机路径。
- 普通 Markdown 复制仅包含图片引用，不包含图片文件。
- 导出资源有 `downloaded / failed / omitted` 状态，失败不会伪装成功。
- 单附件上限 20 MB，每批附件上限 100 MB，单批最多 100 个任务。
- DSH 直接消息附件最多 20 张 / 25 MB；不附加图片时，需要目标 agent 有可访问任务包目录的读图工具。
- SVG 等不适合直接嵌入的格式可作为任务包文件交付，不在浏览器内执行。

导出包包含 `index.md`、`combined.md`、`issues/`、`assets/`、`manifest.json`，索引说明 `results.json` 的返回格式。所有路径保留明确的来源与快照时间。

## 周报口径

周报输出可复算的事实清单，交给 agent 组织文字。默认上海时区本周；候选包含当前/历史经办人或报告人，查询不依赖当前看板。使用 Jira changelog，不能读取完整历史时明确列出缺口，不以 `updated` 冒充完成时间。

开发里程碑与最终状态分别列出，任务数去重；重开单列，正常从已构建进入测试不会计为重开。最终状态仍需结合取消/重复等解决结果解释，不能把所有关闭都包装为交付成果。当前经办人也不代表唯一贡献者。此版本输出事实清单，不自动调用模型或发布周报。

## 实现范围

首先兼容当前 Jira Server/DC 的 REST v2 与自定义字段。Cloud v3/完整 ADF、远端 DSH Host、跨域附件 CDN 鉴权和自动批量并发 agent 尚未作为已支持功能交付。看板 API 仅接受本机请求；图片下载不向第三方域名转发 Jira 凭据。

DSH 适配验证版本：`0.2.1-rc.3`。新版本变更接口时集中调整 `src/dsh/`。

## 开发与验证

在 PowerShell 中使用拥有独立 Windows Job Object 的有界执行器：

```powershell
./scripts/run-bounded.ps1 -Executable node -CommandArgs @('scripts/build.mjs') -TimeoutSeconds 90
./scripts/run-bounded.ps1 -Executable node -CommandArgs @('node_modules/typescript/bin/tsc','--noEmit') -TimeoutSeconds 90
./scripts/run-bounded.ps1 -Executable node -CommandArgs @('--test','tests') -TimeoutSeconds 90
```

执行器先以挂起状态创建根进程，加入 Job 后启动；成功、失败或超时都会在 finally 中清理整棵进程树。禁止按 `java.exe`、`node.exe` 等镜像名清理。

源码按 `src/core`、`src/runtime`、`src/dsh`、`src/client` 分层。`skills/` 是独立可分发内容。实现提取并延续了本地 Obsidian Jira Flow 的业务经验与 MIT 许可代码。
