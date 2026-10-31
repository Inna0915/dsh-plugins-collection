---
name: jira-export
description: 将一条或多条 Jira 任务导出为完整 Markdown 和含图片的任务包，以便其他 agent 在没有 Jira 凭证时执行。
---

优先调用 `jira_flow` 的 `export`；无工具时在本 Skill 目录运行 `node scripts/run.mjs export PROJ-123 PROJ-124 --output <绝对目录> --attachments images`。使用 `--zip` 生成可上传包，`--no-comments` 排除评论，`--attachments all` 包含非图片附件。

工具参数示例：`{ "operation":"export", "profile":"work-jira", "keys":["PROJ-123"], "outputDir":"<可访问目录>", "attachments":"images" }`。

读取返回的 `errors`、`assets[].status` 和 `instruction`。报告成功任务与失败资源，不把部分成功说成完整导出。任务包包括索引、逐条任务、附件、快照时间、combined.md 和结果约定。

本机接收方需能读取索引绝对路径；远端或沙箱接收方需要实际上传文件。普通 Markdown 剪贴板只包含图片引用。不得把认证 URL、请求头或凭证加进任务包。

用户要求复制完整内容时可读取 combined.md；需要执行时提供生成的执行指令。导出不会修改 Jira 或自动启动其他 agent。
