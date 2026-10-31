# DSH 插件与 Skill 合集

DSH Desktop 定制插件和配套 agent skill 的唯一源码仓库。

## 目录

| 目录 | 内容 | 原位置（现为指向本仓库的 junction） |
|---|---|---|
| `plugins/jira-flow` | 任务看板 dsh-jira-flow，含 jira-* skill | `D:/dev/vscode/jira-flow` |
| `plugins/confluence-flow` | Confluence 文档 dsh-confluence-flow，含 confluence-* skill | `D:/dev/vscode/confluence-flow` |
| `plugins/dsh-project-package` | 项目打包 | `~/Documents/助手/dsh-project-package` |
| `plugins/dsh-sidebar-recents` | 最近会话与工作区折叠 | `~/Documents/助手/dsh-sidebar-recents` |
| `plugins/codex-monitor` | 会话看板 | `~/.dsh/local-plugins/20260930/codex-monitor` |
| `plugins/meal-panel` | 饭否午晚 | `~/.dsh/local-plugins/meal-panel` |
| `skills/jira-create` | 本地定制版（默认 Story，禁止 Task） | `~/.agents/skills/jira-create` |
| `skills/jira-personal-report` | 个人周报/月报 | `~/.agents/skills/jira-personal-report` |
| `skills/codex-worker` | 委派 Codex CLI | `~/.claude/skills/codex-worker` |
| `skills/dsh-worker` | 委派 DSH CLI | `~/.claude/skills/dsh-worker` |
| `skills/kimi-worker` | 委派 Kimi Code CLI | `~/.claude/skills/kimi-worker` |

jira-flow、confluence-flow 保留了迁入前的 git 历史（subtree 合并）。

## 链接

DSH profile、MCP 注册、`~/.jira-flow/installation.json` 等仍使用原路径，原路径是指向本仓库的 junction，所以宿主配置无需改动。
`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 下的 skill junction 直接指向本仓库。

完整映射见 `scripts/links.json`。检查或补建链接：

```powershell
pwsh -NoProfile -File scripts/Sync-Links.ps1          # 只检查
pwsh -NoProfile -File scripts/Sync-Links.ps1 -Apply   # 修正指向错误或缺失的 junction
```

脚本只创建或重建 junction，遇到同名真实目录会报告冲突并跳过，不会删除任何内容。

## 安装方式

- jira-flow、confluence-flow、codex-monitor、meal-panel：DSH 直接从本仓库工作区加载，改动 dist 或源码会影响正在运行的宿主。
- dsh-project-package、dsh-sidebar-recents：通过各自的 `scripts/install-local.ps1` 复制到 `~/.dsh/local-plugins` 安装，改源码后需重新安装。

构建和测试按各插件目录内的 README / AGENTS.md 执行。
