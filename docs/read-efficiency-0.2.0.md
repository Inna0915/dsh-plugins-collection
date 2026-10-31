# Confluence Flow 0.2.0 读取优化验证

日期：2026-10-30。测试使用现有连接的默认根页范围。数字以 UTF-8 JSON 字节计，不与先前报告的字符数混用；本次默认范围得到 9 个候选，不能直接当成之前 13/17 页任务的复跑。

## 同一组页面的输出量

| 项目 | 实测 |
| --- | ---: |
| 一次 `idoc` 搜索 | 9 个候选，totalSize=9，6,130 字节 |
| 对同一批快照按旧字段结构重建完整返回 | 300,738 字节 |
| 唯一 wiki 正文合计（未截断、不含元数据） | 84,204 字节 |
| 新版 scan：命中数、首条上下文与快照标识 | 6,852 字节，一次返回全部 9 页 |
| 默认 read 第一段合计 | 32,876 字节；其中 2 页截断，可从快照续读 |

去掉重复表示后，纯 wiki 正文约为旧完整结果的 28.0%。用于判断相关性的 scan 比旧完整结果少 97.7%（约 43.9 倍）；它提供定位片段，并不等价于已经精读全部正文。read 的截断明确标记，不静默丢弃后文。

## 耗时与网络请求

| 验证路径 | 服务执行耗时 | Confluence 请求数 |
| --- | ---: | ---: |
| 单次搜索 | 1,073 ms | 1 |
| 强制跳过缓存扫描同一组候选 | 1,405 ms | 9 |
| 随后重复 scan | 27 ms | 0 |
| 从快照 grep 精读 | 本地读取 | 0 |

冷扫描采用 4 并发，服务端仍按页请求。为验证最终输出格式，开发期间有两轮有意强制抓取的基准扫描；表中展示最终一次，而非本次开发过程的总请求账本。候选沿用第一次搜索，未反复更换搜索词。上述时间含运行层及凭据处理，不是纯内网 RTT，也不包括模型生成/处理时间，不能宣称整段对话提速 43.9 倍。

P329 案例：对缓存的 SAP 接口对接记录（58769855）以“字段”检索，匹配 4 处；SNC 调研（130713538）匹配 0 处。继续复用已有的 TO 单快照（47691395），定位到参数表，匹配 33 处。仅输出局部片段与计数，未重新抓取这些页面。快照字段结果不代表已经验证所有 SAP 字段定义。

## lossless JSON 原因与修复

47690629 的旧返回含 `defaultRegionId: undefined`，检查未发现无效代理字符或非法控制字符。CLI 的 JSON.stringify 会省略该属性，DSH 严格对象校验拒绝它。

使用已安装 DSH 的 `@deepseek-ai/dsh-util-values` 中 `snapshotJsonValue` 直接核验：旧对象拒绝，新版完整返回通过。修复位于共享返回边界，影响 DSH/CLI/MCP/HTTP；省略对象 undefined，数组空值转 null；返回表示中的孤立代理字符/非有限数值降级并带 warning。合法换行、制表符保留，原始 storage、修改底稿及服务器内容不做清洗。

## 契约与验证

- 默认 read 只有 wiki 与元数据，支持 grep/context/head、指定章节、批量 pages；默认 8 KiB 完整 JSON 预算，固定版本 snapshotId + nextOffset 本地续读。
- scan 支持去重、4 并发、逐页失败隔离；scanId + nextStart 在本地分页。五分钟缓存跨 CLI/MCP 实例复用；refresh 跳过缓存，成功写入使阅读索引失效。
- 搜索使用服务器 `/rest/api/search` 摘要接口，包含 snippet、totalSize、updated；按更新时间倒序，支持 space/parent/label，显式 all/any/phrase。索引短语和 grep 字面匹配的区别已写入工具与 Skill。
- format=outline 只给章节/区域元数据；format=full/raw 为显式完整输出，不受默认预算限制。DSH 页面渲染和加入会话明确使用 full，仍保留左右布局与完整内容。预览、回执、children/attachments 不属于此轮默认预算改造范围。
- 构建、TypeScript 检查通过；40 项测试全部通过，包括 12 项新增读取测试。覆盖 JSON 字节预算、中文/emoji 续读、字面匹配与偏移、批次分页、重复页、部分失败、缓存与写后失效、搜索条件、严格 JSON、CLI 参数，以及实际 MCP 调用。
- 三个 Skills 均通过 quick_validate.py。三个客户端目录共 9 份 Skill 与包内源文件逐字一致；三个已安装 query 脚本入口都实际完成本地 grep。
- 标准 MCP 客户端发现 scan 参数并读取真实快照成功；握手版本 0.2.0。DSH desktop 已安装的 junction 指向本项目，包版本 0.2.0；用户宿主未被终止或重启，需重载插件/正常重启后加载新版。已运行的 MCP 进程也需重连。
- 真实 Confluence 页面写入次数为 0。业务正文仅保存在用户数据目录快照，未加入仓库、测试或发布包。

## 产物与清理

正式产物是源码、dist、0.2.0 发布包、更新后的 Skills 与本文档；用户数据下的 snapshots/read-cache/scans 保留供后续读取复用。

所有验证命令均受 Windows Job Object 与超时管理，退出后活动进程数为 0。本轮临时脚本与基准摘要位于 `.task-temp/read-efficiency-20261030`，归档上述脱敏记录后删除。首版留下的旧临时文件未混入本轮清理，其此前审核阻止清理的情况见 [首版记录](verification.md)。

参考：[Confluence Server 7.19 REST](https://docs.atlassian.com/ConfluenceServer/rest/7.19.0/)、[Confluence 搜索语法](https://confluence.atlassian.com/doc/confluence-search-syntax-158720.html)。
