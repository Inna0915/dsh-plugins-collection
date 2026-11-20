# 闲庭 · Vibe Reader（dsh-vibe-reader）

DSH Desktop 右侧栏插件。在等 Agent、等构建、等测试的间隙，读一则、背一段完整的古诗文；Agent 跑完或需要你时，面板里会提示，点一下就回到那个会话。

当前是 M1：只有阅读器，不调用模型。完整规格见 [plans/2026-11-20-vibe-reader/spec.md](../../plans/2026-11-20-vibe-reader/spec.md)。

## 安装

Desktop → 插件管理 → 安装本地目录，选本目录。装好后在右侧栏「开始」页点「闲庭」。

如果之前装了验证用的「闲庭探针」（`dsh-vibe-reader-spike`），先在插件管理里移除它。

## 用法

| 位置 | 作用 |
|---|---|
| 偶遇 | 从整个书库抽卡：诗卷里的每一首、文章里的每个名句（`==…==`）。出现过的卡下次出现的概率变低，不会连续出同一张。短诗可切换竖排 |
| 修业 | 按卷顺读，自动记住读到哪一节。上下两节淡显，点击可跳过去。「注」开关双行夹注，「译」展开译文，「本节注释」列出全部注释 |
| 试背 | 按 L0–L5 逐级隐字：全文 → 每 5 字隐 1 → 每 3 字隐 1 → 只留每句首字 → 只留标点和分段 → 整段折叠。点隐藏的字可看，自评「忘了 / 模糊 / 记得」降级、不变或升级 |
| 状态提示条 | 汇总全部会话：需要你（红）、已完成待查看（黄）、可以读一则（绿，最久的回合超过阈值）。点开是会话列表，点一条跳过去 |
| 跟随 | 右侧栏每个会话各存一份布局。正在读时切换会话，阅读器会在新会话里自动打开；没在读就不动 |
| ⚙ | 夹注、跟随、可读阈值（默认 10 秒），以及书库目录和「重新读取书库」 |

只有核对过的书卷能背诵：frontmatter 的 `verified` 为 `true`（人工核对）或 `corpus`（已逐字对照开源语料），且原文指纹一致。其余书卷只能阅读。

## 数据

| 路径 | 内容 | 谁写 |
|---|---|---|
| `seeds/` | 内置三卷：《唐诗六首》《岳阳楼记》《前赤壁赋》 | 随插件发布，只读 |
| `~/.dsh/vibe-reader/library/*.md` | 你自己的书卷；与内置同 id 时以这里为准 | 你（M2 起也由入藏工具写） |
| `~/.dsh/vibe-reader/state.json` | 视图、读到哪一节、背诵等级、出卡次数、设置 | 插件（临时文件 + 改名，串行写） |

书库目录可以在 `cordis.patch.yml` 的 `config.libraryRoot` 里改成绝对路径（例如 Obsidian 库里的某个文件夹）。`state.json` 如果损坏，会被改名为 `state.corrupt-<时间>.json` 保留，然后重新开始，不会被覆盖。

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
node --test                # 解析、指纹、state、书库合并、HTTP、背诵遮挡、夹注定位、抽卡、状态与跟随
```

| 文件 | 内容 |
|---|---|
| `lib/volume.js` | 书卷解析、原文指纹、偶遇卡片 |
| `lib/store.js` | 书库扫描（按 mtime 缓存）、state.json 读写与操作校验 |
| `index.js` | 宿主端 HTTP：`GET api/vibe-reader/library`、`POST api/vibe-reader/volume`、`POST api/vibe-reader/state` |
| `client.js` | 右侧栏面板；会话状态和跟随的逻辑与 `plans/2026-11-20-vibe-reader/spike` 中验证过的一致 |
| `scripts/fingerprint.mjs` | 计算或写入原文指纹 |

## 种子书卷的来源与核对

原文取自 [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry)（繁体），转为简体，抽出混在正文里的注释（如《岳阳楼记》首段末的 `(具 通：俱)`），删去断行空格，半角问号改为全角。之后与语料逐字对照：每节字数一致，169 组差异全部是繁简对应。注释和译文是新写的，不来自语料。

唐诗只选了转简后与通行本一致的六首。语料里有些篇目与课本不同，暂未收录，例如：《静夜思》作「床前看月光」「举头望山月」，《黄鹤楼》作「昔人已乘白云去」，《登高》作「猨啸哀」「衮衮来」「浊酒桮」。

三卷目前是 `verified: corpus`。你通读确认后，可以改成 `true`。
