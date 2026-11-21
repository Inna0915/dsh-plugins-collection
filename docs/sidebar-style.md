# 左栏样式约定

本仓库的插件往 DSH 左栏放东西时（`sidebar.footer.action` 入口、最近会话列表等），都用同一份样式：**`shared/sidebar.css`**。

## 怎么改、怎么同步

1. 只改 `shared/sidebar.css`。
2. 运行 `node scripts/sync-sidebar-style.mjs`。它把这份样式（去注释、压成一行）写进每个插件源码里的 `/* @sidebar-style */ "…" /* @sidebar-style-end */` 处。每个插件自带一份副本，卸掉其中一个不影响其他插件。
3. 需要构建的插件重新构建（dsh-project-package、dsh-sidebar-recents、jira-flow）；复制安装的两个（项目打包、最近会话）把 `dist/client.js` 复制到 `~/.dsh/local-plugins/<插件>/dist/`。重启 Desktop。
4. `node scripts/sync-sidebar-style.mjs --check` 检查各插件是否都已同步。

使用这份样式的插件：dsh-project-package、codex-monitor、jira-flow、dsh-vibe-reader、meal-panel、dsh-sidebar-recents（清单在同步脚本的 `CONSUMERS` 里）。

## 对齐谁

Desktop 装了 `@iroha1145/dsh-modern-ui`。它停用了官方的布局、侧栏、工作区、对话等界面组件，左栏骨架（全局面板、新会话、插件、工作区列表）都是它画的。所以左栏以 modern-ui 为准，官方变量只作后备，例如：

```css
color: var(--ink-2, var(--dsw-alias-label-secondary));
```

modern-ui 的变量（`--ink`、`--ink-2`、`--ink-3`、`--hover`、`--accent-tint`、`--primary`、`--line-soft`、`--fs-*`）定义在 `body` 上，不是公开接口。`scripts/check-dsh-compatibility.cjs` 会核对这些变量和下面的几何数值在当前安装的 modern-ui 里是否还在；变了就报错，提示改 `shared/sidebar.css` 再同步。

## 几何（内容区左缘记为 0）

| 位置 | 数值 | 变量 |
|---|---|---|
| 分组标题文字（全局面板、工作区、最近） | +10 | `--dshx-label-inset` |
| 行内容：图标框，或没有图标的文字（最近会话标题、展开更多） | +12 | `--dshx-row-inset` |
| 底部入口区自带的内边距（入口的左右内边距 = 12 − 2） | 2 | `--dshx-footer-inset` |
| 图标框（内放 16px 线性 SVG） | 18px | `--dshx-icon-box` |
| 图标与文字的间距（文字因此在 +40） | 10px | `--dshx-icon-gap` |
| 行高 | 38px | `--dshx-row-height` |
| 收起成图标条时的入口 | 36×36 | `--dshx-rail-size` |

## 类

- `.dshx-entry`：底部入口，等同宿主的导航行。14px、500 字重、`--ink-2`；悬停 `--hover` 底、`--ink` 字；对应主面板打开时加 `aria-current="page"`，显示 `--accent-tint` 底、`--primary` 字。收起时加 `.dshx-rail`。
- `.dshx-entry-icon`：18px 图标框，里面放 16px、描边 1.5～1.6、`currentColor` 的 SVG；不要用文字符号作图标。
- `.dshx-entry-label`：名称，超长省略。入口名称统一四个字（项目打包、会话看板、任务看板、闲庭信步、饭否午晚）。

入口组件从 slot 的 props 里取 `usePanelInfo`，判断 `activePanelId` 是不是自己的主面板，用来设置 `aria-current`。

## 文字色

| 级别 | 变量 | 后备 | 浅色参考 | 用在 |
|---|---|---|---|---|
| 主 | `--ink` | `--dsw-alias-label-primary` | #171717 | 悬停、聚焦时的文字 |
| 次 | `--ink-2` | `--dsw-alias-label-secondary` | #5b5b5b | 导航行、入口、会话行的常态文字 |
| 辅 | `--ink-3` | `--dsw-alias-label-tertiary` | #6a6a6a | 分组标题、时间、计数、「展开更多」、图钉 |
| 强调 | `--primary` | `--dsw-alias-state-business-primary` | #1f5fae | 当前会话、当前面板 |

## 不在这页范围

右侧栏、各插件的主页面（会话看板、任务看板、闲庭信步阅读等）、中间对话区，暂不统一。
