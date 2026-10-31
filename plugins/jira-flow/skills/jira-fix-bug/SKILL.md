---
name: jira-fix-bug
description: 根据 Jira Bug 或图文任务包复现、定位、修复问题并做回归验证，输出可供看板导入的逐条结果。
---

读取用户提供的任务包，或用 `jira_flow` 读取 Bug。CLI 可在本 Skill 目录运行 `node scripts/run.mjs issue PROJ-123`，再用 `export PROJ-123 --attachments images` 获取图片。不要为离线执行索要 Jira 凭证。

先提取复现步骤、环境、错误截图、实际与预期结果。用当前 agent 的图片工具读取截图；无法读取时说明，不推测图中的错误。

在指定代码目录遵守 AGENTS.md，定位根因、修复并验证。优先选择能区分修复前后的回归检查；不能复现时如实说明证据边界。多任务按依赖关系处理，避免同时修改同一逻辑互相覆盖。

报告根因、修复内容、验证结果与剩余问题。若输入是任务包，按 index.md 输出 results.json；`verification` 不得把未运行的检查标为通过。

用户要求回写时刷新 Jira 后选择合法状态，例如待验证；不要因为 agent 一轮结束就自动关闭 Bug。已有授权的步骤直接执行，缺少必要业务输入时再补充。
