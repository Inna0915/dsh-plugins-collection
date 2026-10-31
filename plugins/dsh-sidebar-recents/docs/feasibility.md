# Feasibility and minimal compatibility layer

Scope: actual DSH Desktop runtime **0.2.1-rc.3** at `C:/Users/OMEN/AppData/Local/Programs/DeepSeek Harness`. All source locations below are inside the read-only `resources/app.asar`; no installed file was modified.

## Supported seams used

| Need | Actual API | Source |
| --- | --- | --- |
| Add a recents section below the workspace browser | `sidebar.footer.action` root-scoped **list** | `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js:643`, rendered at `:513-518` |
| Read the session catalog without retaining sessions or reading history | `ctx.get("sessions").list` snapshot (`ids`, `byId`) | `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js:140-167` |
| Host-native recency | `updatedAt = max(createdAt, lastPromptAt)`; `lastPromptAt` advances only for `user/message` with `source.kind === "user"` | `@deepseek-ai/dsh-api-session-controller/lib/types/list.js:29-36,316-317` |
| Visibility semantics | archived set, blank exclusion, `origin === "subagent"` exclusion | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:918-972`; `@deepseek-ai/dsh-api-workspace-controller/lib/types/client/model.js:10-11,266-267` |
| Open an existing session in the main panel | `uiWorkspace.openSession(id)` → `replaceMain(id, ..., "reveal")` | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1471-1473,1652-1666` |
| Collapse every workspace folder | `uiWorkspace.view.setGroupExpanded(key, false)`; keys are each `workspaceId` and `""` for Ungrouped | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1284-1286,5025-5039` |
| Slot DOM anchor for the bounded adapter | `SlotOutlet` adds `data-slot="<key>"` with `display: contents` | `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1117-1127` |

## Public-API gap

`sidebar.workspaces` is declared `kind: "single"` (`ui-sidebar/lib/client.js:635`) and ui-workspace registers the only occupant (`ui-workspace/lib/client.js:5221-5252`). The package exports only `apply`/`inject`; `WorkspaceBrowser`, `SessionTree`, and the view store are not exported. There is no additive child slot inside the browser.

The native browser has a **per-Workspace Session watermark** of 5 (`ui-workspace/lib/client.js:2805-2820`) and a Session “show more” control (`:3310-3327`), but **no watermark for top-level Workspace groups**. The official view store exposes grouping, ordering, archived filter, per-group expansion, and manual order — not group visibility.

Replacing the single slot would require reimplementing the native browser, its child slots (session menu, row actions, directory flow), locale seat, hooks, and drag/drop. That violates the “preserve existing sidebar actions” constraint and is not justified.

## Minimal adapter implemented

Only two behaviors use a DOM seam:

1. **Five top-level Workspace groups.** The adapter finds `[data-slot="sidebar.workspaces"]`, then the native `[role="tree"]`, and takes only **direct children** that have a direct `data-row-key="workspace:*"` row. Nested tree descendants are not counted. Groups at index ≥ limit get `data-dsr-hidden` and `aria-hidden="true"`; nothing is removed or reordered. The pager control is React-owned in the footer action.
2. **“收起所有文件夹” header button.** The adapter inserts one 24 px button immediately before the native header search slot, with `aria-label`/`title="收起所有文件夹"`. Clicking it calls the official `setGroupExpanded(key, false)` for every Workspace key plus `""`. If that service property is absent in a future build, it falls back to clicking native expanded `role="treeitem"` disclosure rows; it never calls a synthetic route or store write outside the official action.

Safety properties:

- One `MutationObserver` rooted at the `sidebar.workspaces` slot; child list + subtree only. No observer on `document.body`, no React Fiber traversal, no polling, no timers.
- Version gate: the adapter does nothing unless both the native `[role="tree"]` and the wide header `input[type="text"]` exist. A future incompatible composition keeps the native UI and the recents panel.
- Search: if the native search input has a non-empty value, all hidden attributes are removed and the group pager is hidden. Native search results are never truncated.
- Cleanup: every injected node/attribute is removed on `detach`/`dispose`; the observer and input listener are disconnected. The host DOM owns everything else.
- Workspace expansion state remains in the host’s persisted `dsh.workspace.view.v5` store; the plugin does not persist its own visibility limit. The limit resets to 5 on reload.
- The recents panel itself uses only the supported `sidebar.footer.action` list and service reads; no DOM seam is involved in opening a session.

## Compatibility range

Tested against **0.2.1-rc.3** (Desktop bundled runtime). The package declares `engines.dsh: "0.2.1-rc.3"`. A future Desktop version should re-run the source-location checks above; the version gate makes the workspace-group limit and header button inert rather than destructive if the DOM contract changes. Recents and navigation remain supported through services.

## Things intentionally not used

- No React Fiber, no `__reactFiber`, no internal component imports, no app.asar edits, no official `node_modules` edits.
- No whole-sidebar replacement, no new session creation, no hand-built conversation routes.
- No file mtime/read-time sorting, no session history retention, no chat log scanning.
# 0.1.5 实时状态补充

已读取本机 Desktop 0.2.1-rc.3 app.asar 中的 ui-session/ui-workspace client 源码：uiSession.sessionStatus 提供 getSnapshot/subscribe，快照为 Session ID 到 running/pendingInteraction/completionUnread 的 Map，由 api-session/status 事件同步。原生行使用 status.running ?? summary.running；子任务从 list.projectionsBySession[id].values.subagentCatalog 汇总。StateDot 以 ongoing/warning 表达运行/等待。本插件复用这些接口和组件；其模块已由原生工作区加载，构建将 @deepseek-ai/dsh-client-ui-primitives 保持外部引用。

工作区路径祖先关系沿用原生 folderPath 的 Windows 分隔符规范化和大小写敏感比较，并匹配完整路径分段。工作区状态聚合不依赖已展开的 DOM 子行，因此文件夹收起时也正确。

# 0.1.6 多项置顶补充

已核对 Desktop 0.2.1-rc.3 实际 client 源码：uiWorkspace.pinSession 调用 workspaces.pinSession 并同步原生手动排序；unpinSession 调用同名工作区控制器方法；workspaces.list 含宿主持久化 pinnedSessionIds。最近区直接复用这套状态，不另建会话置顶副本。

工作区原生没有文件夹置顶字段，插件使用 createSnapshotStore(initial, { persist: { name } }) 的持久化接口，原生当前会话选择也使用该形式。键为 dsh-sidebar-recents.workspace-pins.v1。视觉置顶用同级 flex order，保留 React 节点顺序和父子关系；原生 DOM/Tab 顺序仍由宿主控制。卸载恢复所有自有布局属性和容器，不回写/覆盖宿主文件夹顺序。

