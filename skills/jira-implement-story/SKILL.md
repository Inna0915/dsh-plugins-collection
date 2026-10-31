---
name: jira-implement-story
description: 按 Jira Story 的正文、图片和验收标准实施代码变更、验证并登记结果；支持不联网的 Jira Flow 任务包。
---

从用户指定的 Jira 编号或任务包开始。在线入口是 `jira_flow` 工具；CLI 入口是在本 Skill 目录运行 `node scripts/run.mjs issue PROJ-123` 或 `export PROJ-123 --attachments images`。不需要为离线任务包配置 Jira 凭证。

读取描述、验收条件、有关评论和图片，遵守目标代码目录中的 AGENTS.md。确认实现范围，复用现有业务入口。缺少验收标准时说明采用的假设，不将推测写成 Jira 已确认要求。

实现并运行与变更相称的验证。测试有超时，结束时清理该测试的进程树和临时产物，不终止无关服务。记录变更摘要、验证命令与结果、产物、剩余问题。

任务包执行结果遵守 index.md 的 results.json 约定：`schemaVersion:1`、`packageId`、`results`，每条包含 `key`、`summary`、`verification`、`artifacts`、`remaining`、原快照 `expectedUpdated`。

有明确更新 Jira 的指令时，先刷新任务及合法流转，使用共享工具写回。仅完成代码不等于业务已验收；没有写回指令时交付结果，由看板导入处理。
