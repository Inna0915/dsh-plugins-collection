# 闲庭 · Vibe Reader（dsh-vibe-reader）

DSH Desktop 右侧栏插件。在等 Agent、等构建、等测试的间隙，读一则、背一段完整的古诗文；Agent 跑完或需要你时，面板里会提示，点一下就回到那个会话。

当前完成 M1（阅读器）和 M2（入藏）；面板本身不调用模型，入藏由 Agent 借刻书匠 skill 完成。完整规格见 [plans/2026-11-20-vibe-reader/spec.md](../../plans/2026-11-20-vibe-reader/spec.md)。

## 安装

1. 在本目录运行 `npm install`，装上繁转简用的 opencc-js（只有导入繁体语料时需要，缺了不影响阅读）。
2. Desktop → 插件管理 → 安装本地目录，选本目录。装好后点会话顶栏右侧的书本图标打开「闲庭」（再点一次收起），也可以从右侧栏「开始」页进入。

如果之前装了验证用的「闲庭探针」（`dsh-vibe-reader-spike`），先在插件管理里移除它。

## 用法

| 位置 | 作用 |
|---|---|
| 偶遇 | 从整个书库抽卡：诗卷里的每一首、文章里的每个名句（`==…==`）。出现过的卡下次出现的概率变低，不会连续出同一张。短诗可切换竖排 |
| 修业 | 按卷顺读，自动记住读到哪一节。卷首显示书卷色、卷名、作者，点「书架」换卷：最近读过的排前，显示「读到 參／伍」。顶部搜索框可搜书名、作者、朝代、标签，也能搜卷内篇名和诗人（如「春望」「杜甫」会列出《唐诗六首》里的那一首，点它直接打开该节）；回车打开第一项，Esc 收起；多于 6 卷时另有「全部 / 诗词 / 文章 / 背诵中 / 未读」筛选，以及标签筛选（学段 小学 / 初中 / 高中 / 蒙学 在前，其余是出现在两卷以上的标签），两者可叠加。每卷在作者后显示学段标签。节序用繁体大写 壹 貳 參…，背过的节在格子底部显示等级细条（L5 为满格），← → 翻节。上下两节淡显，点击可跳过去。注释有三种显示，用按钮切换并按卷记住：**夹注**（双行小字插在正文里，适合注释稀疏的文章）、**句下**（读音标在字上方，释义列在每联或每段下面；诗卷和注释密的书卷默认用它）、**点词**（正文干净，点有下划线的词才显示释义）。名句（`==…==`）用书卷色的字标出。译文和「本节注释」默认展开，收起后记住；句下模式里正文已排出的注释不再重复列出 |
| 试背 | 按 L0–L5 逐级隐字：全文 → 每 5 字隐 1 → 每 3 字隐 1 → 只留每句首字 → 只留标点和分段 → 整段折叠。点隐藏的字可看，自评「忘了 / 模糊 / 记得」降级、不变或升级 |
| 书卷色 | 每卷可配一个中国传统色（zhongguose.com 526 色），用作卷名、导读竖线、偶遇卡片顶边的强调色 |
| 状态提示条 | 汇总全部会话：需要你（红）、已完成待查看（黄）、可以读一则（绿，最久的回合超过阈值）。点开是会话列表，点一条跳过去 |
| 跟随 | 右侧栏每个会话各存一份布局。正在读时切换会话，阅读器会在新会话里自动打开；没在读就不动 |
| ↻ / 自动刷新 | 任一会话的 Agent 回合结束后自动重读书库（入藏就发生在回合里），面板开着时每 15 秒也会检查一次（发现在 Obsidian 等处手改的书卷）；↻ 随时手动刷新。有新入藏的书卷时顶部提示「新入藏：《…》」，点书名直接打开 |
| ⚙ | 字号（小 / 标准 / 大 / 更大 / 特大，整个面板等比缩放）、跟随开关、可读阈值（默认 10 秒，按 3～600 秒的常用档位增减）、书库卷数与目录 |

只有核对过的书卷能背诵：frontmatter 的 `verified` 为 `true`（人工核对）或 `corpus`（已逐字对照开源语料），且原文指纹一致。其余书卷只能阅读；你自己书库里未核对的书卷，通读后可点提示旁的「我已核对」，只把 `verified` 改为 `true`，不动原文。

## 数据

| 路径 | 内容 | 谁写 |
|---|---|---|
| `seeds/` | 内置三卷：《唐诗六首》《岳阳楼记》《前赤壁赋》 | 随插件发布，只读 |
| `~/.dsh/vibe-reader/library/*.md` | 你自己的书卷；与内置同 id 时以这里为准 | 你，或 `vibe_reader import`（校验通过才写） |
| `~/.dsh/vibe-reader/cache/corpus/` | 下载过的 chinese-poetry 语料（常用集子约 3 MB；深度搜索再加约 36 MB） | 工具 `search` 与语料脚本 |
| `data/zhongguose.json` | 中国传统色 526 色（色值来自 zhongguose.com，作者 Perchouli） | 随插件，只读 |
| `~/.dsh/vibe-reader/state.json` | 视图、读到哪一节、背诵等级、出卡次数、设置 | 插件（临时文件 + 改名，串行写） |

书库目录可以在 `cordis.patch.yml` 的 `config.libraryRoot` 里改成绝对路径（例如 Obsidian 库里的某个文件夹）。`state.json` 如果损坏，会被改名为 `state.corrupt-<时间>.json` 保留，然后重新开始，不会被覆盖。

## 入藏

导入只有一个入口：在任一 DSH 会话里直接说，skill **`vibe-reader-engraver`（闲庭导入／刻书匠）** 会按描述自动接手，不用点名。面板上没有手动录入。建议开一个专门的「书房」会话，不混进编程上下文。

| 你说 | Agent 做 | `verified` |
|---|---|---|
| 「导入静夜思」「收录赤壁赋」「导入『会当凌绝顶』那首」 | `search` 找原文 → 唯一结果直接导；多个时请你选 → `draft` → 补节标题、脉络、注释、译文、名句、配色 → `import` | `corpus` |
| 「导入李白的诗」「导入《论语》」「导入这些：静夜思、春晓、咏鹅」 | 按作者、书名或清单逐篇导；整本书按篇章分卷（论语每篇一卷）。一次超过 5 篇默认只导原文 | `corpus` |
| 贴上一段原文，说「收录这篇」 | 繁体或带括注时先 `clean` → 起草 → `import` | 默认 `false`；你说过「这是课本原文／已核对」才为 `true` |
| 「给《静夜思》加注」 | `read` → 补注释、译文 → `import` 带 `keepOriginal: true`，原文以书库里那一卷为准 | 不变 |

headless 实测：只发「导入《醉翁亭记》」五个字，Agent 自己加载 skill，search → draft → colors → import，4 节、30 条注释、每节译文，学段标签「初中」，原文与语料逐字一致。

没有原文、只想要某主题的摘编卡片时，Agent 以 `source: ai` 入藏，不能背诵。语料里找不到、你也没给原文时，Agent 会请你粘贴，不会默写。

**原文校验**：`import` 把书卷正文和原文都去掉空白与 `==` 后逐字比对，不一致就拒绝写入，并指出差异位置，例如「第 14 字附近「…欲【尽】千里目…」：原文「尽」，书卷写成「穷」」。headless 实测：

- 贴原文入藏《早发白帝城》：Agent 第一次把名句多抄了一遍，被拦下后自行改正。
- 只说「把刘禹锡的《陋室铭》入藏」：Agent 依次 search → draft → colors → import，一次成功；原文与语料逐字一致，把一整段拆成 4 节（只动空行），13 条注释，配色「苔绿」。

### 语料

| 档 | 集子 | 说明 |
|---|---|---|
| 常用（默认搜） | 古文观止 222 篇、唐诗三百首、宋词三百首（280 篇）、诗经、千家诗、论语、大学 · 中庸 · 孟子、楚辞、纳兰性德词；蒙学：千字文、三字经（新版、传统版）、弟子规、增广贤文、朱子家训、百家姓；蒙学骈文：声律启蒙（按韵 30 篇）、幼学琼林（按门类） | 首次使用时下载，共约 4 MB |
| 深度（`deep: true`） | 全唐诗、全宋词、元曲 | 首次约 36 MB，实测下载加建索引约 2 分钟；之后搜索约 3 秒 |
| 全宋诗（`collections: ['quansongshi']`） | 约 25 万首 | 104 MB，实测下载约 4 分钟；只在点名时下载和搜索，不随 `deep` 加载进内存。可先 `node scripts/import-corpus.mjs prefetch quansongshi` |
| ctext（`ctext: true`） | 先秦两汉典籍书目 | 搜书目不需要认证；**取正文需要 API key**（ctext.org 订阅）。在 `~/.dsh/.env` 设 `CTEXT_API_KEY`，或在插件配置里写 `ctextApiKey`。没有 key 时 Agent 会请你粘贴原文 |

- 搜索顺序：标题完全一致 > 标题开头 > 标题包含 > 词牌（「念奴娇·赤壁怀古」能找到只题「念奴娇」的词）> 全文（4 字以上，名句在开头的排前面）。
- 草稿：文章一个自然段一节（「第 N 段」占位）；诗词一首一节，超过 16 句按 8 句粗分，诗经超过 6 章按 4 章分；蒙学韵文一联一行，按篇章分节（弟子规「入则孝」等），超过 16 联按 8 联分。语料自带的 `(具 通：俱)` 括注转成注释。
- 语料特例：千字文语料没有标点，按四字一句、两句一联补「，」「。」；弟子规语料用空格分隔三字句，换成「，」。繁转简不处理的异体字（如千字文「崐冈」、三字经「茍不教」）只在报告里列出，不改原文，刻书匠会问你用哪个版本。
- 语料版本与课本不一定相同（见文末），Agent 发现有出入会提醒你。

**工具 `vibe_reader`** 对所有会话可见（描述控制在 200 字内）：

| action | 作用 |
|---|---|
| `search` | 搜语料：`query`（篇名、词牌、名句）、`author`、`collections`、`deep`、`ctext` |
| `draft` | 由 `refs` 生成草稿，返回 `markdown`、`original`、`report`（繁简对应、警告） |
| `clean` | 清洗粘贴的原文：括注、汉字间空白、半角句读，`traditional: true` 时繁转简 |
| `import` | 校验后入藏；色名必须在色表内；同 id 已存在时需 `overwrite: true`，并报告原文是否变了、哪些节 ID 不见了；`keepOriginal: true` 给已有书卷补注释（原文、来源、核对状态取书库里那一卷） |
| `colors` | 查传统色：按 `family`（色系）、`season` 筛选，只列适合作强调色的中等明度色 |
| `list` / `read` / `verify` | 列书卷、取某卷 Markdown、检查格式和指纹 |

### 命令行（同一套逻辑）

```bash
node scripts/import-corpus.mjs search 陋室铭                       # 输出 ref、标题、作者、集子、开头
node scripts/import-corpus.mjs search 念奴娇 --author 苏轼 --deep
node scripts/import-corpus.mjs draft guwenguanzhi:116 --id loushi-ming --out 草稿.md
node scripts/import-corpus.mjs draft guwenguanzhi:116 --id loushi-ming --import   # 不加注直接入藏
node scripts/import-corpus.mjs prefetch                             # 预先下载深度集子
node scripts/import-corpus.mjs --list tang300 --grep 李白
```

## 书卷格式

```markdown
---
id: yueyanglou-ji
title: 岳阳楼记
author: 范仲淹
dynasty: 宋
kind: prose            # poem | prose | article
source: chinese-poetry/蒙学/guwenguanzhi.json
edition: 古文观止
verified: corpus       # true 人工核对 | corpus 对照语料 | false 未核对
fingerprint: sha256:…  # 用 scripts/fingerprint.mjs 计算
color: 晚波蓝          # 可选，必须是色表里的色名
tags: [楼记, 洞庭]
---

## 作记缘由 {#s1}
> 脉络：一句话导读
> 作者：唐 · 王之涣         （诗集里每首诗可以单独写作者）

庆历四年春，……越明年，==政通人和，百废具兴==。……

- 【具】jù：通“俱”，全、都
- 【越明年】到了第二年

译：庆历四年春天，……
```

- 每个 `##` 是一节，`{#id}` 是稳定的节 ID，写好后不要改：进度和背诵等级都按它记录。
- 诗卷（`kind: poem`）保留原文换行，每节是一首诗。
- 以 `- ` 开头的块都按注释解析，格式不对会报错，不会被当成原文。
- 改了原文之后指纹会不一致，背诵自动暂停。核对无误后运行：

```bash
node scripts/fingerprint.mjs ~/.dsh/vibe-reader/library/某卷.md --write
```

## 开发

```bash
node --test                # 解析、指纹、state、书库、HTTP、背诵、夹注、抽卡、状态与跟随、清洗、校验、入藏、色表、工具、语料（假网络）
```

| 文件 | 内容 |
|---|---|
| `lib/volume.js` | 书卷解析、原文指纹、偶遇卡片 |
| `lib/store.js` | 书库扫描（按 mtime 缓存）、state.json 读写与操作校验 |
| `lib/clean.js` | 语料清洗与繁转简（opencc-js，按需加载） |
| `lib/verify.js` | 原文逐字比对（Myers diff，差异太大时给出粗粒度结果） |
| `lib/importer.js` | 入藏：格式、原文校验，写入指纹和 `verified`，原子写入 |
| `lib/corpus.js` | 语料：集子定义、下载缓存、索引与搜索、草稿生成、ctext |
| `lib/palette.js` | 传统色查询与筛选 |
| `lib/tool.js` | 工具 `vibe_reader` |
| `skills/vibe-reader-engraver/SKILL.md` | 刻书匠 skill |
| `index.js` | 宿主端：HTTP 三个接口；可选注册工具和 skill（`connection`、`tools`、`skills` 都是可选服务） |
| `client.js` | 右侧栏面板；会话状态和跟随的逻辑与 `plans/2026-11-20-vibe-reader/spike` 中验证过的一致 |
| `scripts/fingerprint.mjs` | 计算或写入原文指纹 |
| `scripts/import-corpus.mjs` | 语料命令行：search、draft、prefetch、--list |
| `test/fixtures/chinese-poetry-sample.json` | 三卷种子对应的语料原始段落（MIT），用来验证清洗结果与种子逐字一致 |

端到端检查（headless CLI 实跑一次入藏，用临时 DSH_HOME，不碰真实书库）：`node plans/2026-11-20-vibe-reader/m2-headless-import.mjs [--scenario paste|search]`

## 种子书卷的来源与核对

原文取自 [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry)（繁体），转为简体（M2 的自动清洗得到的结果与之逐字一致，见 `test/clean.test.mjs`），抽出混在正文里的注释（如《岳阳楼记》首段末的 `(具 通：俱)`），删去断行空格，半角问号改为全角。之后与语料逐字对照：每节字数一致，169 组差异全部是繁简对应。注释和译文是新写的，不来自语料。

唐诗只选了转简后与通行本一致的六首。语料里有些篇目与课本不同，暂未收录，例如：《静夜思》作「床前看月光」「举头望山月」，《黄鹤楼》作「昔人已乘白云去」，《登高》作「猨啸哀」「衮衮来」「浊酒桮」。

三卷目前是 `verified: corpus`，你通读确认后可以改成 `true`。配色：岳阳楼记「晚波蓝」、前赤壁赋「淡蓝灰」、唐诗六首「梧枝绿」。
