---
name: jira-weekly-report
description: 查询 Jira 历史形成可追溯的周报，分别统计开发里程碑、业务最终状态、重开及当前在途；也可汇总已有任务包中的有限范围。
---

在线使用 `jira_flow` 的 `weekly`；CLI 在本 Skill 目录运行 `node scripts/run.mjs weekly --format markdown`。默认 Asia/Shanghai 本周一至下周一，结束时刻不包含在范围内。可用 `--start <带时区的ISO时间> --end <带时区的ISO时间>` 指定区间，`--jql <范围>` 明确候选范围。

开发里程碑按状态名识别：内置 Executed、Build Done、Validating，其余由连接的 `developmentStatuses` 配置。Bug 修复若流转到「In Review」等自定义状态，要先加入该配置，否则 Bug 修复不会计入开发里程碑。

先读取结构化计数、事件、查询范围、数据时间与 `complete/incomplete`。数字来自工具，不让模型自行猜测完成时间；Jira `updated` 不是完成日期。开发里程碑与业务最终状态分别呈现。同一任务的重复完成不重复计任务数，重开单列。

检查解决结果，取消、重复、拒绝等不能直接包装成交付成果。当前经办人、报告人和转换操作者并不自动等同唯一贡献者，归属需要保留依据。历史接口缺失、分页截断或失败必须写进数据说明。

将事实清单组织为本周成果、Story/Bug 分类、待验证与阻塞、下周计划，并保留 Jira 链接。计划和建议不要写成已发生事实。

只有离线包时，汇总包内的任务和执行结果，并明确这是该批任务快照的摘要；没有历史证据时不宣称完整周报。没有用户要求时不自动发布或发送给他人。
