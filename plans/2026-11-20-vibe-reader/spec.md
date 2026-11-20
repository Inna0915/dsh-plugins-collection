# 闲庭 · Vibe Reader 规格

- 版本：v0.6，2026-11-20（M1、M2 已实现，见 `plugins/dsh-vibe-reader`；M2 计划与结果见 [m2-plan.md](m2-plan.md)。本版：入藏只走 skill，补做色表与 ctext）
- 读者：插件作者本人，以及按本规格实现代码的 Agent（Claude Code / DSH）
- 形态：DSH Desktop 右侧栏插件，与本仓库 `plugins/dsh-novel-reader` 同构（`index.js` 宿主端 + `client.js` 前端，无构建）
- 已完成的验证：见 [spike/README.md](spike/README.md)

## 1. 目标与非目标

**目标**

1. 在等待 Agent 回复、构建、跑测试的间隙，长期、系统地读和背完整的古诗词、古文；以后扩展到一般文章。
2. 不打断编程心流：等待短时只做能随时停下的事；Agent 跑完或需要你时，及时把你送回会话。
3. 原文准确可信：要背的文字一个字都不能错。
4. 数据是本地普通文件，可在 Obsidian / Git 中查看和管理。

**非目标（v1 不做）**

- 语音朗诵或背诵评测（办公环境不便出声，还要接语音识别）。
- 自动弹窗、切换窗口、抢键盘焦点。
- 大规模向量检索、在线书源、爬虫。
- 多设备同步。

## 2. 设计原则

| # | 原则 | 落到实现上 |
|---|---|---|
| P1 | 原文为真，AI 只做注释 | 原文来自用户粘贴或校对过的开源语料；AI 输出写盘前做原文校验（§6.3） |
| P2 | 等待时优先「回忆」，不读新内容 | 短等待或时长未知时出复习卡、背诵节；读新长文需要用户主动进入修业 |
| P3 | 原文只读，状态另存 | 插件不改写书卷原文；进度、复习调度、眉批另存（§5） |
| P4 | 不抢焦点 | 只改变面板内的状态和提示，不弹窗、不切窗口 |
| P5 | 默认不花 token | 打开面板、翻页、背诵都不调用模型；AI 结果按原文哈希缓存 |
| P6 | 用 DSH 原生能力 | `ctx.llm`、插件工具和 skill、`ctx.uiSession.sessionStatus`，不另接模型接口 |

## 3. 已验证的宿主能力

| 能力 | 接口 | 状态 | 说明 |
|---|---|---|---|
| 后端单次调用模型 | `ctx.llm.prepareCall({ provider, model, maxTokens }, signal, configure)` → `call.stream({ ...call.config, system, messages, signal })` | **已实跑**（CLI 0.2.2-rc.1、Desktop rc.5） | 只传请求级用户输入（不带 `id`），不传 `tools`、`sessionId`；CLI 首字 1.7–3.3 秒、全文 2.4–4.4 秒；Desktop 首字 1.05 秒、全文 1.8 秒。`usage` 字段是 `{ inputTokens, outputTokens, totalTokens }` |
| 调用与会话隔离 | — | **已实跑** | 测试会话日志中没有书童请求；DSH 自带的辅助调用（会话标题、联网搜索）会写 `*-llm-request` 记录到所属会话，书童不属于任何会话，所以不写 |
| 默认模型回退 | `ctx.agentDefaultModel.currentSelection()` | 已实跑 | 返回 `{ provider, model, reasoningEffort? }`；Desktop 当前默认是贵模型，书童应单独配便宜模型 |
| 降低推理强度 | `prepareCall` 的 `configure(controls, model)` 取 `model.reasoning.efforts[0]` | 已实跑 | flash 模型取到 `off` |
| 插件注册 Agent 工具 | `ctx.tools.register(...)` | 已实跑 | jira-flow、confluence-flow 也在用；注册后对**所有会话**可见（§7.3） |
| 插件注册 skill | `ctx.skills.register({ name, description, content, path, source: 'runtime', provider })` | **已实跑**（M2 headless） | Agent 通过内置的 `skill` 工具按名字加载 |
| 会话运行状态 | `ctx.uiSession.sessionStatus.getSnapshot()` → `Map<sessionId, { running, pendingInteraction, completionUnread }>`；`subscribe(fn)` | **Desktop rc.5 实机可用** | 快照覆盖**全部会话**（实测 255 个），不只面板所在会话。主视图会话不会得到 `completionUnread`，需自己记录 `running` 由 true 变 false |
| 会话标题与归属 | `ctx.sessions.list.getSnapshot()` → `{ ids, byId: { displayTitle, origin, parentId, blank, retainedBy.mainView, … } }` | **Desktop rc.5 实机可用** | 用来显示标题、排除子代理和空白会话、判断哪个会话在主视图 |
| 跳转到会话 | `ctx.uiWorkspace.openSession(sessionId)` | **Desktop rc.5 实机可用** | 「回去处理」一键打开对应会话 |
| 前端调后端 | 后端 `ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`，前端 `fetch('api/...')` | 已有先例 | novel-reader 在 rc.5 上运行 |
| 右侧栏面板 | `ctx.sidebarRightTabs.register` + 插槽 `sidebar.right.pane.tab`，面板拿到 `{ sessionId, useTabInfo }` | 已有先例 | novel-reader |
| 右侧栏按会话保存 | 布局存在 `localStorage['dsh.sidebar-right.v1.<sessionId>']` | **Desktop 实测**：切换会话后标签消失 | 没有全局标签。对策是跟随（§4.1）：`ctx.sidebarRight.mounted` 给出屏幕上的会话，`ctx.sidebarRight.openTab(kind)` 在该会话打开标签；**探针第三轮与 M1 实机通过** |
| 左侧栏入口 | `sidebar.panellist` 图标 + 根作用域 `main` 插槽 | 文档确认 | 点开后**占满主栏、替换会话界面**，不适合边读边看；可作为以后「藏书阁」全屏管理页的入口 |
| 安装与生效 | Desktop 插件管理 → 本地目录（`link:`） | — | Desktop 启用 HMR，后端通常立即生效；`desktop` profile 只能由 Electron 管理，CLI 不能代装 |

## 4. 功能与交互

### 4.1 面板位置与结构

**位置**：右侧栏标签。右侧栏是每个会话各自一份布局，宿主没有跨会话的标签，所以阅读器要自己「跟着你走」：

- 切换会话时，如果阅读器在你离开的会话里是可见的（你正在读），就在新会话里调用 `ctx.sidebarRight.openTab(kind)` 打开它；没在读就不动新会话的右侧栏。
- 中间经过全局页面（设置、插件管理等，此时 `mounted` 为空）也按离开前的状态算。
- 判断时机：`mounted` 在 React 渲染切换之前变化，离开会话的面板此时仍是可见；另留 1.5 秒宽限，防止宿主先卸载旧面板。
- 设置里有开关「切换会话时带上阅读器」，默认开。
- 阅读位置、复习进度、会话状态都在插件级状态和后端 `state.json` 里，每个会话里的阅读器显示同一份内容。
- 从状态列表点击跳到别的会话时同样会跟过去，读到一半不用重新找。

**结构**，从上到下：

0. **快速入口**：会话顶栏 `conversation.session.header.utilities` 里的书本按钮，点一下在当前会话打开闲庭，闲庭正显示时再点则收起右侧栏（`sidebarRight.active()` / `hide()` / `openTab()`）。按钮优先用宿主的 `dsh-client-ui-primitives` Button，取不到时用普通按钮。
1. **顶栏**：视图切换（偶遇 / 修业）、Agent 状态提示条（§4.6）、设置。没有入藏入口：入藏只通过 skill（§4.8）。修业视图里选卷，卷名旁显示书卷色。
2. **阅读区**：卡片或段落流。
3. **底部**：本节操作（译 / 注 / 试背 / 问书童 / 存眉批），以及书童的回答抽屉。

### 4.2 两个视图

| | 偶遇（书库视图） | 修业（单卷顺读） |
|---|---|---|
| 适合 | 短等待、时长未知 | 长等待，或用户主动进入 |
| 内容来源 | 整个书库：到期复习、名句、旧眉批、应景新诗 | 当前书卷，从上次停下的节继续 |
| 形态 | 居中卡片；短诗可切换竖排 | 段落聚焦：当前节高亮，前后节淡化；顶部显示进度格和本节脉络 |

旧方案里文件头的 `mode: random | sequential` 去掉：一卷诗集里的每个 `##` 节就是一首诗，偶遇是对整个书库的视图，不是某种文件类型。

### 4.3 偶遇的出卡顺序

参考 Readwise 每日回顾，依次取：

1. 今天到期的背诵节；
2. 今天到期的名句卡（`==…==`）；
3. 一条以前写的眉批（回看自己的想法）；
4. 一首应景的新诗：按节气或时辰打标签匹配，本地放一张二十四节气表；
5. 随机一首没读过的。

每出现一次，降低它再次出现的权重。每张卡都要能在 15～40 秒内完成，随时停下也不会留下读了一半的负担。

### 4.4 修业

- 注释三种显示，按钮循环切换，选择存在 `state.volumes[卷].glossMode`：
  - 夹注：朱砂色小字双行插在词后，适合注释稀疏的文章；
  - 句下：按行（诗）或按段（文）在下面列出本行注释；读音音节数与词的字数相同时用 `<ruby>` 标在字上方，否则写在释义里；
  - 点词：正文干净，有注的词加下划线，点击才在行下显示。
  - 默认：诗卷与注释密度高于每 12 字一条的书卷用句下，其余用夹注。千字文一类每联都有注时，夹注会让一半版面是注释（M2 实测入藏的千字文每 6 字一条注、释义平均 18 字），所以这样分。
- 名句（`==…==`）用书卷色的字标出，不用底色。
- 译文与「本节注释」默认展开（`settings.translationOpen`、`settings.notesOpen`，收起后记住）；句下模式只列正文里放不下的注释（如注在标题上的）。
- 书库刷新：任一会话回合结束后 0.8 秒自动重读（入藏发生在 Agent 回合里）；面板可见时每 15 秒检查一次；顶栏 ↻ 手动刷新。新出现的书卷在顶部提示「新入藏」，点击直接打开。重读只重新拉取文件修订号变化的书卷。
- 译文：每段可单独展开。
- 竖排：只用于短诗卡片。侧栏很窄，长文竖排需要横向滚动，体验很差。
- 进度：每次翻节都自动保存，不需要手动「记为续读」。
- 卷首与书架：卷首一行是书卷色竖条、卷名、朝代作者和「书架」。书架在阅读区原地展开（不弹窗）：最近读过的按时间倒序在前，显示「读到 參／伍」，其余按书库顺序。搜索框常驻：匹配书名、作者、朝代、标签，以及卷内各节的篇名和诗人（命中的节列在书卷下，点击直接打开该节）；回车打开第一项。多于 6 卷时另有筛选：全部、诗词、文章、背诵中、未读；以及标签筛选：学段（小学、初中、高中、蒙学）在前，其余为出现在两卷以上的标签，可与前者叠加。书架每行在作者后显示学段标签。刻书匠入藏课本篇目时把学段写在第一个标签。第一次进入修业、还没选过卷时直接打开书架。
- 节序：繁体大写数字 壹 貳 參 肆 伍…（拾壹、貳拾伍…），当前节用书卷色描边；背过的节在格子底部显示等级细条（L5 满格），不填底色，免得看起来像选中；节多时横向滚动并自动滚到当前节。阅读区有焦点时 ← → 翻节。

### 4.5 背诵：逐级减少可见字

每节有一个等级，按等级决定显示多少字：

| 等级 | 显示 |
|---|---|
| L0 | 全文 |
| L1 | 每 5 字隐 1 字 |
| L2 | 每 3 字隐 1 字 |
| L3 | 只留每句首字 |
| L4 | 只留标点和分段 |
| L5 | 每段折叠，只剩「第 N 段」；点开后按 L4 显示 |

- 标点和分段在 L0–L4 都保留，本身就是提示；L5 只保留分段。
- L1、L2 隐哪些字按「轮次」轮换：每次自评后或点「换一批」，换一批字隐藏。
- 被隐藏的字点一下显示，再点收回；「全显」「全隐」一键切换。
- 进入背诵时自动隐藏夹注和译文，避免直接看到答案。
- 自评三档：记得（升一级，复习间隔延长）、模糊（等级不变）、忘了（降一级，尽快再出）。调度先用 Leitner 盒子；以后需要时换成 ts-fsrs（纯算法，有 UMD 单文件，可以直接放进插件）。
- 名句卡（`==…==`）是单句挖空，同样参与调度。
- 另有一个「只读」模式：不计分、不调度，适合只想读一读的时候。

### 4.6 与 Agent 状态联动

面板看的是**会话列表里的全部会话**，不只是面板所在的那个会话。一个会话一旦触发提醒，你就可以从面板直接回去处理。

统计范围：`sessionStatus` 快照里的顶层会话。排除子代理（`origin: 'subagent'` 或有 `parentId`）和空白会话（`blank`）。

每个会话归入三组之一：

| 分组 | 条件 | 列表显示 |
|---|---|---|
| 需要你 | `pendingInteraction` 存在 | 标题、类型（审批 / 计划确认 / 提问） |
| 已完成，待查看 | `completionUnread` 为真；主视图会话因宿主不标记，改为自己记录停止后 60 秒内 | 标题、多久前结束、本回合用时 |
| 运行中 | `running` 为真 | 标题、已运行多久，最久的排前面 |

`completionUnread` 会一直保留到你打开那个会话，所以「已完成」不用定时消失，打开后自然清掉。

面板顶部的提示条按优先级取一个总状态：

| 总状态 | 条件 | 面板表现 |
|---|---|---|
| 需要你 | 任一会话需要你 | 红色提示条「N 个会话在等你」，背诵计时暂停 |
| 已完成 | 没有需要你的，但有已完成待查看的 | 黄色提示条「N 个会话已完成」，同时保存阅读位置 |
| 可读 | 有会话在运行，最久的已超过阈值（默认 10 秒，可配置） | 淡绿提示条「可以读一则」；若在修业中，什么都不做 |
| 等待中 | 有会话在运行，但都没超过阈值 | 不变化，避免短回复也打扰你 |
| 空闲 | 都没在运行 | 正常显示 |

- 提示条展开后是上面三组列表，点一条就调用 `ctx.uiWorkspace.openSession(id)` 跳过去。
- 状态只用一个插件级订阅维护（不随面板挂载），面板隐藏时也不漏记开始和结束。
- 所有提示只出现在面板内部，不弹窗，不切换焦点。阈值的做法参考 claude-learn-while-waiting。

探针与 M1 都按这一节实现，Desktop 实机通过。

### 4.7 划词问书童

- 在阅读区选中文字，出现「问书童」气泡；有三个快捷问题类型：字词训诂、知人论世、程序员视角。
- 回答不超过 100 字，显示在底部抽屉，可以「存为眉批」。
- 缓存键为（节原文指纹、选中文字、问题类型、提示词版本）。原文变化后缓存标为过期，用户点击才重新生成。
- 请求只包含本节原文和选中的文字，**不带任何编程会话的内容**。

### 4.8 入藏

入藏只有一个入口：在任一会话直接说（「导入静夜思」「收录赤壁赋」「导入李白的诗」「导入《论语》」「给静夜思加注」），skill `vibe-reader-engraver`（闲庭导入／刻书匠）按描述自动接手。面板上没有手动录入。skill 开头是一张「用户说法 → 判断 → 做法」表；单篇默认加注，一次超过 5 篇默认只导原文；整本书按自然篇章分卷（单卷约 30 节以内）；给已有书卷加注用 `import` 的 `keepOriginal: true`，原文取自书库里那一卷，保证补注时正文不被改动。实测只发「导入《醉翁亭记》」即可完成。

三种来源，可信程度依次降低：

1. **找文章（语料）**：用户说篇名或名句，Agent 用工具 `search` 在语料里找（§6.1），多个结果时请用户选，`draft` 取得清洗后的原文和草稿，补注后 `import`，`verified: corpus`。
2. **贴全文**：用户贴入完整原文，AI 只负责分节、写注释、标名句、配色；写盘前做原文校验。默认 `verified: false`，用户明确说已核对才为 `true`。
3. **AI 摘编**：没有原文可比对的内容（如「做一卷《天工开物》偶遇卡包」），写为 `source: ai`，不能背诵。

语料里找不到、用户也没给原文时，Agent 请用户粘贴，不得默写。

## 5. 数据

### 5.1 目录

```text
<插件目录>/seeds/                  内置书卷，随插件发布，只读；与书库同 id 时以书库为准
<书库根目录>/                      默认 ~/.dsh/vibe-reader/library/，可用插件配置 libraryRoot 改为 Obsidian 或 Git 目录（绝对路径）
  yueyanglou-ji.md                书卷：原文与注释。插件只在入藏时写，之后只读
  yueyanglou-ji.notes.md          眉批：用户自己写的内容，可在 Obsidian 中阅读
~/.dsh/vibe-reader/
  state.json                      进度、复习调度、出卡权重、设置
  cache/<key>.json                书童回答缓存
  ask-log.jsonl                   书童调用记录（可关闭，§7.1）
```

所有写入都用「写临时文件再改名」的方式，并按文件串行，参考 novel-reader 的 `createLibrary`。`state.json` 无法解析时改名为 `state.corrupt-<时间>.json` 保留，重新开始，不覆盖。

### 5.2 书卷格式

```markdown
---
id: yueyanglou-ji
title: 岳阳楼记
author: 范仲淹
dynasty: 宋
kind: prose                 # poem | prose | article
source: chinese-poetry/蒙学/guwenguanzhi.json   # 或 用户粘贴 / ai
edition: 古文观止           # 版本，用于区分异文
verified: true              # true 人工核对 | corpus 已逐字对照开源语料 | false 未核对
fingerprint: sha256:…       # 规范化原文的哈希，入藏时写入
color: 苍翠                 # 只写色名，HEX 由内置色表提供
tags: [楼记, 洞庭, 忧乐]
---

## 作记缘由 {#s1}
> 脉络：滕子京谪守巴陵，重修岳阳楼并嘱托作记

庆历四年春，滕子京谪守巴陵郡。越明年，==政通人和，百废具兴==。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上，属予作文以记之。

- 【具】jù：通"俱"，全、都
- 【属】zhǔ：通"嘱"，嘱托

译：庆历四年春天，滕子京被贬为巴陵郡太守……
```

解析规则：

1. `## 标题 {#id}` 分节；`{#id}` 是稳定的节 ID，入藏时生成，之后不再改变。
2. 节标题下 `> 键：值` 是节信息：`脉络`（导读）、`作者`（诗集里每首诗的作者，如「唐 · 王之涣」）。
3. 正文段落是原文。`==…==` 只标出名句，不属于原文内容。
4. `- 【词】读音：释义` 是本节注释，读音可省略。以 `- ` 开头的块一律按注释解析，格式不对报错，不会被当成原文混进指纹。注释词按出现顺序匹配本节原文中第一个不重叠的位置。读音写在注释里，**不依赖自动注音**：pinyin-pro 面向现代汉语，处理不了「说 yuè」「见 xiàn」这类古文读音。
5. `译：` 开头的段落是译文。
6. **原文指纹**：去掉标题、节信息、注释、译文、`==` 标记和所有空白后，取剩余正文的 sha256。用 `scripts/fingerprint.mjs [--write]` 计算或写入。
7. **能否背诵**：没有格式错误、指纹一致、`verified` 为 `true` 或 `corpus`。其余只能阅读。

### 5.3 眉批文件

每条眉批用「原句 + 前后文」定位，思路同 W3C Web Annotation 的 TextQuoteSelector，不用字符位置：

```markdown
## s1
> 引：「百废具兴」 前：「政通人和，」 后：「。乃重修」
> 时间：2026-11-20 10:12 · 来源：书童（字词训诂）

具通俱。一年之内百废俱兴，是滕子京治绩的证据，也是作记的缘由。
```

原文变动后若找不到这段引文，界面提示「重新定位」，不静默丢弃。

### 5.4 state.json

```json
{
  "version": 1,
  "ui": { "view": "study", "volume": "yueyanglou-ji" },
  "volumes": { "yueyanglou-ji": { "lastSection": "s2", "readAt": "2026-11-20T02:10:00Z" } },
  "cards": {
    "yueyanglou-ji#s1": { "kind": "section", "level": 2, "reviews": 5, "lapses": 1, "lastRating": "remembered", "ratedAt": "2026-11-20T02:12:00Z" },
    "yueyanglou-ji#s1#政通人和，百废具兴": { "kind": "quote", "level": 1 }
  },
  "resurface": { "tangshi-liushou#s1": { "shown": 2, "lastShown": "2026-11-19" } },
  "settings": { "readAfterSeconds": 10, "followSessions": true, "showGloss": true, "vertical": false }
}
```

- 卡片键：节为 `卷id#节id`，名句为 `卷id#节id#名句原文`。
- M1 只记等级与自评次数；Leitner 的 `box`、`due` 在 M3 加入。
- 设置只接受上面四项，类型和范围由宿主端校验（阈值 3～600 秒）。

## 6. 入藏管线与原文校验

### 6.1 语料清洗（已实测 chinese-poetry 古文观止）

`蒙学/guwenguanzhi.json` 共 222 篇，每篇有 `chapter / author / paragraphs`，按段落存，结构可以直接用，但存在以下问题：

| 问题 | 实例 | 处理 |
|---|---|---|
| 繁体 | 全篇 | OpenCC 繁转简（在宿主端用 `opencc-js`，纯 JS） |
| 注释混入正文 | 《岳阳楼记》首段末尾 `(具 通：俱)` | 抽出为该段注释，正文中删除 |
| 断行留下的空格 | 《后赤壁赋》`月白風 清` | 删除汉字之间的空白 |
| 繁简转换错误 | 《阅江楼记》`遂錫嘉名爲"閱江"雲`，「云」误作「雲」 | 转简体后会碰巧还原；其他错误靠人工核对 |
| 异文、异体字 | 《静夜思》「床前看月光」「举头望山月」；《黄鹤楼》「昔人已乘白云去」；《登高》「猨啸哀」「衮衮来」「浊酒桮」 | 与通行本不同。M1 种子只选转简后与通行本一致的篇目；以后收录时在 `edition` 写明版本 |

结论：开源语料也不能直接当标准。逐字对照过语料的标 `verified: corpus`，人工通读核对过的标 `true`；背诵功能只对这两种开放，未核对的只能阅读。

M1 种子的对照结果：三卷每节字数与语料一致，169 组差异全部是繁简对应，没有多字、少字或异文。

语料来源（`lib/corpus.js`）：

| 档 | 集子 | 备注 |
|---|---|---|
| 常用（默认搜） | 古文观止、唐诗三百首、宋词三百首、诗经、千家诗、论语、大学 · 中庸 · 孟子、楚辞、纳兰性德词；蒙学（千字文、三字经两版、弟子规、增广贤文、朱子家训、百家姓，按诗处理、一联一行、按篇章分节）；蒙学骈文（声律启蒙按韵、幼学琼林按门类，按文章处理） | chinese-poetry，首次使用下载，约 4 MB。千字文语料无标点，按两句一联补「，」「。」；弟子规以空格分句，换成「，」；繁转简不处理的异体字（崐、茍、猨、桮、胷等）只报告不改 |
| 深度（`deep: true`） | 全唐诗（58 文件）、全宋词（23 文件）、元曲 | 首次约 36 MB，实测下载加建索引约 2 分钟，之后约 3 秒；opencc 约 350 万字/秒，可在内存中做全文检索 |
| 全宋诗（点名 `quansongshi`） | 约 25 万首 | 255 文件 104 MB，实测下载约 4 分钟；只在点名时下载和搜索，避免 deep 搜索把它载入宿主内存 |
| ctext（`ctext: true`） | 先秦两汉典籍 | `searchtexts`、`gettextinfo` 不需要认证；`gettext` 需要 API key（订阅），配置 `ctextApiKey` 或环境变量 `CTEXT_API_KEY`。用 `remap=gb` 直接取简体。目录型条目返回章节列表供选择 |

搜索排序：标题完全一致 > 标题开头 > 标题包含 > 词牌前缀（「念奴娇·赤壁怀古」能找到只题「念奴娇」的词）> 全文（4 字以上，名句在开头的优先）。

### 6.2 传统色

内置 zhongguose.com 的 526 色（`data/zhongguose.json`：取自 aEboli/zhongguose-palette 的 `references/source.json` 原始色值，加上其派生的色系、四季、五行、色调、明度字段），只用这一个来源，因为不同来源同一色名的 HEX 不同。书卷 `color` 只写色名，必须在色表内（`import` 校验，不在表内时给出近似色名）；面板用其 HEX 作卷名、导读竖线、偶遇卡片顶边的强调色。工具 `colors` 按色系、季节筛选，只列明度 0.08～0.35、在浅色和深色主题下都看得清的色。常见的「苍翠」「朱砂」「天青」不在表内，所以不能让 AI 凭印象写色名。

### 6.3 原文校验（AI 写盘前必做）

1. 用 §5.2 第 6 条的方法，从 AI 输出中提取规范化原文。
2. 与输入原文（同样规范化后）逐字比对。
3. 完全一致才写盘；不一致就拒绝，并把差异位置返回给调用方（Agent 或面板）。
4. 同时校验格式：每节都有 `{#id}`，`==` 成对出现且不跨行，`kind` 取值合法，色名在色表内。
5. 实现：`lib/verify.js`（字符级 Myers diff，先去掉公共前后缀，编辑距离超过 400 时给一段粗粒度差异）与 `lib/importer.js`。

## 7. AI 接入

### 7.1 书童：后端单次调用

- 链路：前端 `POST api/vibe-reader/ask` → 后端 `ctx.llm` 单次调用 → 返回文本。与探针一致，已实跑验证。
- 模型路由：插件配置的 `provider/model` 优先，未配置时回退到 `agentDefaultModel`。**建议显式配置便宜模型**，Desktop 默认模型很贵。
- 调用参数：取模型声明的最低推理强度，`maxTokens` 400，超时 45 秒，不传 `tools`、`sessionId`。
- 提示词带版本号，写入缓存键。
- 调用记录：书童不属于任何会话，DSH 不会记录这些请求。插件自己写 `ask-log.jsonl`（时间、路由、提示词版本、输入输出 token 数，不写正文），保证可追溯，可以关闭。

### 7.2 知人论世：先查 CBDB（M4）

宿主端先调用 CBDB API（`https://cbdb.fas.harvard.edu/cbdbapi/person?name=…`），把生平、任官、社会关系作为上下文交给模型，回答中注明「据 CBDB」。查询结果本地缓存。

### 7.3 刻书匠：工具 + skill

- 工具 `vibe_reader`，操作：`search`（搜语料）、`draft`（由 ref 生成草稿与清洗后的原文）、`clean`（§6.1 清洗粘贴的原文，可繁转简，返回繁简对应表）、`import`（原文 + 书卷，执行 §6.3 校验，通过后写盘）、`colors`（查传统色）、`list`、`read`、`verify`。失败返回 `{ ok: false, stage, problems }`，不抛错，方便 Agent 改正后重试。
- `import` 的 `verified`：`corpus` 来源为 `corpus`；`paste` 默认 `false`，只有用户明确说已核对才为 `true`；`ai` 来源不需要原文，固定 `false`。同 id 已在书库时需 `overwrite: true`，并报告原文是否变化、哪些节 ID 消失。
- skill「刻书匠」（`skills/vibe-reader-engraver/SKILL.md`）：铁律（不得默写原文、正文一字不改、只用 `import` 写入、失败时改书卷不改原文）、流程、格式、分节、注释、译文、名句规则。
- 实测（headless CLI，flash 模型，effort off）：Agent 先加载 skill，第一次 `import` 因把名句另抄一遍、正文多出 16 字被拒，按差异改正后第二次成功；书卷 6 条注释、脉络、译文、1 处名句，原文逐字一致。脚本：[m2-headless-import.mjs](m2-headless-import.mjs)。
- 工具对所有会话可见，描述控制在 200 字以内（单测检查）。建议开一个专门的「书房」会话做入藏，不混进编程上下文。
- 语料命令行 `scripts/import-corpus.mjs`：`search`、`draft`（`--out` 或 `--import`）、`prefetch`、`--list`，与工具共用 `lib/corpus.js`。
- 第二次 headless 实测（只说「把刘禹锡的《陋室铭》入藏」）：skill → search（带作者）→ draft → colors → import，一次成功；原文与语料逐字一致，一段拆为 4 节（只动空行），13 条注释，色名「苔绿」。

## 8. 接口清单

| 端 | 内容 |
|---|---|
| 前端 inject | `slots`、`sidebarRight`、`sidebarRightTabs`、`uiSession`、`sessions`、`uiWorkspace` |
| 后端 inject | 全部可选，用 `ctx.inject([...], cb)` 挂接：`connection`（面板 HTTP）、`tools`、`skills`（M2）；M4 加 `llm`、`agentDefaultModel`。headless 等没有 HTTP 的环境里，工具和 skill 照常可用 |
| HTTP | `GET api/vibe-reader/library`（书卷列表、偶遇卡片、state、书库目录）、`POST api/vibe-reader/volume`（`{ id }` → 整卷）、`POST api/vibe-reader/state`（`{ op: view / progress / rate / level / seen / gloss / settings }`）、`POST api/vibe-reader/mark-verified`（`{ id }`：书库里未核对、指纹一致的书卷，只把 frontmatter 的 `verified` 改为 `true`）。只用固定路径，不依赖查询参数（宿主路由对查询串的处理没有文档）。以后：`POST api/vibe-reader/notes`、`POST api/vibe-reader/ask` |
| 工具 | `vibe_reader` |
| skill | `vibe-reader-engraver`（刻书匠） |

## 9. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 阅读器（不接 AI）**已实现，Desktop 验收通过（2026-11-20）** | 解析器与原文指纹、`state.json`、偶遇与修业两个视图、夹注与译文、背诵等级、自动保存进度、Agent 状态提示条、跨会话跟随；3 卷人工核对的种子（唐诗若干首、《岳阳楼记》、《前赤壁赋》） | 单测覆盖解析、指纹、背诵等级、状态机；Desktop 实机：任一会话运行超过 10 秒出现「可读」；后台会话结束后出现在「已完成」，打开该会话后消失；审批出现在「需要你」；点列表条目能跳到对应会话，阅读器跟过去并停在同一节；没在读时切换会话不弹出右侧栏；关闭再打开回到原来的节 |
| M2 入藏**已实现（2026-11-20），待 Desktop 验收**；ctext 取正文需用户自备 API key | 语料导入脚本（chinese-poetry / ctext → 清洗）、粘贴原文 + AI 注释、`vibe_reader` 工具与刻书匠 skill、原文校验、色表 | 故意改动原文一个字，校验能拒绝；古文观止导入的篇目通过清洗规则 |
| M3 复习与偶遇 | Leitner 调度、出卡顺序、眉批回看、按节气选诗、只读模式 | 到期卡优先出现；评分后到期日变化正确 |
| M4 书童 | `POST ask`、缓存与过期提示、`ask-log.jsonl`、存为眉批、CBDB 查询 | 同一问题第二次不调用模型；原文变动后缓存显示过期；会话日志中没有书童请求 |
| 以后 | 相似句索引（4～5 字片段）、一般文章导入、换 ts-fsrs | — |

## 10. 风险与未决问题

1. ~~全部会话视图待 Desktop 复验~~：已通过（探针第二轮、M1 验收）。
2. **sessionStatus 的范围**：快照包含历史会话（实测 255 个）。只有运行中、需要你、已完成三组会列出来，数量不会大；但每次快照变化都要遍历一遍，M1 里如果卡顿，改为只处理变化的条目。
3. **工具对所有会话可见**：`vibe_reader` 会出现在每个编程会话的工具列表里。尚未找到按会话限定插件工具的方法；描述已压到 200 字以内，必要时改为只用 skill 加 HTTP。
4. **同一网关的并发**：书童与主 Agent 共用 magpie 网关，高频划词可能挤占额度。需要做节流（例如同一时间只允许一个请求，每分钟上限 N 次）。
5. ~~OpenCC 依赖~~：已定为插件依赖（`npm install` 装在插件目录，不提交 node_modules），宿主端按需加载；缺失时只有繁体导入不可用。实测 t2s 结果与人工核对的种子逐字一致。
6. **右侧栏按会话保存**（已实测，跟随已通过）：切换会话后标签消失。按 §4.1 做跟随；副作用是读过的会话里都会留下一个阅读器标签（各会话布局独立，关掉一个不影响别的）。如果跟随在实机上不顺，备选是左侧栏 `sidebar.panellist`，代价是占满主栏、看不到会话。
7. **窄侧栏排版**：M1 实测可以接受。已知问题：双行夹注较宽时会换行，把紧跟的句读挤到下一行开头（如「。少焉」），M2 顺带修。

## 11. 参考

| 项目 | 借鉴 |
|---|---|
| [ghostcode/guwen](https://github.com/ghostcode/guwen) | 按段落存原文、译文、注释；朱砂双行夹注；背诵时自动隐藏注释和译文 |
| [claude-learn-while-waiting](https://github.com/avolcoff/claude-learn-while-waiting) | 回合开始后超过阈值才触发；子代理回合不算；回合结束暂停（但不要学它切换窗口） |
| [zobott-dot/by-heart](https://github.com/zobott-dot/by-heart/tree/main) | 逐级减少可见字；不改动原文标点与分行；不计分的静读模式 |
| [背诵助手](https://apps.apple.com/my/app/%E8%83%8C%E8%AF%B5%E5%8A%A9%E6%89%8B-%E4%B8%AD%E8%8B%B1%E5%8E%9F%E6%96%87%E8%83%8C%E8%AF%B5%E5%88%A9%E5%99%A8/id1440699369?platform=mac)、[小妙背古诗](https://passmetheplay.github.io/pub_doc/poemcard_intro.html) | 首字提示；从末句到全篇逐轮遮挡 |
| [RecursiveFunctions/obsidian-incremental-reading](https://github.com/RecursiveFunctions/obsidian-incremental-reading) | 从不改写原文件；锚点失效时提供重新定位 |
| [Readwise 每日回顾](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights)、[Mastery](https://docs.readwise.io/readwise/guides/mastery) | 新内容加到期卡的混合；每出现一次降低再出现概率 |
| [liufree/ai-cloze](https://github.com/liufree/ai-cloze) | AI 结果缓存；原文变化时提示过期；只在手动点击时重跑 |
| [montricwang/poeticus](https://github.com/montricwang/poeticus) | 划选提问伴读；寻找前代相似句；明确标注 AI 内容需核实 |
| [What to Do While Waiting for AI Code Assistants](https://super-productivity.com/blog/what-to-do-while-waiting-for-claude-code/) | 读新材料会切换上下文；按不确定性而非时长选择活动 |
| [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry) | 唐诗、宋词、古文观止等原文语料（需清洗，§6.1） |
| [ctext API](https://ctext.org/plugins/apilist/zhs) | 先秦两汉经典原文 |
| [CBDB API](https://input.cbdb.fas.harvard.edu/cbdbapi/index.html) | 人物生平、任官、社会关系 |
| [aEboli/zhongguose-palette](https://github.com/aEboli/zhongguose-palette) | 526 色传统色原始数据 |
| [ts-fsrs](https://www.npmjs.com/package/ts-fsrs) | 以后替换 Leitner 的调度算法 |
| [pinyin-pro](https://github.com/zh-lx/pinyin-pro) | 不采用：现代汉语注音，处理不了古文读音 |
| 西窗烛 | 诗词日历、诗词天气 → 按节气和时辰选诗 |
