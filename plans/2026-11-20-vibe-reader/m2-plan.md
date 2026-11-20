# M2 入藏：实施计划

- 日期：2026-11-20
- 前置：M1 已提交（`35dcfac`），规格见 [spec.md](spec.md) §4.8、§6、§7.3
- 读者：作者本人和继续实现的 Agent

## 范围

| 项 | 内容 | 验收 |
|---|---|---|
| 清洗 | `lib/clean.js`：抽出括号夹注、删汉字间空白、半角句读转全角、opencc-js 繁转简；输出变更报告（抽出的注释、繁简对应表） | 用 chinese-poetry 原始段落清洗《岳阳楼记》《前赤壁赋》和六首唐诗，指纹与内置种子一致 |
| 原文校验 | `lib/verify.js`：规范化后逐字比对，返回差异位置和前后文；格式校验沿用解析器，加色名校验 | 故意改动一个字，导入被拒绝，并指出位置 |
| 写入 | `lib/importer.js`：校验通过才写入书库，写入指纹和 `verified`；同名文件默认拒绝，`overwrite` 时报告原文是否变化、哪些节 ID 消失 | 写入是原子的；拒绝时不留文件 |
| 工具 | `vibe_reader`：`list`、`read`、`clean`、`import`、`verify`；描述尽量短 | 用假 ctx 单测；headless CLI 实跑一次入藏 |
| skill | `vibe-reader-engraver`（刻书匠）：格式、分节、注释写法、不得默写原文、流程 | headless 实跑时 Agent 按 skill 完成入藏 |
| 语料脚本 | `scripts/import-corpus.mjs`：从 chinese-poetry 下载（本地缓存）→ 清洗 → 输出书卷草稿 | `--list` 能列篇目；输出的草稿能直接解析且指纹正确 |
| 色表 | 视来源许可决定是否内置 zhongguose 色表 | — |
| 面板 | 「入藏」说明与可复制的提示词；双行夹注后的句读不再被挤到行首 | Desktop 实机看一眼 |

## 已定的决定

- opencc-js 作为插件依赖装在插件目录（不提交 node_modules）；宿主端按需加载，缺失时只有繁体导入不可用。
- 粘贴原文默认 `verified: false`；只有用户明确说已核对，Agent 才传 `verified: true`。语料导入为 `corpus`。
- ctext（先秦两汉）推迟到 M2 之后：限速、格式不同，单独处理。

## 结果（2026-11-20）

| 项 | 状态 | 证据 |
|---|---|---|
| 清洗 | 完成 | `test/clean.test.mjs`：语料原始段落经自动清洗（opencc-js）后，与三卷种子逐字一致，岳阳楼记的三条括注转为注释 |
| 原文校验 | 完成 | `test/import.test.mjs`：改一个字被拒绝并指出「原文「流」，书卷写成「留」」，书库目录不产生文件 |
| 写入 | 完成 | 指纹、`verified`、`source` 由写入器决定；同 id 需 `overwrite`；报告原文变化和消失的节 ID |
| 工具 | 完成 | 单测覆盖五个操作；headless 实跑通过 |
| skill | 完成 | headless 实跑：Agent 加载 skill → 第一次 import 被校验拦下（名句另抄一遍）→ 改正后成功 |
| 语料脚本 | 完成 | 实际下载四个集子；岳阳楼记草稿指纹与种子一致；诗经两首 `--import` 成功 |
| 色表 | 推迟 | 来源仓库许可证未声明 |
| 面板 | 完成，待 Desktop 看 | 「＋」入藏说明与放进输入框；双行夹注与后面的句读同组不换行；面板重新显示时自动重读书库（未改动的书卷不重新拉取） |

单测 50 个全部通过。另把宿主端的 `connection` 改为可选服务，headless 环境里只有工具和 skill 也能加载。

## M2b：入藏全走 skill、补做色表与 ctext（2026-11-20，已完成）

用户要求：入藏打包成 skill，能直接调用「找文章」（搜语料）或「复制完整文章」（粘贴全文）入库；去掉面板上的手动入口；色表和 ctext 直接做（项目不分发，许可不是顾虑）。

决定：

- 面板去掉「＋」入藏面板；入藏只通过 skill `vibe-reader-engraver` + 工具 `vibe_reader`。
- 工具新增 `search`（按标题、作者、名句搜语料）、`draft`（取语料生成书卷草稿）、`colors`（列色表）。语料逻辑从 `scripts/import-corpus.mjs` 移到 `lib/corpus.js`，脚本变成薄 CLI。
- 语料分两档：常用档（古文观止、唐诗三百首、宋词三百首、诗经、千家诗、论语、大学中庸孟子、楚辞、纳兰词）默认搜；深度档（全唐诗 58 文件约 23 MB、全宋词 23 文件约 9 MB、元曲 4 MB）在 `deep: true` 时下载、缓存、建索引（opencc 约 350 万字/秒，可做全文检索）。
- ctext：`searchtexts` 与 `gettextinfo` 无需认证，`gettext` 需要 API key（订阅）。实现为：搜索可用；取正文需配置 `ctextApiKey`（插件配置）或环境变量 `CTEXT_API_KEY`，未配置时明确提示。查询用 `remap=gb` 直接拿简体。
- 色表：内置 zhongguose.com 526 色（取自 aEboli/zhongguose-palette 的 `references/source.json` 与派生字段 family/season/wuxing/tone/luminance），`color` 必须在色表内，面板用其 HEX 做书卷强调色。

结果：

| 项 | 状态 | 证据 |
|---|---|---|
| 去掉面板入藏入口 | 完成 | `client.js` 不再有「＋」面板 |
| search / draft / colors | 完成 | `test/corpus.test.mjs`（假网络）：标题、全文、词牌、作者、长诗拆节、诗经分章、深度集子按需下载与缓存、ctext 鉴权与目录；真实网络：陋室铭、会当凌绝顶、学而时习之、出师表（含 ctext 书目）、深度搜索念奴娇（苏轼，全宋词）均命中 |
| 色表 | 完成 | 526 色内置；`import` 拒绝表外色名并给近似色；种子配色晚波蓝、淡蓝灰、梧枝绿；面板强调色 |
| ctext | 完成（取正文待 key） | 搜书目可用；`gettext` 无 key 时返回明确提示；有 key 的路径用假响应测过，未用真 key 实跑 |
| skill | 完成 | 两种入口（说篇名找 / 贴全文）；headless 两个场景均通过 |

单测 56 个全部通过。
