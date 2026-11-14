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
| `skills/jira-create` | 本地定制版（默认 Story，禁止 Task；创建后默认待办） | `~/.agents/skills/jira-create` |
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

## Desktop 升级兼容检查

2026-11-14 已适配 Desktop **0.2.2-rc.3**：项目打包升级至 **0.1.8**，最近会话升级至 **0.1.9**，见 [rc.3 兼容记录](docs/compatibility-2026-11-14.md)。rc.3 起官方包为压缩产物，检查脚本的接口特征比对已改为忽略空白与引号风格。

2026-11-05 已适配 Desktop **0.2.2-rc.1**：项目打包升级至 **0.1.7**，最近会话升级至 **0.1.8**，修复旧版本声明导致宿主跳过加载的问题。六个插件的核查及验收结果见 [兼容验证记录](docs/compatibility-2026-11-05.md)。

```powershell
pwsh -NoProfile -File scripts/Check-DshCompatibility.ps1
```

该命令在 30 秒进程树时限内读取实际安装的 Desktop ASAR，调用官方版本准入检查并核对插件依赖的接口特征，不启动插件、不使用版本豁免。它会在版本声明或接口特征不匹配时失败，不能代替界面和业务测试。测试会话看板时使用 Desktop 自带的 Node 24；系统 Node 20 缺少 `node:sqlite`。

启动时已被跳过的插件，修复安装后可能需要重新启动 DSH 才会加载；安装成功不等于当前宿主已经激活。可核对安装目录的 `runtime-status.json` 中版本、当前宿主 PID 和 `active`，再验收界面。
