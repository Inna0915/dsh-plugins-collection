window.__ModuleLoader__.load({
  id: "codex-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const VERSION = "0.6.0";
    const MAIN_PANEL_ID = "codex-monitor";
    const RUNNING_TAB_ID = "codex-monitor/running";
    const RUNNING_TAB_KIND = "codex-monitor-running";
    const RUNNING_TAB_LABEL = "运行中的会话";
    const MonitorIcon = primitives.IconChecklistOutlineRegular || primitives.IconChecklistOutline14;
    const RefreshIcon = primitives.IconRefreshOutlineRegular || primitives.IconRefreshOutline16;
    const SearchIcon = primitives.IconSearchOutlineRegular || primitives.IconSearchOutline16;
    const CloseIcon = primitives.IconCloseOutlineRegular || primitives.IconCloseOutline16;

    const POLL_MS = 5000;
    const REFRESH_POLL_MS = 200;
    const REQUEST_TIMEOUT_MS = 15000;
    const COLUMNS = [
      { key: "running", label: "运行中", tone: "running", description: "当前轮次正在执行" },
      { key: "turn_completed", label: "待审核", tone: "completed", description: "已记录且当前轮次结束" },
      { key: "record", label: "记录", tone: "record", description: "未记录运行过程或状态异常" }
    ];

    const CSS = ''
      + '.cdm-trigger{box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;flex:0 0 36px;width:100%;min-width:0;height:36px;min-height:36px;margin:0;padding:7px 10px;color:var(--dsw-alias-label-primary,#222);background:transparent;border:0;border-radius:var(--dsw-radius-md,8px);font-family:inherit;font-size:14px;font-weight:400;line-height:22px;text-align:left;overflow:hidden}.cdm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.cdm-trigger.cdm-rail{width:36px;height:36px;min-height:36px;flex:0 0 36px;align-self:center;justify-content:center;gap:0;margin:0;padding:0;border-radius:var(--dsw-radius-md,8px)}.cdm-trigger>svg{flex:none;width:16px;height:16px}.cdm-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}[data-slot="sidebar.footer.action"]:has(> .cdm-trigger){display:flex!important;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:2px;width:100%;min-width:0}.cdm-triggerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.cdm-panel{box-sizing:border-box;flex:1;align-self:stretch;width:100%;height:100%;min-width:0;min-height:0;max-width:100%;max-height:100%;display:flex;flex-direction:column;position:relative;isolation:isolate;container-type:inline-size;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2329)}'
      + '.cdm-sourceWarning{color:var(--dsw-alias-warning-fg-1,#b7791f)}.cdm-head{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:12px;min-height:58px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.2))}.cdm-heading{min-width:0;display:flex;align-items:center;gap:10px}.cdm-title{margin:0;font-size:16px;line-height:24px;font-weight:600;letter-spacing:0}.cdm-badge{color:var(--dsw-alias-label-secondary,#555);border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.25));border-radius:8px;padding:1px 8px;font-size:12px;line-height:18px;white-space:nowrap}.cdm-subtitle{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;line-height:18px;white-space:nowrap}.cdm-actions{margin-left:auto;display:flex;flex-wrap:wrap;max-width:100%;align-items:center;gap:8px;min-width:0}'
      + '.cdm-search{box-sizing:border-box;width:min(260px,24vw);height:32px;display:flex;align-items:center;gap:7px;padding:0 9px;color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.28));border-radius:6px}.cdm-search input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:13px;letter-spacing:0}.cdm-search input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}'
      + '.cdm-select{box-sizing:border-box;height:32px;max-width:150px;padding:0 26px 0 9px;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.28));border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;color-scheme:light dark}.cdm-iconBtn{box-sizing:border-box;width:32px;height:32px;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer}.cdm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#222)}.cdm-iconBtn:disabled{opacity:.45;cursor:not-allowed}.cdm-iconBtn.cdm-close{margin-left:2px;border-color:transparent}.cdm-iconBtn.cdm-refreshed{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}.cdm-refreshGlyph{display:block;line-height:1;transform-origin:center}.cdm-refreshGlyph.cdm-spin{animation:cdm-spin 900ms linear infinite}@keyframes cdm-spin{to{transform:rotate(360deg)}}'
      + '.cdm-notificationSettings{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.14));font-size:12px}.cdm-notificationSettings label{display:flex;align-items:center;gap:4px}.cdm-notificationSettings .cdm-select{max-width:320px}.cdm-meta{flex:none;min-height:34px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:5px 14px;color:var(--dsw-alias-label-tertiary,#777);font-size:11px;line-height:18px;border-bottom:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.14))}.cdm-health{display:flex;align-items:center;gap:6px}.cdm-healthDot{width:7px;height:7px;border-radius:50%;background:#38a169}.cdm-healthDot.cdm-degraded{background:#d69e2e}.cdm-metaError{margin-left:auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-warning-fg-1,#b7791f)}'
      + '.cdm-board{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(230px,1fr));gap:12px;padding:12px 14px 14px;overflow-x:auto}.cdm-lane{min-width:230px;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07));border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.17));border-radius:8px;overflow:hidden}.cdm-laneHead{flex:none;display:flex;align-items:center;gap:8px;padding:10px 11px;border-top:3px solid var(--lane-color)}.cdm-laneTitle{font-size:13px;line-height:20px;font-weight:600;letter-spacing:0}.cdm-laneCount{min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));font-size:11px;line-height:20px}.cdm-laneHint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#777);font-size:10px;line-height:16px;white-space:nowrap}.cdm-running{--lane-color:#2f9e68}.cdm-completed{--lane-color:#3f7fd8}.cdm-record{--lane-color:#8a9099}'
      + '.cdm-laneBody{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:0 9px 10px;overflow-y:auto;scrollbar-gutter:stable}.cdm-empty{padding:16px 4px;color:var(--dsw-alias-label-tertiary,#777);font-size:12px;line-height:18px;text-align:center}.cdm-card{box-sizing:border-box;flex:none;padding:10px 10px 9px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.22));border-left:3px solid var(--lane-color);border-radius:6px}.cdm-cardTitle{font-size:13px;line-height:19px;font-weight:600;letter-spacing:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;word-break:break-word}.cdm-cardTitleError{color:var(--dsw-alias-warning-fg-1,#b7791f)}.cdm-path{margin-top:5px;color:var(--dsw-alias-label-secondary,#555);font-size:11px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cdm-cardMeta{margin-top:7px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#777);font-size:10px;line-height:16px}.cdm-chip{max-width:150px;padding:0 6px;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.26));border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cdm-reason{margin-top:7px;padding-top:7px;border-top:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,#777);font-size:10px;line-height:16px;display:flex;justify-content:space-between;gap:8px}.cdm-reasonText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cdm-time{flex:none;white-space:nowrap}.cdm-cardActions{margin-top:8px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.cdm-reviewBtn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:11px;cursor:pointer}.cdm-reviewBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}.cdm-reviewBtn:disabled{opacity:.45;cursor:not-allowed}'
      + '.cdm-card{padding:12px;border-radius:9px}.cdm-cardIdentity{display:flex;align-items:center;gap:9px;min-width:0;margin-bottom:10px}.cdm-agentLogo{box-sizing:border-box;flex:none;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;background:#fff;border:1px solid rgba(127,127,127,.16);overflow:hidden}.cdm-agentLogo img{display:block;width:28px;height:28px;object-fit:contain}.cdm-agentLogo-kimi img{width:34px;height:34px}.cdm-agentLogo-claude{background:#fff8f2}.cdm-agentLogo-dsh{background:#f1f5ff}.cdm-agentText{flex:1;min-width:0}.cdm-agentName{font-size:13px;line-height:18px;font-weight:650;letter-spacing:.1px}.cdm-agentClient{color:var(--dsw-alias-label-secondary,#666);font-size:10px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cdm-cardStatus{flex:none;display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.18));border-radius:20px;color:var(--dsw-alias-label-secondary,#666);font-size:10px;line-height:16px;white-space:nowrap}.cdm-cardStatus::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--lane-color,#8a9099)}.cdm-cardTitle{font-size:14px;line-height:21px}.cdm-cardMeta{gap:5px}.cdm-chip{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));border-color:transparent}.cdm-cardActions{justify-content:space-between}.cdm-cardActions .cdm-reviewBtn:first-child{color:var(--dsw-alias-label-secondary,#666)}'
      + '.cdm-loading,.cdm-fatal{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;color:var(--dsw-alias-label-tertiary,#777);font-size:13px}.cdm-fatal{flex-direction:column;gap:10px}.cdm-retry{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer}'
      + '@container(max-width:860px){.cdm-head{align-items:flex-start;flex-wrap:wrap}.cdm-heading{width:100%}.cdm-subtitle{white-space:normal}.cdm-actions{width:100%;margin-left:0}.cdm-search{flex:1;min-width:140px;width:auto}.cdm-select{max-width:120px}.cdm-board{grid-template-columns:repeat(3,minmax(min(82cqw,360px),1fr));padding:10px}.cdm-meta{flex-wrap:wrap}.cdm-metaError{margin-left:0;max-width:100%;width:100%}}'
      + '@media(prefers-reduced-motion:reduce){.cdm-spin{animation:none}}';

    function formatTime(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      const pad = (n) => String(n).padStart(2, "0");
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    function formatTokenCount(value) {
      if (value === null || value === undefined || value === '') return null;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) return null;
      const compact = (divisor, suffix) => (numeric / divisor).toFixed(1).replace(/\.0$/, "") + suffix;
      if (numeric >= 1000000) return compact(1000000, "M") + " tokens";
      if (numeric >= 1000) return compact(1000, "K") + " tokens";
      return Math.round(numeric) + " tokens";
    }

    function formatContextTokenCount(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) return null;
      if (numeric >= 1000000) return (numeric / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (numeric >= 1000) return Math.round(numeric / 1000) + "K";
      return String(Math.round(numeric));
    }

    function formatContextUsage(session) {
      if (session.contextUsedTokens === null || session.contextUsedTokens === undefined) return "Context unknown";
      const used = Number(session.contextUsedTokens);
      const windowSize = Number(session.contextWindowTokens);
      if (!Number.isFinite(used) || used < 0) return "Context unknown";
      if (!Number.isFinite(windowSize) || windowSize <= 0) return "Context " + formatContextTokenCount(used) + " / 窗口未知";
      const percent = Math.round(used / windowSize * 100);
      return "Context " + formatContextTokenCount(used) + " / " + formatContextTokenCount(windowSize) + " · " + percent + "%";
    }

    function contextUsageTitle(session) {
      if (session.contextUsedTokens === null || session.contextUsedTokens === undefined) return "未找到最近一次请求的上下文用量";
      const used = Number(session.contextUsedTokens);
      const windowSize = Number(session.contextWindowTokens);
      if (!Number.isFinite(used) || used < 0) return "未找到最近一次请求的上下文用量";
      if (!Number.isFinite(windowSize) || windowSize <= 0) return "最近一次请求输入 " + used.toLocaleString() + " tokens；客户端未提供上下文窗口上限，无法计算占比";
      return "最近一次请求输入 " + used.toLocaleString() + " / 上下文窗口 " + windowSize.toLocaleString() + " tokens";
    }

    function clientLabel(source) {
      if (!source) return "未知来源";
      const normalized = String(source).toLowerCase();
      if (normalized === "vscode") return "Codex · VS Code";
      if (normalized === "cli") return "Codex · CLI";
      if (normalized === "app" || normalized === "codex_app") return "Codex App";
      const labels = { dsh: "DSH", "kimi-vscode": "Kimi · VS Code", "kimi-cli": "Kimi · CLI", "kimi-desktop": "Kimi · Desktop", "kimi-unknown": "Kimi · 来源未记录", "claude-vscode": "Claude · VS Code", "claude-cli": "Claude · CLI", claude: "Claude" };
      if (labels[normalized]) return labels[normalized];
      return String(source);
    }

    const PROVIDERS = { codex: "Codex", dsh: "DSH", kimi: "Kimi", claude: "Claude" };
    // Official client assets, embedded for offline rendering. See assets/agent-logos/README.md.
    const AGENT_LOGOS = {"codex":"data:image/png;base64,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","dsh":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iNTAuMDAwMDAwIiBoZWlnaHQ9IjUwLjAwMDAwMCIgdmlld0JveD0iMCAwIDUwIDUwIiBmaWxsPSJub25lIj4KCTxwYXRoIGlkPSJwYXRoIiBkPSJNNDguODM1NCAxMC4wNDc5QzQ4LjMyMzIgOS43OTE5OSA0OC4xMDI1IDEwLjI3OTggNDcuODAzMiAxMC41Mjc4QzQ3LjcwMDcgMTAuNjA3OSA0Ny42MTQzIDEwLjcxMTkgNDcuNTI3MyAxMC44MDc2QzQ2Ljc3OTMgMTEuNjI0IDQ1LjkwNDggMTIuMTU5NyA0NC43NjIyIDEyLjA5NTdDNDMuMDkyMyAxMiA0MS42NjYgMTIuNTM1NiA0MC40MDU4IDEzLjgzOThDNDAuMTM3NyAxMi4yMzE5IDM5LjI0NzYgMTEuMjcyIDM3Ljg5MjYgMTAuNjU1OEMzNy4xODM2IDEwLjMzNTkgMzYuNDY2OCAxMC4wMTU2IDM1Ljk3MDIgOS4zMTk4MkMzNS42MjM1IDguODIzNzMgMzUuNTI5MyA4LjI3MTk3IDM1LjM1NiA3LjcyNzU0QzM1LjI0NTYgNy4zOTk5IDM1LjEzNTMgNy4wNjM5NiAzNC43NjUxIDcuMDA3ODFDMzQuMzYzMyA2Ljk0Mzg1IDM0LjIwNTYgNy4yODc2IDM0LjA0NzkgNy41NzU2OEMzMy40MTggOC43NTE5NSAzMy4xNzMzIDEwLjA0NzkgMzMuMTk3MyAxMS4zNTk5QzMzLjI1MjQgMTQuMzEyIDM0LjQ3MzYgMTYuNjY0MSAzNi44OTk5IDE4LjMzNTlDMzcuMTc1OCAxOC41Mjc4IDM3LjI0NjYgMTguNzE5NyAzNy4xNTk3IDE5QzM2Ljk5NDYgMTkuNTc1NyAzNi43OTc0IDIwLjEzNTcgMzYuNjI0IDIwLjcxMTlDMzYuNTEzNyAyMS4wODAxIDM2LjM0ODYgMjEuMTU5NyAzNS45NjI0IDIxQzM0LjYzMDkgMjAuNDMyMSAzMy40ODEgMTkuNTkxOCAzMi40NjQ0IDE4LjU3NTdDMzAuNzM5MyAxNi44NzIxIDI5LjE3OTIgMTQuOTkxNyAyNy4yMzM0IDEzLjUyQzI2Ljc3NjQgMTMuMTc1OCAyNi4zMTkzIDEyLjg1NiAyNS44NDY3IDEyLjU1MThDMjMuODYxOCAxMC41ODQgMjYuMTA2OSA4Ljk2Nzc3IDI2LjYyNyA4Ljc3NTg4QzI3LjE3MDQgOC41NzU2OCAyNi44MTU5IDcuODg3NyAyNS4wNTkxIDcuODk2QzIzLjMwMjIgNy45MDM4MSAyMS42OTUzIDguNTAzOTEgMTkuNjQ3IDkuMzAzNzFDMTkuMzQ3NyA5LjQyMzgzIDE5LjAzMjIgOS41MTE3MiAxOC43MDk1IDkuNTgzOThDMTYuODUwMSA5LjIyMzYzIDE0LjkxOTkgOS4xNDM1NSAxMi45MDMzIDkuMzc1OThDOS4xMDU5NiA5LjgwNzYyIDYuMDcyNzUgMTEuNjM5NiAzLjg0MzI2IDE0Ljc2ODFDMS4xNjQ1NSAxOC41Mjc4IDAuNTM0MTggMjIuNzk5OCAxLjMwNjY0IDI3LjI1NTlDMi4xMTc2OCAzMS45NTIxIDQuNDY1ODIgMzUuODM5OCA4LjA3MzczIDM4Ljg3OTlDMTEuODE1OSA0Mi4wMzIyIDE2LjEyNTUgNDMuNTc2MiAyMS4wNDEgNDMuMjgwM0MyNC4wMjY5IDQzLjEwNCAyNy4zNTE2IDQyLjY5NjMgMzEuMTAxNiAzOS40NTYxQzMyLjA0NjkgMzkuOTM2IDMzLjAzOTYgNDAuMTI3OSAzNC42ODYgNDAuMjcyQzM1Ljk1NDYgNDAuMzkyMSAzNy4xNzU4IDQwLjIwOCAzOC4xMjExIDQwLjAwNzhDMzkuNjAyMSAzOS42ODggMzkuNDk5NSAzOC4yODgxIDM4Ljk2MzkgMzguMDMyMkMzNC42MjMgMzUuOTY3OCAzNS41NzYyIDM2LjgwODEgMzQuNzEgMzYuMTI3OUMzNi45MTU1IDMzLjQ2MzkgNDAuMjQwMiAzMC42OTU4IDQxLjU0IDIxLjcyOEM0MS42NDI2IDIxLjAxNjEgNDEuNTU1NyAyMC41Njc5IDQxLjU0IDE5Ljk5MTdDNDEuNTMyMiAxOS42Mzk2IDQxLjYxMDggMTkuNTAzOSA0Mi4wMDQ5IDE5LjQ2MzlDNDMuMDkyMyAxOS4zMzU5IDQ0LjE0NzkgMTkuMDMxNyA0NS4xMTY3IDE4LjQ4NzhDNDcuOTI5MiAxNi45MTk5IDQ5LjA2NCAxNC4zNDM4IDQ5LjMzMTUgMTEuMjU1OUM0OS4zNzExIDEwLjc4MzcgNDkuMzIzNyAxMC4yOTU5IDQ4LjgzNTQgMTAuMDQ3OVpNMjQuMzI2MiAzNy44Mzk4QzIwLjExOTYgMzQuNDYzOSAxOC4wNzkxIDMzLjM1MjEgMTcuMjM1OCAzMy4zOTk5QzE2LjQ0ODIgMzMuNDQ4MiAxNi41ODk4IDM0LjM2ODIgMTYuNzYzMiAzNC45Njc4QzE2Ljk0NDMgMzUuNTYwMSAxNy4xODEyIDM1Ljk2ODMgMTcuNTExNyAzNi40ODc4QzE3Ljc0MDIgMzYuODMyIDE3Ljg5NzkgMzcuMzQ0MiAxNy4yODMyIDM3LjcyOEMxNS45MjgyIDM4LjU4NCAxMy41NzI4IDM3LjQzOTkgMTMuNDYyNCAzNy4zODM4QzEwLjcyMDcgMzUuNzM1OCA4LjQyODIyIDMzLjU2MDEgNi44MTM0OCAzMC41ODRDNS4yNTM0MiAyNy43MTk3IDQuMzQ3NjYgMjQuNjQ3OSA0LjE5Nzc1IDIxLjM2NzdDNC4xNTgyIDIwLjU3NTcgNC4zODY3MiAyMC4yOTU5IDUuMTU4NjkgMjAuMTUxOUM2LjE3NTI5IDE5Ljk2IDcuMjIzMTQgMTkuOTE5OSA4LjIzOTI2IDIwLjA3MThDMTIuNTMyNyAyMC43MTE5IDE2LjE4ODUgMjIuNjcxOSAxOS4yNTI5IDI1Ljc3NTlDMjEuMDAyIDI3LjU0MzkgMjIuMzI1MiAyOS42NTU4IDIzLjY4ODUgMzEuNzIwMkMyNS4xMzc3IDMzLjkxMjEgMjYuNjk3OCAzNiAyOC42ODMxIDM3LjcxMTlDMjkuMzg0MyAzOC4zMTIgMjkuOTQzNCAzOC43NjgxIDMwLjQ3OSAzOS4xMDRDMjguODY0MyAzOS4yODgxIDI2LjE2OTkgMzkuMzI4MSAyNC4zMjYyIDM3LjgzOThaTTI2LjM0MzMgMjQuNjAwMUMyNi4zNDMzIDI0LjI0OCAyNi42MTkxIDIzLjk2NzggMjYuOTY1OCAyMy45Njc4QzI3LjA0NDQgMjMuOTY3OCAyNy4xMTUyIDIzLjk4MzkgMjcuMTc4MiAyNC4wMDc4QzI3LjI2NTEgMjQuMDQgMjcuMzQzOCAyNC4wODc5IDI3LjQwNjcgMjQuMTYwMkMyNy41MTcxIDI0LjI3MiAyNy41ODAxIDI0LjQzMjEgMjcuNTgwMSAyNC42MDAxQzI3LjU4MDEgMjQuOTUyMSAyNy4zMDQyIDI1LjIzMTkgMjYuOTU3NSAyNS4yMzE5QzI2LjYxMDggMjUuMjMxOSAyNi4zNDMzIDI0Ljk1MjEgMjYuMzQzMyAyNC42MDAxWk0zMi42MDY0IDI3Ljg3OTlDMzIuMjA0NiAyOC4wNDc5IDMxLjgwMjcgMjguMTkxOSAzMS40MTY1IDI4LjIwOEMzMC44MTc5IDI4LjIzOTcgMzAuMTY0MSAyNy45OTIyIDI5LjgwOTYgMjcuNjg4QzI5LjI1ODMgMjcuMjE1OCAyOC44NjQzIDI2Ljk1MjEgMjguNjk4NyAyNi4xMjc5QzI4LjYyNzkgMjUuNzc1OSAyOC42Njc1IDI1LjIzMTkgMjguNzMwNSAyNC45MTk5QzI4Ljg3MjEgMjQuMjQ4IDI4LjcxNDQgMjMuODE1OSAyOC4yNDk1IDIzLjQyMzhDMjcuODcxNiAyMy4xMDQgMjcuMzkxMSAyMy4wMTYxIDI2Ljg2MzMgMjMuMDE2MUMyNi42NjYgMjMuMDE2MSAyNi40ODQ5IDIyLjkyNzcgMjYuMzUxMSAyMi44NTZDMjYuMTMwNCAyMi43NDQxIDI1Ljk0OTIgMjIuNDYzOSAyNi4xMjI2IDIyLjEyMDFDMjYuMTc3NyAyMi4wMDc4IDI2LjQ0NTggMjEuNzM1OCAyNi41MDg4IDIxLjY4OEMyNy4yMjU2IDIxLjI3MiAyOC4wNTI3IDIxLjQwNzcgMjguODE2OSAyMS43MTk3QzI5LjUyNTkgMjIuMDE2MSAzMC4wNjE1IDIyLjU2MDEgMzAuODM0IDIzLjMyODFDMzEuNjIxNiAyNC4yNTU5IDMxLjc2MzIgMjQuNTExNyAzMi4yMTI0IDI1LjIwOEMzMi41NjY5IDI1Ljc1MiAzMi44OTAxIDI2LjMxMiAzMy4xMTA0IDI2Ljk1MjFDMzMuMjQ0NiAyNy4zNTIxIDMzLjA3MTMgMjcuNjgwMiAzMi42MDY0IDI3Ljg3OTlaIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjEuMDAwMDAwIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz4KPC9zdmc+Cg==","kimi":"data:image/png;base64,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","claude":"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkNsYXVkZTwvdGl0bGU+PHBhdGggZD0iTTQuNzA5IDE1Ljk1NWw0LjcyLTIuNjQ3LjA4LS4yMy0uMDgtLjEyOEg5LjJsLS43OS0uMDQ4LTIuNjk4LS4wNzMtMi4zMzktLjA5Ny0yLjI2Ni0uMTIyLS41NzEtLjEyMUwwIDExLjc4NGwuMDU1LS4zNTIuNDgtLjMyMS42ODYuMDYgMS41Mi4xMDMgMi4yNzguMTU4IDEuNjUyLjA5NyAyLjQ0OS4yNTVoLjM4OWwuMDU1LS4xNTctLjEzNC0uMDk4LS4xMDMtLjA5Ny0yLjM1OC0xLjU5Ni0yLjU1Mi0xLjY4OC0xLjMzNi0uOTcyLS43MjQtLjQ5MS0uMzY0LS40NjItLjE1OC0xLjAwOC42NTYtLjcyMi44ODEuMDYuMjI1LjA2MS44OTMuNjg2IDEuOTA4IDEuNDc2IDIuNDkxIDEuODMzLjM2NS4zMDQuMTQ1LS4xMDMuMDE5LS4wNzMtLjE2NC0uMjc0LTEuMzU1LTIuNDQ2LTEuNDQ2LTIuNDktLjY0NC0xLjAzMi0uMTctLjYxOWEyLjk3IDIuOTcgMCAwMS0uMTA0LS43MjlMNi4yODMuMTM0IDYuNjk2IDBsLjk5Ni4xMzQuNDIuMzY0LjYyIDEuNDE0IDEuMDAyIDIuMjI5IDEuNTU1IDMuMDMuNDU2Ljg5OC4yNDMuODMyLjA5MS4yNTVoLjE1OFY5LjAxbC4xMjgtMS43MDYuMjM3LTIuMDk1LjIzLTIuNjk1LjA4LS43Ni4zNzYtLjkxLjc0Ny0uNDkyLjU4NC4yOC40OC42ODUtLjA2Ny40NDQtLjI4NiAxLjg1MS0uNTU5IDIuOTAzLS4zNjQgMS45NDJoLjIxMmwuMjQzLS4yNDIuOTg1LTEuMzA2IDEuNjUyLTIuMDY0LjczLS44Mi44NS0uOTA0LjU0Ny0uNDMxaDEuMDMzbC43NiAxLjEyOS0uMzQgMS4xNjYtMS4wNjQgMS4zNDctLjg4MSAxLjE0Mi0xLjI2NCAxLjctLjc5IDEuMzYuMDczLjExLjE4OC0uMDIgMi44NTYtLjYwNiAxLjU0My0uMjggMS44NDEtLjMxNS44MzMuMzg4LjA5MS4zOTUtLjMyOC44MDctMS45NjkuNDg2LTIuMzA5LjQ2Mi0zLjQzOS44MTMtLjA0Mi4wMy4wNDkuMDYxIDEuNTQ5LjE0Ni42NjIuMDM2aDEuNjIybDMuMDIuMjI1Ljc5LjUyMi40NzQuNjM4LS4wNzkuNDg1LTEuMjE1LjYyLTEuNjQtLjM4OS0zLjgyOS0uOTEtMS4zMTItLjMyOWgtLjE4MnYuMTFsMS4wOTMgMS4wNjggMi4wMDYgMS44MSAyLjUwOSAyLjMzLjEyNy41NzgtLjMyMi40NTUtLjM0LS4wNDktMi4yMDUtMS42NTctLjg1MS0uNzQ3LTEuOTI2LTEuNjJoLS4xMjh2LjE3bC40NDQuNjQ5IDIuMzQ1IDMuNTIxLjEyMiAxLjA4LS4xNy4zNTMtLjYwOC4yMTMtLjY2OC0uMTIyLTEuMzc0LTEuOTI1LTEuNDE1LTIuMTY3LTEuMTQzLTEuOTQzLS4xNC4wOC0uNjc0IDcuMjU0LS4zMTYuMzctLjcyOS4yOC0uNjA3LS40NjEtLjMyMi0uNzQ3LjMyMi0xLjQ3Ni4zODktMS45MjQuMzE1LTEuNTMuMjg2LTEuOS4xNy0uNjMyLS4wMTItLjA0Mi0uMTQuMDE4LTEuNDM0IDEuOTY3LTIuMTggMi45NDUtMS43MjYgMS44NDUtLjQxNC4xNjQtLjcxNy0uMzcuMDY3LS42NjIuNDAxLS41ODkgMi4zODgtMy4wMzYgMS40NC0xLjg4Mi45My0xLjA4Ni0uMDA2LS4xNThoLS4wNTVMNC4xMzIgMTguNTZsLTEuMTMuMTQ2LS40ODctLjQ1Ni4wNjEtLjc0Ni4yMzEtLjI0MyAxLjkwOC0xLjMxMi0uMDA2LjAwNnoiIGZpbGw9IiNEOTc3NTciIGZpbGwtcnVsZT0ibm9uemVybyI+PC9wYXRoPjwvc3ZnPg=="};
    function providerOf(session) {
      if (session.provider) return session.provider;
      const prefix = String(session.sessionId || "").split(":")[0];
      return prefix === "kimi-cli" ? "kimi" : PROVIDERS[prefix] ? prefix : "codex";
    }

    function agentClientLabel(session) {
      const labels = { app: "桌面应用", codex_app: "桌面应用", vscode: "VS Code", cli: "CLI", exec: "Exec", dsh: "DeepSeek Harness",
        "kimi-vscode": "VS Code", "kimi-cli": "CLI", "kimi-desktop": "桌面应用", "kimi-unknown": "来源未记录",
        "claude-vscode": "VS Code", "claude-cli": "CLI", claude: "客户端" };
      return labels[String(session.source || "").toLowerCase()] || clientLabel(session.source);
    }

    function readJson(response) {
      return response.json().catch(() => ({})).then((payload) => {
        if (!response.ok) throw Object.assign(new Error(payload.error || "请求失败（HTTP " + response.status + "）"), { status: response.status });
        return payload;
      });
    }

    function request(path, options) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const init = Object.assign({
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" }
      }, options, { signal });
      if (init.body !== undefined) {
        init.headers = Object.assign({}, init.headers, { "content-type": "application/json; charset=utf-8" });
        init.body = JSON.stringify(init.body);
      }
      return fetch(path, init).then(readJson).catch((error) => {
        if (error && error.name === "AbortError") throw new Error("请求超时");
        throw error;
      }).finally(() => window.clearTimeout(timer));
    }

    async function reviewSelectedSessions(sessionIds, send = request, pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))) {
      const selected = Array.from(new Set(sessionIds));
      try {
        return await send("/codex-monitor/review-all", { method: "POST", body: { sessionIds: selected } });
      } catch (failure) {
        // Desktop keeps already imported Host modules until its next restart.
        // Its existing single-review API remains usable during that interval.
        if (failure.status !== 404 && failure.status !== 405) throw failure;
      }
      const result = { reviewedCount: 0, reviewedIds: [], skippedIds: [], failures: [] };
      for (let offset = 0; offset < selected.length; offset += 16) {
        const group = selected.slice(offset, offset + 16);
        let snapshot;
        try {
          const before = await send("/codex-monitor/sessions");
          await send("/codex-monitor/refresh", { method: "POST", body: {} });
          const deadline = Date.now() + REQUEST_TIMEOUT_MS;
          do {
            snapshot = await send("/codex-monitor/sessions");
            if (!snapshot.refreshing && snapshot.generatedAt !== before.generatedAt) break;
            if (Date.now() >= deadline) throw new Error("审核前刷新超时");
            await pause(REFRESH_POLL_MS);
          } while (true);
          if (snapshot.health?.index !== "ok" || snapshot.health?.records !== "ok") throw new Error("数据源未就绪，请稍后重试审核");
        } catch (failure) {
          group.forEach((sessionId) => result.failures.push({ sessionId, error: failure.message || String(failure) }));
          continue;
        }
        const current = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
        for (const sessionId of group) {
          const session = current.get(sessionId);
          if (!session || (session.status !== "turn_completed" && session.reviewable !== true)) {
            result.skippedIds.push(sessionId);
            continue;
          }
          try {
            await send("/codex-monitor/review-completed", { method: "POST", body: { sessionId } });
            result.reviewedIds.push(sessionId);
          } catch (failure) {
            if (failure.status === 400 || failure.status === 404) result.skippedIds.push(sessionId);
            else result.failures.push({ sessionId, error: failure.message || String(failure) });
          }
        }
      }
      result.reviewedCount = result.reviewedIds.length;
      return result;
    }

    const PREVIEW_CSS = `
      .cdm-cardActions{gap:6px;justify-content:space-between}
      .cdm-previewShade{position:absolute;inset:0;z-index:3;background:rgba(0,0,0,.16)}
      .cdm-preview{position:absolute;inset:0 0 0 auto;z-index:4;width:min(720px,72%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#fff);border-left:1px solid var(--dsw-alias-divider-1,#ddd);box-shadow:-12px 0 32px #0002;color:var(--dsw-alias-label-primary,#222)}
      .cdm-previewHead{padding:16px 18px;border-bottom:1px solid var(--dsw-alias-divider-1,#ddd);display:flex;gap:12px;align-items:flex-start}
      .cdm-previewHeading{flex:1;min-width:0}.cdm-previewHeading h3{margin:0 0 7px;font-size:16px;line-height:1.5;overflow-wrap:anywhere}
      .cdm-previewPath{font-size:11px;color:var(--dsw-alias-label-tertiary,#777);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:7px}
      .cdm-previewToolbar{display:flex;align-items:center;gap:8px;padding:10px 18px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-divider-1,#ddd)}
      .cdm-previewNote{font-size:11px;color:var(--dsw-alias-label-tertiary,#777);line-height:1.6}
      .cdm-transcript{flex:1;min-height:0;overflow:auto;padding:16px 20px;overscroll-behavior:contain;scrollbar-gutter:stable}
      .cdm-historyTop{text-align:center;margin-bottom:18px}.cdm-message{padding:14px 0;border-bottom:1px solid var(--dsw-alias-divider-1,#ddd);overflow-wrap:anywhere}
      .cdm-messageHead{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#777);margin-bottom:8px}
      .cdm-messageRole{font-weight:600;color:var(--dsw-alias-label-primary,#222)}.cdm-message-user .cdm-messageRole{color:#3783ce}
      .cdm-copy{margin-left:auto;background:none;border:0;padding:2px 4px;color:inherit;cursor:pointer;font:inherit}.cdm-copy:hover{text-decoration:underline}
      .cdm-markdown{font-size:13px;line-height:1.75;white-space:normal}.cdm-markdown p{margin:0 0 10px;white-space:pre-wrap}.cdm-markdown p:last-child{margin-bottom:0}
      .cdm-markdown h1,.cdm-markdown h2,.cdm-markdown h3,.cdm-markdown h4{font-size:15px;margin:15px 0 8px}.cdm-markdown h1{font-size:19px}.cdm-markdown h2{font-size:17px}
      .cdm-markdown pre{white-space:pre;overflow:auto;background:var(--dsw-alias-bg-layer-1,#f4f5f6);padding:12px;border-radius:7px;margin:10px 0;font-size:12px}.cdm-markdown code{font-family:Consolas,monospace;background:var(--dsw-alias-bg-layer-1,#f4f5f6);border-radius:3px;padding:1px 3px}.cdm-markdown pre code{padding:0;background:none}
      .cdm-markdown ul,.cdm-markdown ol{padding-left:24px;margin:8px 0}.cdm-markdown blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #9995;color:var(--dsw-alias-label-secondary,#666)}.cdm-markdown a{color:#3783ce;text-decoration:underline}
      .cdm-message details{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}.cdm-message summary{cursor:pointer;padding:3px 0}.cdm-message details pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1,#f5f5f5);border-radius:6px;padding:10px;font:12px/1.65 Consolas,monospace;max-height:360px;overflow:auto}
      .cdm-previewError{padding:12px;color:var(--dsw-alias-warning-fg-1,#b7791f);font-size:12px}.cdm-previewStatus{padding:7px 18px;min-height:20px;border-top:1px solid var(--dsw-alias-divider-1,#ddd)}
      @container(max-width:860px){.cdm-preview{width:100%;border:0}.cdm-transcript{padding:12px 16px}}
    `;

    function safeLink(value) {
      try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
      catch { return null; }
    }

    function inlineMarkdown(text) {
      const parts = [];
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
      let start = 0;
      let match;
      while ((match = pattern.exec(text))) {
        parts.push(text.slice(start, match.index));
        const token = match[0];
        if (token.startsWith("`")) parts.push(React.createElement("code", { key: match.index }, token.slice(1, -1)));
        else if (token.startsWith("**")) parts.push(React.createElement("strong", { key: match.index }, token.slice(2, -2)));
        else {
          const link = token.match(/^\[([^\]]+)\]\((.*)\)$/);
          const href = safeLink(link[2]);
          parts.push(href ? React.createElement("a", { key: match.index, href, target: "_blank", rel: "noopener noreferrer" }, link[1]) : token);
        }
        start = pattern.lastIndex;
      }
      parts.push(text.slice(start));
      return parts;
    }

    function MarkdownText(props) {
      const lines = props.text.split(/\r?\n/);
      const blocks = [];
      for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!line.trim()) { index++; continue; }
        if (/^\s*```/.test(line)) {
          const code = [];
          const language = line.trim().slice(3).trim();
          index++;
          while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
          index++;
          blocks.push(React.createElement("pre", { key: index, title: language }, React.createElement("code", null, code.join("\n"))));
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) { blocks.push(React.createElement("h" + heading[1].length, { key: index++ }, inlineMarkdown(heading[2]))); continue; }
        if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
          const ordered = /^\s*\d/.test(line);
          const items = [];
          const pattern = ordered ? /^\s*\d+[.)] / : /^\s*[-*+] /;
          while (index < lines.length && pattern.test(lines[index])) items.push(React.createElement("li", { key: index }, inlineMarkdown(lines[index++].replace(pattern, ""))));
          blocks.push(React.createElement(ordered ? "ol" : "ul", { key: index }, items));
          continue;
        }
        if (/^>\s?/.test(line)) { blocks.push(React.createElement("blockquote", { key: index++ }, inlineMarkdown(line.replace(/^>\s?/, "")))); continue; }
        const paragraph = [line];
        index++;
        while (index < lines.length && lines[index].trim() && !/^(?:\s*```|#{1,4} |>\s?|\s*[-*+] |\s*\d+[.)] )/.test(lines[index])) paragraph.push(lines[index++]);
        blocks.push(React.createElement("p", { key: index }, inlineMarkdown(paragraph.join("\n"))));
      }
      return React.createElement("div", { className: "cdm-markdown" }, blocks);
    }

    function ConversationPreview(props) {
      const [page, setPage] = React.useState(null);
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const scrollRef = React.useRef(null);
      const closeRef = React.useRef(null);
      const abortRef = React.useRef(null);
      const generationRef = React.useRef(0);
      const pageRef = React.useRef(null);
      const busyRef = React.useRef(false);
      const scrollRestoreRef = React.useRef(null);
      const session = props.session;

      const loadPage = React.useCallback(async (older) => {
        if (older && (busyRef.current || !pageRef.current?.nextCursor)) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const generation = ++generationRef.current;
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        busyRef.current = true;
        setLoading(true);
        setError("");
        try {
          const response = await fetch("/codex-monitor/conversation", {
            method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ sessionId: session.sessionId, cursor: older ? pageRef.current.nextCursor : null })
          });
          if (response.status === 404 || response.status === 405) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "会话预览尚未加载，请重启 DeepSeek Harness 后重试");
          }
          const result = await readJson(response);
          if (generation !== generationRef.current) return;
          const oldMessages = older ? pageRef.current.messages : [];
          const messages = Array.from(new Map([...result.messages, ...oldMessages].map((item) => [item.id, item])).values());
          const trimmed = messages.length > 200;
          const next = { ...result, messages: messages.slice(0, 200) };
          if (older && scrollRef.current) scrollRestoreRef.current = { height: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
          else scrollRestoreRef.current = "bottom";
          pageRef.current = next;
          setPage(next);
          setNotice(trimmed ? "已收起较新的记录以控制内存；可点“回到最新”重新查看" : result.warnings.join("；"));
        } catch (failure) {
          if (generation !== generationRef.current) return;
          setError(failure.name === "AbortError" ? "读取超时，请重试" : failure.message || String(failure));
        } finally {
          window.clearTimeout(timer);
          if (generation === generationRef.current) { busyRef.current = false; setLoading(false); }
        }
      }, [session.sessionId]);

      React.useEffect(() => {
        const previous = document.activeElement;
        closeRef.current?.focus();
        loadPage(false);
        return () => { generationRef.current++; abortRef.current?.abort(); pageRef.current = null; previous?.focus?.(); };
      }, [loadPage]);

      React.useLayoutEffect(() => {
        const node = scrollRef.current;
        const restore = scrollRestoreRef.current;
        if (node && restore) node.scrollTop = restore === "bottom" ? node.scrollHeight : restore.top + node.scrollHeight - restore.height;
        scrollRestoreRef.current = null;
      }, [page]);

      const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); setNotice("已复制"); }
        catch { setNotice("复制失败，请选中文字后复制"); }
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") { event.stopPropagation(); props.onClose(); }
        if (event.key === "Tab") {
          const focusable = Array.from(event.currentTarget.querySelectorAll("button:not(:disabled),a[href],summary,[tabindex='0']"));
          const first = focusable[0]; const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      };
      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "cdm-previewShade", onClick: props.onClose, "aria-hidden": true }),
        React.createElement("section", { className: "cdm-preview", role: "dialog", "aria-modal": true, "aria-labelledby": "cdm-preview-title", onKeyDown },
          React.createElement("header", { className: "cdm-previewHead" },
            React.createElement("div", { className: "cdm-previewHeading" },
              React.createElement("h3", { id: "cdm-preview-title" }, session.title || "未命名会话"),
              React.createElement("span", { className: "cdm-chip" }, clientLabel(session.source)),
              React.createElement("span", { className: "cdm-previewNote", style: { marginLeft: 8 } }, "只读预览"),
              React.createElement("div", { className: "cdm-previewPath", title: session.cwd }, session.cwd || "工作目录未知")
            ),
            React.createElement("button", { ref: closeRef, className: "cdm-iconBtn", type: "button", "aria-label": "关闭会话预览", onClick: props.onClose }, React.createElement(CloseIcon, null))
          ),
          React.createElement("div", { className: "cdm-previewToolbar" },
            React.createElement("button", { className: "cdm-reviewBtn", type: "button", onClick: () => loadPage(false), disabled: loading }, "回到最新"),
            React.createElement("button", { className: "cdm-reviewBtn", type: "button", onClick: () => copy(session.nativeSessionId || session.sessionId) }, "复制会话 ID"),
            React.createElement("span", { className: "cdm-previewNote" }, "工具与思考默认折叠 · 附件暂不预览")
          ),
          React.createElement("div", { className: "cdm-transcript", ref: scrollRef, "aria-busy": loading, onScroll: (event) => { if (event.currentTarget.scrollTop < 30 && !error) loadPage(true); } },
            React.createElement("div", { className: "cdm-historyTop" },
              loading ? React.createElement("span", { className: "cdm-previewNote", role: "status" }, "正在读取会话…")
                : page?.nextCursor ? React.createElement("button", { className: "cdm-reviewBtn", type: "button", onClick: () => loadPage(true) }, "加载更早记录")
                  : page ? React.createElement("span", { className: "cdm-previewNote" }, page.messages.length ? "已到历史开头" : "暂无可预览的文字记录") : null
            ),
            error ? React.createElement("div", { className: "cdm-previewError", role: "alert" }, error, " ", React.createElement("button", { className: "cdm-reviewBtn", type: "button", onClick: () => loadPage(Boolean(pageRef.current)) }, "重试")) : null,
            (page?.messages || []).map((item) => React.createElement("article", { className: "cdm-message cdm-message-" + item.role, key: item.id },
              React.createElement("div", { className: "cdm-messageHead" },
                React.createElement("span", { className: "cdm-messageRole" }, item.role === "user" ? "你" : item.role === "thought" ? "思考记录" : item.role === "tool" ? "工具" : "助手"),
                item.time ? React.createElement("span", null, formatTime(item.time)) : null,
                React.createElement("button", { type: "button", className: "cdm-copy", onClick: () => copy(item.text), "aria-label": "复制这条记录" }, "复制")
              ),
              item.kind === "tool" || item.kind === "thought"
                ? React.createElement("details", null, React.createElement("summary", null, item.label || (item.kind === "thought" ? "展开思考记录" : "展开工具记录")), React.createElement("pre", null, item.text))
                : React.createElement(MarkdownText, { text: item.text }),
              item.truncated ? React.createElement("div", { className: "cdm-previewNote" }, "这条记录较长，仅展示前 24,000 字符") : null
            ))
          ),
          React.createElement("div", { className: "cdm-previewStatus cdm-previewNote", role: "status" }, notice || "查看会话不会更改审核状态")
        )
      );
    }


    function SessionCard(props) {
      const session = props.session;
      const uncertain = session.status === "unknown" && session.statusUncertain === true;
      const abnormal = session.status === "unknown" && !uncertain;
      const title = (uncertain ? "待确认 · " : "") + (session.title || "未命名会话");
      const tokenLabel = formatTokenCount(session.tokensUsed);
      const questionCount = Number(session.questionCount);
      const questionLabel = Number.isSafeInteger(questionCount) && questionCount > 0 ? questionCount.toLocaleString() + " times" : null;
      const contextLabel = formatContextUsage(session);
      const provider = providerOf(session);
      const agentName = PROVIDERS[provider] || "Agent";
      const laneLabel = session.status === "running" ? "运行中" : session.status === "turn_completed" || session.reviewable === true ? "待审核" : "记录";
      return React.createElement("article", { className: "cdm-card", title: session.sessionId },
        React.createElement("div", { className: "cdm-cardIdentity" },
          React.createElement("span", { className: "cdm-agentLogo cdm-agentLogo-" + provider, "aria-hidden": true },
            AGENT_LOGOS[provider] ? React.createElement("img", { src: AGENT_LOGOS[provider], alt: "", width: 28, height: 28, draggable: false }) : agentName.charAt(0)
          ),
          React.createElement("div", { className: "cdm-agentText" },
            React.createElement("div", { className: "cdm-agentName" }, agentName),
            React.createElement("div", { className: "cdm-agentClient", title: clientLabel(session.source) }, agentClientLabel(session))
          ),
          React.createElement("span", { className: "cdm-cardStatus", title: session.statusReason || laneLabel }, laneLabel)
        ),
        React.createElement("div", {
          className: "cdm-cardTitle" + (abnormal ? " cdm-cardTitleError" : ""),
          title: session.status === "unknown" ? (session.statusReason || "状态待确认") : title
        }, abnormal ? "异常 · " + title : title),
        React.createElement("div", { className: "cdm-path", title: session.cwd || "" }, session.cwd || "工作目录未知"),
        React.createElement("div", { className: "cdm-cardMeta" },
          session.modelProvider ? React.createElement("span", { className: "cdm-chip", title: session.modelProvider }, session.modelProvider) : null,
          session.model ? React.createElement("span", { className: "cdm-chip", title: session.model }, session.model) : null,
          session.reasoningEffort ? React.createElement("span", { className: "cdm-chip", title: "reasoning_effort: " + session.reasoningEffort }, session.reasoningEffort) : null,
          tokenLabel ? React.createElement("span", { className: "cdm-chip", title: Number(session.tokensUsed).toLocaleString() + " tokens" }, tokenLabel) : null,
          questionLabel ? React.createElement("span", { className: "cdm-chip", title: "累计 " + questionCount.toLocaleString() + " 次用户提问" }, questionLabel) : null
        ),
        React.createElement("div", { className: "cdm-reason" },
          React.createElement("span", { className: "cdm-reasonText", title: contextUsageTitle(session) }, contextLabel),
          React.createElement("span", { className: "cdm-time" }, formatTime(session.updatedAt))
        ),
        React.createElement("div", { className: "cdm-cardActions" },
          React.createElement("button", { type: "button", className: "cdm-reviewBtn", onClick: () => props.onPreview(session) }, "查看会话"),
          session.status === "running" && !props.compact ? React.createElement("button", {
            type: "button",
            className: "cdm-reviewBtn",
            disabled: props.dismissDisabled || props.dismissing || !session.observedAt,
            title: "清理已停止但仍显示运行中的会话；保留历史记录，不终止实际进程",
            onClick: () => props.onDismiss(session)
          }, props.dismissing ? "移除中…" : "移除会话") : null,
          (session.status === "turn_completed" || session.reviewable === true) ?
          React.createElement("button", {
            type: "button",
            className: "cdm-reviewBtn",
            disabled: props.reviewDisabled || props.reviewing,
            onClick: () => props.onReview(session.sessionId)
          }, props.reviewing ? "处理中…" : "审核完成") : null
        )
      );
    }

    function Lane(props) {
      return React.createElement("section", { className: "cdm-lane cdm-" + props.column.tone },
        React.createElement("header", { className: "cdm-laneHead" },
          React.createElement("span", { className: "cdm-laneTitle" }, props.column.label),
          React.createElement("span", { className: "cdm-laneCount" }, String(props.sessions.length)),
          props.column.key === "turn_completed"
            ? React.createElement("button", {
              type: "button",
              className: "cdm-reviewBtn",
              style: { marginLeft: "auto", flexShrink: 0 },
              disabled: props.reviewBusy || props.sessions.length === 0,
              title: "审核当前筛选范围内的全部待审核记录；运行中的会话会自动跳过",
              onClick: props.onReviewAll
            }, props.bulkReviewing ? "审核中…" : "全部审核（" + props.sessions.length + "）")
            : React.createElement("span", { className: "cdm-laneHint" }, props.column.description)
        ),
        React.createElement("div", { className: "cdm-laneBody" },
          props.sessions.length === 0
            ? React.createElement("div", { className: "cdm-empty" }, "当前筛选范围内没有会话")
            : props.sessions.map((session) => React.createElement(SessionCard, {
              key: session.sessionId,
              session: session,
              reviewing: props.bulkReviewing || props.reviewingId === session.sessionId,
              reviewDisabled: props.reviewBusy,
              dismissing: props.dismissingId === session.sessionId,
              dismissDisabled: props.reviewBusy,
              onPreview: props.onPreview,
              onDismiss: props.onDismiss,
              onReview: props.onReview
            }))
        )
      );
    }

    function BoardPanel() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [previewSession, setPreviewSession] = React.useState(null);
      const [error, setError] = React.useState("");
      const [query, setQuery] = React.useState("");
      const [source, setSource] = React.useState("");
      const [provider, setProvider] = React.useState("");
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshPulse, setRefreshPulse] = React.useState(0);
      const [refreshActive, setRefreshActive] = React.useState(false);
      const [reviewingId, setReviewingId] = React.useState("");
      const [dismissingId, setDismissingId] = React.useState("");
      const [bulkReviewing, setBulkReviewing] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const [testingNotification, setTestingNotification] = React.useState(false);
      const [notificationSettings, setNotificationSettings] = React.useState(null);
      const [loadingNotifications, setLoadingNotifications] = React.useState(false);
      const [savingNotifications, setSavingNotifications] = React.useState(false);
      const mutationBusyRef = React.useRef(false);
      const requestId = React.useRef(0);
      const mountedRef = React.useRef(true);
      const refreshTimerRef = React.useRef(null);

      const load = React.useCallback((silent) => {
        const current = ++requestId.current;
        if (!silent) setError("");
        return request("/codex-monitor/sessions").then((next) => {
          if (current !== requestId.current) return null;
          setSnapshot(next);
          setError("");
          setRefreshing(Boolean(next.refreshing));
          return next;
        }).catch((failure) => {
          if (current !== requestId.current) return null;
          setError(failure instanceof Error ? failure.message : String(failure));
          return null;
        });
      }, []);

      const waitForRefresh = React.useCallback((previousGeneratedAt, isActive) => {
        const deadline = Date.now() + REQUEST_TIMEOUT_MS;
        const poll = () => {
          if (!isActive()) return Promise.resolve(null);
          return load(true).then((next) => {
            if (!isActive()) return null;
            if (next && !next.refreshing && next.generatedAt !== previousGeneratedAt) return next;
            if (Date.now() >= deadline) throw new Error("刷新超时，后台可能仍在处理");
            return new Promise((resolve) => window.setTimeout(resolve, REFRESH_POLL_MS)).then(poll);
          });
        };
        return poll();
      }, [load]);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
        };
      }, []);

      React.useEffect(() => {
        let active = true;
        const loadActive = (silent) => active && document.visibilityState !== "hidden" ? load(silent) : Promise.resolve();
        loadActive(false).then((initial) => {
          if (!active) return null;
          setRefreshing(true);
          return request("/codex-monitor/refresh", { method: "POST", body: {} })
            .then(() => waitForRefresh(initial?.generatedAt, () => active && document.visibilityState !== "hidden"));
        })
          .catch((failure) => {
            if (active) {
              setRefreshing(false);
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          });
        const timer = window.setInterval(() => loadActive(true), POLL_MS);
        return () => { active = false; window.clearInterval(timer); requestId.current += 1; };
      }, [load, waitForRefresh]);

      React.useEffect(() => {
        if (!previewSession) return;
        const onKey = (event) => { if (event.key === "Escape") setPreviewSession(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [previewSession]);

      const manualRefresh = () => {
        const previousGeneratedAt = snapshot?.generatedAt;
        setRefreshPulse((current) => current + 1);
        setRefreshActive(true);
        if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          setRefreshActive(false);
          refreshTimerRef.current = null;
        }, 900);
        setRefreshing(true);
        setError("");
        request("/codex-monitor/refresh", { method: "POST", body: {} })
          .then(() => waitForRefresh(previousGeneratedAt, () => mountedRef.current))
          .catch((failure) => {
            if (!mountedRef.current) return;
            setRefreshing(false);
            setError(failure instanceof Error ? failure.message : String(failure));
          });
      };

      const testNotification = () => {
        setTestingNotification(true);
        setNotice("");
        setError("");
        request("/codex-monitor/notifications/test", { method: "POST", body: {} })
          .then((result) => {
            if (!mountedRef.current) return;
            const results = result.results || [{ channel: "windows", sent: true }];
            setNotice(results.map((item) => (item.channel === "windows" ? "Windows" : "IM") + (item.sent ? "：已提交" : "：失败")).join("；"));
            const failures = results.filter((item) => !item.sent);
            if (failures.length) setError(failures.map((item) => (item.channel === "windows" ? "Windows" : "IM") + "：" + item.error).join("；"));
          })
          .catch((failure) => { if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure)); })
          .finally(() => { if (mountedRef.current) setTestingNotification(false); });
      };

      const openNotificationSettings = () => {
        if (notificationSettings) { setNotificationSettings(null); return; }
        setLoadingNotifications(true);
        setError("");
        request("/codex-monitor/notifications/settings")
          .then((value) => { if (mountedRef.current) setNotificationSettings(value); })
          .catch((failure) => { if (mountedRef.current) setError(failure.message || String(failure)); })
          .finally(() => { if (mountedRef.current) setLoadingNotifications(false); });
      };

      const editNotificationSettings = (changes) => setNotificationSettings((current) => ({ ...current, settings: { ...current.settings, ...changes } }));
      const saveNotificationSettings = () => {
        setSavingNotifications(true);
        setError("");
        request("/codex-monitor/notifications/settings", { method: "POST", body: notificationSettings.settings })
          .then((value) => {
            if (!mountedRef.current) return;
            setSnapshot((current) => ({ ...current, notifications: value }));
            setNotificationSettings(null);
            setNotice("通知设置已保存");
          })
          .catch((failure) => { if (mountedRef.current) setError(failure.message || String(failure)); })
          .finally(() => { if (mountedRef.current) setSavingNotifications(false); });
      };

      const reviewCompleted = (sessionId) => {
        if (mutationBusyRef.current) return;
        mutationBusyRef.current = true;
        setReviewingId(sessionId);
        setNotice("");
        setError("");
        request("/codex-monitor/review-completed", { method: "POST", body: { sessionId: sessionId } })
          .then(() => load(true))
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => { mutationBusyRef.current = false; if (mountedRef.current) setReviewingId(""); });
      };

      const dismissRunning = async (session) => {
        if (mutationBusyRef.current || !session.observedAt) return;
        mutationBusyRef.current = true;
        setDismissingId(session.sessionId);
        setNotice("");
        setError("");
        try {
          await request("/codex-monitor/dismiss-running", {
            method: "POST", body: { sessionId: session.sessionId, observedAt: session.observedAt }
          });
          await load(true);
          if (mountedRef.current) setNotice("已移出运行中，历史记录保留");
        } catch (failure) {
          // A new turn must never be dismissed using the previous card's identity.
          let conflictMessage = "会话状态或轮次已变化，未移除；已刷新列表";
          if (failure.status === 409) {
            try {
              await request("/codex-monitor/refresh", { method: "POST", body: { sessionId: session.sessionId } });
              await waitForRefresh(snapshot?.generatedAt, () => mountedRef.current);
            } catch {
              conflictMessage = "会话状态或轮次已变化，未移除；请刷新后重试";
            }
          }
          if (mountedRef.current) setError(failure.status === 409
            ? conflictMessage
            : failure instanceof Error ? failure.message : String(failure));
        } finally {
          mutationBusyRef.current = false;
          if (mountedRef.current) setDismissingId("");
        }
      };

      const reviewAllCompleted = () => {
        if (mutationBusyRef.current) return;
        const sessionIds = grouped.turn_completed.map((session) => session.sessionId);
        if (sessionIds.length === 0) return;
        mutationBusyRef.current = true;
        setBulkReviewing(true);
        setNotice("");
        setError("");
        reviewSelectedSessions(sessionIds)
          .then((result) => load(true).then(() => {
            if (!mountedRef.current) return;
            setNotice("已审核 " + result.reviewedCount + " 条"
              + (result.skippedIds.length ? "，跳过 " + result.skippedIds.length + " 条状态已变化的会话" : "")
              + (result.failures.length ? "，" + result.failures.length + " 条读取失败，请重试" : ""));
          }))
          .catch((failure) => { if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure)); })
          .finally(() => { mutationBusyRef.current = false; if (mountedRef.current) setBulkReviewing(false); });
      };

      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      const sources = Array.from(new Set(sessions.filter((item) => !provider || providerOf(item) === provider).map((item) => item.source).filter(Boolean))).sort();
      const needle = query.trim().toLowerCase();
      const visible = sessions.filter((item) => {
        if (provider && providerOf(item) !== provider) return false;
        if (source && item.source !== source) return false;
        if (!needle) return true;
        return String(item.title || "").toLowerCase().includes(needle)
          || String(item.cwd || "").toLowerCase().includes(needle);
      });
      const grouped = {};
      COLUMNS.forEach((column) => { grouped[column.key] = []; });
      visible.forEach((item) => {
        const lane = item.status === "unknown"
          ? (item.reviewable === true ? "turn_completed" : "record")
          : item.status;
        (grouped[lane] || grouped.record).push(item);
      });
      const degraded = snapshot && snapshot.health && (snapshot.health.index !== "ok" || snapshot.health.rollout !== "ok" || snapshot.health.records !== "ok");
      const notificationErrors = Object.entries(snapshot?.notifications?.channels || {})
        .filter(([, state]) => state.lastError)
        .map(([channel, state]) => (channel === "windows" ? "Windows" : "IM") + "：" + state.lastError).join("；");
      const statusError = error || snapshot?.notifications?.settingsError || snapshot?.health?.lastError || notificationErrors;

      return React.createElement("section", { className: "cdm-panel", "aria-labelledby": "cdm-title" },
          React.createElement("header", { className: "cdm-head" },
            React.createElement("div", { className: "cdm-heading" },
              React.createElement(MonitorIcon, null),
              React.createElement("h2", { id: "cdm-title", className: "cdm-title" }, "会话看板"),
              React.createElement("span", { className: "cdm-badge" }, "v" + VERSION),
              React.createElement("span", { className: "cdm-subtitle" }, "Codex · DSH · Kimi · Claude")
            ),
            React.createElement("div", { className: "cdm-actions" },
              React.createElement("label", { className: "cdm-search" },
                React.createElement(SearchIcon, null),
                React.createElement("input", {
                  value: query,
                  placeholder: "搜索标题或目录",
                  "aria-label": "搜索标题或工作目录",
                  onChange: (event) => setQuery(event.target.value)
                })
              ),
              React.createElement("select", {
                className: "cdm-select", value: provider, "aria-label": "按客户端筛选",
                onChange: (event) => { setProvider(event.target.value); setSource(""); }
              }, React.createElement("option", { value: "" }, "全部客户端"),
              Object.entries(PROVIDERS).map(([key, label]) => React.createElement("option", { key, value: key }, label))),
              React.createElement("select", {
                className: "cdm-select",
                value: source,
                "aria-label": "按来源筛选",
                onChange: (event) => setSource(event.target.value)
              },
                React.createElement("option", { value: "" }, "全部来源"),
                sources.map((value) => React.createElement("option", { key: value, value: value }, clientLabel(value)))
              ),
              React.createElement("button", {
                type: "button",
                className: "cdm-iconBtn" + (refreshActive || refreshing ? " cdm-refreshed" : ""),
                title: "刷新",
                "aria-label": "刷新会话状态",
                disabled: refreshing || bulkReviewing || Boolean(reviewingId) || Boolean(dismissingId),
                onClick: manualRefresh
              }, React.createElement("span", {
                key: refreshPulse,
                className: "cdm-refreshGlyph" + (refreshActive || refreshing ? " cdm-spin" : "")
              }, React.createElement(RefreshIcon, null)))
            )
          ),
          React.createElement("div", { className: "cdm-meta" },
            React.createElement("span", { className: "cdm-health" },
              React.createElement("span", { className: "cdm-healthDot" + (degraded ? " cdm-degraded" : "") }),
              degraded ? "数据源部分降级" : "数据源正常"
            ),
            React.createElement("span", null, "显示 " + visible.length + " / " + sessions.length),
            React.createElement("span", null, "更新 " + formatTime(snapshot && snapshot.generatedAt)),
            snapshot?.sources ? Object.entries(snapshot.sources).map(([key, value]) => React.createElement("span", {
              key, title: (value.errors || []).join("；") || (Number.isFinite(value.durationMs) ? "上次读取耗时 " + value.durationMs + " ms；" : "") + "每个来源展示最近 30 条及额外运行记录",
              className: value.status === "degraded" ? "cdm-sourceWarning" : ""
            }, (PROVIDERS[key] || key) + "：" + (value.status === "unavailable" ? "未连接" : value.status === "loading" ? "读取中" : value.status === "degraded" ? "读取异常" : String(value.count || 0)))) : null,
            Object.entries(snapshot?.notifications?.channels || (snapshot?.notifications?.supported ? { windows: snapshot.notifications } : {})).map(([channel, state]) => React.createElement("span", {
              key: channel, className: state.lastError ? "cdm-sourceWarning" : "", title: state.lastError || "后台每 10 秒检测新完成轮次，关闭看板仍会通知；读取较慢时会延后"
            }, (channel === "windows" ? "Windows" : "IM") + (state.lastError ? " 通知异常" : state.enabled ? " 完成通知已开启" : " 完成通知已关闭"))),
            snapshot?.notifications?.supported || snapshot?.notifications?.enabled ? React.createElement("button", {
              type: "button", className: "cdm-reviewBtn", onClick: testNotification,
              disabled: testingNotification || !snapshot.notifications.enabled, "aria-label": "发送测试通知"
            }, testingNotification ? "发送中…" : "测试通知") : null,
            snapshot ? React.createElement("button", {
              type: "button", className: "cdm-reviewBtn", onClick: openNotificationSettings,
              disabled: loadingNotifications || savingNotifications, "aria-expanded": Boolean(notificationSettings)
            }, loadingNotifications ? "读取中…" : "通知设置") : null,
            notice ? React.createElement("span", { role: "status" }, notice) : null,
            statusError
              ? React.createElement("span", { className: "cdm-metaError", title: statusError }, statusError)
              : null
          ),
          notificationSettings ? React.createElement("div", { className: "cdm-notificationSettings", role: "group", "aria-label": "通知设置" },
            React.createElement("label", null,
              React.createElement("input", { type: "checkbox", checked: notificationSettings.settings.windowsEnabled, disabled: savingNotifications,
                onChange: (event) => editNotificationSettings({ windowsEnabled: event.target.checked }) }), " Windows 通知"),
            React.createElement("label", null,
              React.createElement("input", { type: "checkbox", checked: notificationSettings.settings.imEnabled, disabled: savingNotifications,
                onChange: (event) => editNotificationSettings({ imEnabled: event.target.checked }) }), " IM 通知"),
            React.createElement("select", { className: "cdm-select", "aria-label": "IM 接收目标", disabled: savingNotifications,
              value: notificationSettings.settings.botId ? notificationSettings.settings.botId + "/" + notificationSettings.settings.targetId : "",
              onChange: (event) => { const parts = event.target.value.split("/"); editNotificationSettings({ botId: parts[0] || "", targetId: parts[1] || "" }); }
            }, React.createElement("option", { value: "" }, "请选择 IM 接收目标"),
            notificationSettings.settings.botId && !notificationSettings.targets.some((target) => target.botId === notificationSettings.settings.botId && target.targetId === notificationSettings.settings.targetId)
              ? React.createElement("option", { value: notificationSettings.settings.botId + "/" + notificationSettings.settings.targetId }, "当前目标不可用，请重新选择") : null,
            notificationSettings.targets.map((target) => React.createElement("option", { key: target.botId + "/" + target.targetId, value: target.botId + "/" + target.targetId }, target.label))),
            React.createElement("button", { type: "button", className: "cdm-reviewBtn", disabled: savingNotifications, onClick: saveNotificationSettings }, savingNotifications ? "保存中…" : "保存通知设置"),
            React.createElement("span", null, notificationSettings.targets.length ? "测试通知发送到已开启的渠道。" : "请先在 IM 机器人设置中保存接收目标；离线时可关闭 IM 通知。")
          ) : null,
          !snapshot && !error ? React.createElement("div", { className: "cdm-loading" }, "正在读取各客户端会话…") : null,
          !snapshot && error ? React.createElement("div", { className: "cdm-fatal" },
            React.createElement("span", null, error),
            React.createElement("button", { type: "button", className: "cdm-retry", onClick: () => load(false) }, "重试")
          ) : null,
          snapshot ? React.createElement("main", { className: "cdm-board" },
            COLUMNS.map((column) => React.createElement(Lane, {
              key: column.key,
              column: column,
              sessions: grouped[column.key],
              reviewingId: reviewingId,
              dismissingId: dismissingId,
              bulkReviewing: bulkReviewing,
              reviewBusy: refreshing || bulkReviewing || Boolean(reviewingId) || Boolean(dismissingId),
              onPreview: setPreviewSession,
              onDismiss: dismissRunning,
              onReview: reviewCompleted,
              onReviewAll: reviewAllCompleted
            }))
          ) : null,
          previewSession ? React.createElement(ConversationPreview, { key: previewSession.sessionId, session: previewSession, onClose: () => setPreviewSession(null) }) : null
      );
    }

    function MonitorEntry(props) {
      const wide = props.wide === true;
      return React.createElement("button", {
          type: "button",
          className: wide ? "cdm-trigger" : "cdm-trigger cdm-rail",
          title: wide ? undefined : "会话看板",
          "aria-label": "打开会话看板",
          onClick: props.onOpen
        },
          React.createElement(MonitorIcon, null),
          wide ? React.createElement("span", { className: "cdm-triggerLabel" }, "会话看板") : null
      );
    }

    const RUNNING_CSS = `
      .cdm-runningEntry{display:grid;place-items:center;width:30px;height:30px;padding:6px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
      .cdm-runningEntry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .cdm-runningEntry>svg{width:16px;height:16px}
      .cdm-runningHead{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-divider-1,rgba(127,127,127,.2))}
      .cdm-runningHead>.cdm-title{font-size:13px}
      .cdm-runningList{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px;overflow-y:auto}
      .cdm-runningList>.cdm-card{min-width:0;padding:9px}
      .cdm-runningList .cdm-cardIdentity{margin-bottom:6px}
      .cdm-runningList .cdm-agentLogo{width:26px;height:26px}
      .cdm-runningList .cdm-agentLogo img{width:21px;height:21px}
      .cdm-runningList .cdm-cardActions{justify-content:flex-end}
      .cdm-runningList>.cdm-sourceWarning{font-size:12px;padding:2px 3px;overflow-wrap:anywhere}
      .cdm-runningPanel .cdm-preview{width:100%}
    `;

    function RunningPanel({ useTabInfo }) {
      const { tab } = useTabInfo();
      const active = tab.visible;
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState("");
      const [previewId, setPreviewId] = React.useState(null);

      React.useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        let loading = false;
        const load = async () => {
          if (loading || document.visibilityState === "hidden") return;
          loading = true;
          try {
            const next = await request("/codex-monitor/sessions", { signal: controller.signal });
            if (controller.signal.aborted) return;
            const sessions = next.sessions.filter((session) => session.status === "running");
            setSnapshot({ ...next, sessions });
            setPreviewId((id) => id && sessions.some((session) => session.sessionId === id) ? id : null);
            setError("");
          } catch (failure) {
            if (controller.signal.aborted) return;
            setPreviewId(null);
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            loading = false;
          }
        };
        load();
        const timer = window.setInterval(load, POLL_MS);
        document.addEventListener("visibilitychange", load);
        return () => {
          controller.abort();
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", load);
        };
      }, [active]);

      const sessions = error ? [] : snapshot?.sessions || [];
      const loading = !error && (!snapshot || (!snapshot.generatedAt && snapshot.refreshing));
      const unavailable = Object.entries(snapshot?.sources || {})
        .filter(([, source]) => source.status === "degraded" || source.status === "unavailable")
        .map(([key]) => PROVIDERS[key] || key);
      const preview = active && sessions.find((session) => session.sessionId === previewId);
      return React.createElement("section", { className: "cdm-panel cdm-runningPanel cdm-running", "aria-label": RUNNING_TAB_LABEL },
        React.createElement("header", { className: "cdm-runningHead" },
          React.createElement("h2", { className: "cdm-title" }, RUNNING_TAB_LABEL),
          snapshot && !loading && !error ? React.createElement("span", { className: "cdm-laneCount", "aria-live": "polite" }, String(sessions.length)) : null
        ),
        React.createElement("div", { className: "cdm-runningList", "aria-busy": loading },
          error ? React.createElement("div", { className: "cdm-sourceWarning", role: "status", title: error }, "暂时无法读取会话，正在重试") : null,
          !error && unavailable.length ? React.createElement("div", { className: "cdm-sourceWarning", role: "status" }, unavailable.join("、") + " 会话源暂不可用") : null,
          loading ? React.createElement("div", { className: "cdm-empty" }, "正在读取会话…") : null,
          !error && !loading && !sessions.length ? React.createElement("div", { className: "cdm-empty" }, "暂无正在执行的会话") : null,
          sessions.map((session) => React.createElement(SessionCard, {
            key: session.sessionId, session, compact: true, onPreview: () => setPreviewId(session.sessionId)
          }))
        ),
        preview ? React.createElement(ConversationPreview, { key: preview.sessionId, session: preview, onClose: () => setPreviewId(null) }) : null
      );
    }

    function openRunningTab(sidebar) {
      const sessionId = sidebar.mounted.getSnapshot();
      if (!sessionId) throw new Error("会话工作区尚未就绪，请稍后重试");
      const existing = sidebar.openTabs.getSnapshot().find((tab) => tab.sessionId === sessionId && tab.kind === RUNNING_TAB_KIND);
      if (!existing) sidebar.openTab(RUNNING_TAB_KIND);
      if (!sidebar.isExpanded()) sidebar.toggleExpanded();
      if (existing) sidebar.focus(existing.tabId);
    }

    const inject = ["slots", "layout", "sidebarRight", "sidebarRightTabs"];
    function apply(ctx) {
      function RunningEntry() {
        const [error, setError] = React.useState("");
        return React.createElement("button", {
          type: "button", className: "cdm-runningEntry", "aria-label": "在右侧栏打开运行中的会话",
          title: error || RUNNING_TAB_LABEL,
          onClick: () => {
            try {
              openRunningTab(ctx.sidebarRight);
              setError("");
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          }
        }, React.createElement(MonitorIcon, null));
      }

      const style = document.createElement("style");
      style.dataset.plugin = "codex-monitor/client";
      style.textContent = CSS + PREVIEW_CSS + RUNNING_CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "codex-monitor: stylesheet");
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: RUNNING_TAB_ID,
        kind: RUNNING_TAB_KIND,
        title: () => RUNNING_TAB_LABEL,
        guide: [{ id: RUNNING_TAB_KIND, order: 34, title: () => RUNNING_TAB_LABEL, icon: MonitorIcon,
          description: () => "查看 Codex、DSH、Kimi 和 Claude 正在执行的会话" }]
      }), "codex-monitor: running tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
        { name: "sidebar.right.pane.tab", key: RUNNING_TAB_ID }, RunningPanel
      )), "codex-monitor: running tab body");
      ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        { name: "conversation.session.header.actions", id: RUNNING_TAB_ID, order: 34 }, RunningEntry
      )), "codex-monitor: conversation entry");
      ctx.slots.inject("main", () => ctx.slots.register(
        { name: "main", key: MAIN_PANEL_ID, id: MAIN_PANEL_ID, label: "会话看板" },
        BoardPanel
      ));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
        { name: "sidebar.footer.action", id: "codex-monitor", order: -4, label: "会话看板" },
        (slotProps) => React.createElement(MonitorEntry, { ...slotProps, onOpen: () => ctx.layout.selectPanel(MAIN_PANEL_ID) })
      ));
    }

    exports.safeLink = safeLink;
    exports.MarkdownText = MarkdownText;
    exports.ConversationPreview = ConversationPreview;
    exports.SessionCard = SessionCard;
    exports.BoardPanel = BoardPanel;
    exports.apply = apply;
    exports.inject = inject;
    exports.reviewSelectedSessions = reviewSelectedSessions;
    return module.exports;
  }
});
