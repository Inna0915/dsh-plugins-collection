# Progress

Date: 2026-10-27 (local). Implementer: DSH. Planner/acceptance: Codex.

## Phase A — runtime API verification (complete)

- Desktop install: `C:/Users/OMEN/AppData/Local/Programs/DeepSeek Harness` (read-only).
- Desktop runtime version from `resources/app.asar` → `dsh/package.json`: **0.2.1-rc.3**. The system npm `@deepseek-ai/dsh` 0.2.1-rc.2 is not the Desktop runtime.
- Verified `sidebar.footer.action` is a root-scoped list (`ui-sidebar/lib/client.js:643`), rendered below `sidebar.workspaces` and above settings.
- Verified `sidebar.workspaces` is a **single** slot owned by ui-workspace (`ui-sidebar/lib/client.js:635`, `ui-workspace/lib/client.js:5221`); no additive child slot and no exported browser component.
- Verified host recency field: `ClientSessions.list` `updatedAt = max(createdAt, lastPromptAt)` (`session-controller/lib/types/list.js:316-317`); `lastPromptAt` advances only on `user/message` with `source.kind === "user"` (`:29-36`). No file mtime / read time / assistant stream tokens.
- Verified native exclusions: `origin === "subagent"`, archived, and blank rows (`ui-workspace/lib/client.js:964-972`).
- Verified open-session service: `uiWorkspace.openSession(id)` → `replaceMain(id, ..., "reveal")` (`ui-workspace/lib/client.js:1471-1473`).
- Verified expansion store/action: `setGroupExpanded(key, expanded)` (`ui-workspace/lib/client.js:1284`, `5025-5039`); keys are `workspaceId` plus `""` for Ungrouped.
- Verified native session watermark is 5 per Workspace (`ui-workspace/lib/client.js:2805`), but there is **no workspace-group watermark**. This is the one public-API gap.

## Phase B — implementation (complete, built)

- `src/core/recents.js`: recents projection, stable sort, exclusions, dedupe, 5-row pagination.
- `src/core/workspaces.js`: group keys for collapse-all and top-level tree helpers.
- `src/client/chrome.js`: bounded, reversible workspace-chrome adapter. Five top-level groups by default; header “收起所有文件夹” button; search bypass; cleanup; version gate. One MutationObserver scoped to `[data-slot="sidebar.workspaces"]`; no React Fiber, no timers, no polling.
- `src/client/recents-panel.js`: `sidebar.footer.action` React panel; 5-item pages, expand/collapse, duplicate-title workspace hints, keyboard navigation, current highlight, host recency only.
- `src/client/navigation.js`: exact-id `uiWorkspace.openSession()` only.
- `src/client/styles.js`: host-variable styling; light/dark compatible; long titles ellipsis.
- `src/plugin.js`, `cordis.patch.yml`, `package.json`, `scripts/build.mjs`, `scripts/run-bounded.ps1`, tests, README/docs.

## Verification completed

- Bounded unit + DOM test suite: **13/13 pass**, exit 0 (120 s timeout; owned process tree cleanup 0).
- Bounded build: exit 0; `dist/plugin.js` 85 B, `dist/client.js` 26,959 B wrapper.
- Bounded dist load/apply check: exit 0; registers `sidebar.footer.action/sidebar-recents` once per apply; cleanup exercised.
- `npm install` and `npm pack` are blocked by the DSH sandbox writing the user npm cache (`EPERM`). Build/test used read-only reference esbuild/linkedom binaries via environment variables; the shipped dist and package are complete. This is an environment limitation, not a code failure.

## Installation

Not executed. The Desktop profile has `dsh-hmr` enabled, but this session could not use the supported Plugin Manager operation to add and select a local bundle, and manually editing live profile config was not authorized by the task constraints. The install/uninstall plan is in `README.md`; the built tgz is ready for Codex’s independent installation and UI acceptance.

## Real UI acceptance still required

Five top-level groups / more / collapse; recents order and refresh; open from hidden workspace; collapse-all incl. nested/hidden folders; search no truncation; light/dark/narrow; rename/new message/archive/delete; keyboard; disable/uninstall cleanup.
