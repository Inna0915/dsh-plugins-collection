# Agent 标识

这些图标复制自本机已安装的官方客户端，仅用于标识会话来源；品牌及图标权利归各自所有者。未使用 AI 重绘，也不通过网络加载。

| 文件 | 原始资源 |
| --- | --- |
| codex.png | OpenAI Codex VS Code 扩展 26.1021.22027：webview/assets/codex-app-ga-logo-3e5209898ca3.png |
| dsh.svg | DeepSeek Harness app.asar：dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg |
| kimi.png | Moonshot 官方 Kimi Code VS Code 扩展 0.8.3：dist/kimi-logo.png |
| claude.svg | Anthropic 官方 Claude Code VS Code 扩展 2.1.310：resources/claude-logo.svg |
| agy.png | Google 官方 Google Antigravity VS Code 扩展 1.12.0：img/logo.png |

client.js 的 AGENT_LOGOS 将上述文件按原始字节编码为 data URI，避免增加后端静态路由或修改插件清单。更换图标时需要同步重新编码对应值。卡片依据 session.provider / sessionId 选择标识，与使用的模型、标题文字无关。
