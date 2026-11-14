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
      const labels = { dsh: "DSH", "kimi-vscode": "Kimi · VS Code", "kimi-cli": "Kimi · CLI", "kimi-desktop": "Kimi · Desktop", "kimi-unknown": "Kimi · 来源未记录", "claude-vscode": "Claude · VS Code", "claude-cli": "Claude · CLI", claude: "Claude", "agy-hub": "Antigravity · Hub", "agy-cli": "Antigravity · CLI" };
      if (labels[normalized]) return labels[normalized];
      return String(source);
    }

    const PROVIDERS = { codex: "Codex", dsh: "DSH", kimi: "Kimi", claude: "Claude", agy: "Antigravity" };
    // Official client assets, embedded for offline rendering. See assets/agent-logos/README.md.
    const AGENT_LOGOS = {"codex":"data:image/png;base64,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","dsh":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iNTAuMDAwMDAwIiBoZWlnaHQ9IjUwLjAwMDAwMCIgdmlld0JveD0iMCAwIDUwIDUwIiBmaWxsPSJub25lIj4KCTxwYXRoIGlkPSJwYXRoIiBkPSJNNDguODM1NCAxMC4wNDc5QzQ4LjMyMzIgOS43OTE5OSA0OC4xMDI1IDEwLjI3OTggNDcuODAzMiAxMC41Mjc4QzQ3LjcwMDcgMTAuNjA3OSA0Ny42MTQzIDEwLjcxMTkgNDcuNTI3MyAxMC44MDc2QzQ2Ljc3OTMgMTEuNjI0IDQ1LjkwNDggMTIuMTU5NyA0NC43NjIyIDEyLjA5NTdDNDMuMDkyMyAxMiA0MS42NjYgMTIuNTM1NiA0MC40MDU4IDEzLjgzOThDNDAuMTM3NyAxMi4yMzE5IDM5LjI0NzYgMTEuMjcyIDM3Ljg5MjYgMTAuNjU1OEMzNy4xODM2IDEwLjMzNTkgMzYuNDY2OCAxMC4wMTU2IDM1Ljk3MDIgOS4zMTk4MkMzNS42MjM1IDguODIzNzMgMzUuNTI5MyA4LjI3MTk3IDM1LjM1NiA3LjcyNzU0QzM1LjI0NTYgNy4zOTk5IDM1LjEzNTMgNy4wNjM5NiAzNC43NjUxIDcuMDA3ODFDMzQuMzYzMyA2Ljk0Mzg1IDM0LjIwNTYgNy4yODc2IDM0LjA0NzkgNy41NzU2OEMzMy40MTggOC43NTE5NSAzMy4xNzMzIDEwLjA0NzkgMzMuMTk3MyAxMS4zNTk5QzMzLjI1MjQgMTQuMzEyIDM0LjQ3MzYgMTYuNjY0MSAzNi44OTk5IDE4LjMzNTlDMzcuMTc1OCAxOC41Mjc4IDM3LjI0NjYgMTguNzE5NyAzNy4xNTk3IDE5QzM2Ljk5NDYgMTkuNTc1NyAzNi43OTc0IDIwLjEzNTcgMzYuNjI0IDIwLjcxMTlDMzYuNTEzNyAyMS4wODAxIDM2LjM0ODYgMjEuMTU5NyAzNS45NjI0IDIxQzM0LjYzMDkgMjAuNDMyMSAzMy40ODEgMTkuNTkxOCAzMi40NjQ0IDE4LjU3NTdDMzAuNzM5MyAxNi44NzIxIDI5LjE3OTIgMTQuOTkxNyAyNy4yMzM0IDEzLjUyQzI2Ljc3NjQgMTMuMTc1OCAyNi4zMTkzIDEyLjg1NiAyNS44NDY3IDEyLjU1MThDMjMuODYxOCAxMC41ODQgMjYuMTA2OSA4Ljk2Nzc3IDI2LjYyNyA4Ljc3NTg4QzI3LjE3MDQgOC41NzU2OCAyNi44MTU5IDcuODg3NyAyNS4wNTkxIDcuODk2QzIzLjMwMjIgNy45MDM4MSAyMS42OTUzIDguNTAzOTEgMTkuNjQ3IDkuMzAzNzFDMTkuMzQ3NyA5LjQyMzgzIDE5LjAzMjIgOS41MTE3MiAxOC43MDk1IDkuNTgzOThDMTYuODUwMSA5LjIyMzYzIDE0LjkxOTkgOS4xNDM1NSAxMi45MDMzIDkuMzc1OThDOS4xMDU5NiA5LjgwNzYyIDYuMDcyNzUgMTEuNjM5NiAzLjg0MzI2IDE0Ljc2ODFDMS4xNjQ1NSAxOC41Mjc4IDAuNTM0MTggMjIuNzk5OCAxLjMwNjY0IDI3LjI1NTlDMi4xMTc2OCAzMS45NTIxIDQuNDY1ODIgMzUuODM5OCA4LjA3MzczIDM4Ljg3OTlDMTEuODE1OSA0Mi4wMzIyIDE2LjEyNTUgNDMuNTc2MiAyMS4wNDEgNDMuMjgwM0MyNC4wMjY5IDQzLjEwNCAyNy4zNTE2IDQyLjY5NjMgMzEuMTAxNiAzOS40NTYxQzMyLjA0NjkgMzkuOTM2IDMzLjAzOTYgNDAuMTI3OSAzNC42ODYgNDAuMjcyQzM1Ljk1NDYgNDAuMzkyMSAzNy4xNzU4IDQwLjIwOCAzOC4xMjExIDQwLjAwNzhDMzkuNjAyMSAzOS42ODggMzkuNDk5NSAzOC4yODgxIDM4Ljk2MzkgMzguMDMyMkMzNC42MjMgMzUuOTY3OCAzNS41NzYyIDM2LjgwODEgMzQuNzEgMzYuMTI3OUMzNi45MTU1IDMzLjQ2MzkgNDAuMjQwMiAzMC42OTU4IDQxLjU0IDIxLjcyOEM0MS42NDI2IDIxLjAxNjEgNDEuNTU1NyAyMC41Njc5IDQxLjU0IDE5Ljk5MTdDNDEuNTMyMiAxOS42Mzk2IDQxLjYxMDggMTkuNTAzOSA0Mi4wMDQ5IDE5LjQ2MzlDNDMuMDkyMyAxOS4zMzU5IDQ0LjE0NzkgMTkuMDMxNyA0NS4xMTY3IDE4LjQ4NzhDNDcuOTI5MiAxNi45MTk5IDQ5LjA2NCAxNC4zNDM4IDQ5LjMzMTUgMTEuMjU1OUM0OS4zNzExIDEwLjc4MzcgNDkuMzIzNyAxMC4yOTU5IDQ4LjgzNTQgMTAuMDQ3OVpNMjQuMzI2MiAzNy44Mzk4QzIwLjExOTYgMzQuNDYzOSAxOC4wNzkxIDMzLjM1MjEgMTcuMjM1OCAzMy4zOTk5QzE2LjQ0ODIgMzMuNDQ4MiAxNi41ODk4IDM0LjM2ODIgMTYuNzYzMiAzNC45Njc4QzE2Ljk0NDMgMzUuNTYwMSAxNy4xODEyIDM1Ljk2ODMgMTcuNTExNyAzNi40ODc4QzE3Ljc0MDIgMzYuODMyIDE3Ljg5NzkgMzcuMzQ0MiAxNy4yODMyIDM3LjcyOEMxNS45MjgyIDM4LjU4NCAxMy41NzI4IDM3LjQzOTkgMTMuNDYyNCAzNy4zODM4QzEwLjcyMDcgMzUuNzM1OCA4LjQyODIyIDMzLjU2MDEgNi44MTM0OCAzMC41ODRDNS4yNTM0MiAyNy43MTk3IDQuMzQ3NjYgMjQuNjQ3OSA0LjE5Nzc1IDIxLjM2NzdDNC4xNTgyIDIwLjU3NTcgNC4zODY3MiAyMC4yOTU5IDUuMTU4NjkgMjAuMTUxOUM2LjE3NTI5IDE5Ljk2IDcuMjIzMTQgMTkuOTE5OSA4LjIzOTI2IDIwLjA3MThDMTIuNTMyNyAyMC43MTE5IDE2LjE4ODUgMjIuNjcxOSAxOS4yNTI5IDI1Ljc3NTlDMjEuMDAyIDI3LjU0MzkgMjIuMzI1MiAyOS42NTU4IDIzLjY4ODUgMzEuNzIwMkMyNS4xMzc3IDMzLjkxMjEgMjYuNjk3OCAzNiAyOC42ODMxIDM3LjcxMTlDMjkuMzg0MyAzOC4zMTIgMjkuOTQzNCAzOC43NjgxIDMwLjQ3OSAzOS4xMDRDMjguODY0MyAzOS4yODgxIDI2LjE2OTkgMzkuMzI4MSAyNC4zMjYyIDM3LjgzOThaTTI2LjM0MzMgMjQuNjAwMUMyNi4zNDMzIDI0LjI0OCAyNi42MTkxIDIzLjk2NzggMjYuOTY1OCAyMy45Njc4QzI3LjA0NDQgMjMuOTY3OCAyNy4xMTUyIDIzLjk4MzkgMjcuMTc4MiAyNC4wMDc4QzI3LjI2NTEgMjQuMDQgMjcuMzQzOCAyNC4wODc5IDI3LjQwNjcgMjQuMTYwMkMyNy41MTcxIDI0LjI3MiAyNy41ODAxIDI0LjQzMjEgMjcuNTgwMSAyNC42MDAxQzI3LjU4MDEgMjQuOTUyMSAyNy4zMDQyIDI1LjIzMTkgMjYuOTU3NSAyNS4yMzE5QzI2LjYxMDggMjUuMjMxOSAyNi4zNDMzIDI0Ljk1MjEgMjYuMzQzMyAyNC42MDAxWk0zMi42MDY0IDI3Ljg3OTlDMzIuMjA0NiAyOC4wNDc5IDMxLjgwMjcgMjguMTkxOSAzMS40MTY1IDI4LjIwOEMzMC44MTc5IDI4LjIzOTcgMzAuMTY0MSAyNy45OTIyIDI5LjgwOTYgMjcuNjg4QzI5LjI1ODMgMjcuMjE1OCAyOC44NjQzIDI2Ljk1MjEgMjguNjk4NyAyNi4xMjc5QzI4LjYyNzkgMjUuNzc1OSAyOC42Njc1IDI1LjIzMTkgMjguNzMwNSAyNC45MTk5QzI4Ljg3MjEgMjQuMjQ4IDI4LjcxNDQgMjMuODE1OSAyOC4yNDk1IDIzLjQyMzhDMjcuODcxNiAyMy4xMDQgMjcuMzkxMSAyMy4wMTYxIDI2Ljg2MzMgMjMuMDE2MUMyNi42NjYgMjMuMDE2MSAyNi40ODQ5IDIyLjkyNzcgMjYuMzUxMSAyMi44NTZDMjYuMTMwNCAyMi43NDQxIDI1Ljk0OTIgMjIuNDYzOSAyNi4xMjI2IDIyLjEyMDFDMjYuMTc3NyAyMi4wMDc4IDI2LjQ0NTggMjEuNzM1OCAyNi41MDg4IDIxLjY4OEMyNy4yMjU2IDIxLjI3MiAyOC4wNTI3IDIxLjQwNzcgMjguODE2OSAyMS43MTk3QzI5LjUyNTkgMjIuMDE2MSAzMC4wNjE1IDIyLjU2MDEgMzAuODM0IDIzLjMyODFDMzEuNjIxNiAyNC4yNTU5IDMxLjc2MzIgMjQuNTExNyAzMi4yMTI0IDI1LjIwOEMzMi41NjY5IDI1Ljc1MiAzMi44OTAxIDI2LjMxMiAzMy4xMTA0IDI2Ljk1MjFDMzMuMjQ0NiAyNy4zNTIxIDMzLjA3MTMgMjcuNjgwMiAzMi42MDY0IDI3Ljg3OTlaIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjEuMDAwMDAwIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz4KPC9zdmc+Cg==","kimi":"data:image/png;base64,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","claude":"data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkNsYXVkZTwvdGl0bGU+PHBhdGggZD0iTTQuNzA5IDE1Ljk1NWw0LjcyLTIuNjQ3LjA4LS4yMy0uMDgtLjEyOEg5LjJsLS43OS0uMDQ4LTIuNjk4LS4wNzMtMi4zMzktLjA5Ny0yLjI2Ni0uMTIyLS41NzEtLjEyMUwwIDExLjc4NGwuMDU1LS4zNTIuNDgtLjMyMS42ODYuMDYgMS41Mi4xMDMgMi4yNzguMTU4IDEuNjUyLjA5NyAyLjQ0OS4yNTVoLjM4OWwuMDU1LS4xNTctLjEzNC0uMDk4LS4xMDMtLjA5Ny0yLjM1OC0xLjU5Ni0yLjU1Mi0xLjY4OC0xLjMzNi0uOTcyLS43MjQtLjQ5MS0uMzY0LS40NjItLjE1OC0xLjAwOC42NTYtLjcyMi44ODEuMDYuMjI1LjA2MS44OTMuNjg2IDEuOTA4IDEuNDc2IDIuNDkxIDEuODMzLjM2NS4zMDQuMTQ1LS4xMDMuMDE5LS4wNzMtLjE2NC0uMjc0LTEuMzU1LTIuNDQ2LTEuNDQ2LTIuNDktLjY0NC0xLjAzMi0uMTctLjYxOWEyLjk3IDIuOTcgMCAwMS0uMTA0LS43MjlMNi4yODMuMTM0IDYuNjk2IDBsLjk5Ni4xMzQuNDIuMzY0LjYyIDEuNDE0IDEuMDAyIDIuMjI5IDEuNTU1IDMuMDMuNDU2Ljg5OC4yNDMuODMyLjA5MS4yNTVoLjE1OFY5LjAxbC4xMjgtMS43MDYuMjM3LTIuMDk1LjIzLTIuNjk1LjA4LS43Ni4zNzYtLjkxLjc0Ny0uNDkyLjU4NC4yOC40OC42ODUtLjA2Ny40NDQtLjI4NiAxLjg1MS0uNTU5IDIuOTAzLS4zNjQgMS45NDJoLjIxMmwuMjQzLS4yNDIuOTg1LTEuMzA2IDEuNjUyLTIuMDY0LjczLS44Mi44NS0uOTA0LjU0Ny0uNDMxaDEuMDMzbC43NiAxLjEyOS0uMzQgMS4xNjYtMS4wNjQgMS4zNDctLjg4MSAxLjE0Mi0xLjI2NCAxLjctLjc5IDEuMzYuMDczLjExLjE4OC0uMDIgMi44NTYtLjYwNiAxLjU0My0uMjggMS44NDEtLjMxNS44MzMuMzg4LjA5MS4zOTUtLjMyOC44MDctMS45NjkuNDg2LTIuMzA5LjQ2Mi0zLjQzOS44MTMtLjA0Mi4wMy4wNDkuMDYxIDEuNTQ5LjE0Ni42NjIuMDM2aDEuNjIybDMuMDIuMjI1Ljc5LjUyMi40NzQuNjM4LS4wNzkuNDg1LTEuMjE1LjYyLTEuNjQtLjM4OS0zLjgyOS0uOTEtMS4zMTItLjMyOWgtLjE4MnYuMTFsMS4wOTMgMS4wNjggMi4wMDYgMS44MSAyLjUwOSAyLjMzLjEyNy41NzgtLjMyMi40NTUtLjM0LS4wNDktMi4yMDUtMS42NTctLjg1MS0uNzQ3LTEuOTI2LTEuNjJoLS4xMjh2LjE3bC40NDQuNjQ5IDIuMzQ1IDMuNTIxLjEyMiAxLjA4LS4xNy4zNTMtLjYwOC4yMTMtLjY2OC0uMTIyLTEuMzc0LTEuOTI1LTEuNDE1LTIuMTY3LTEuMTQzLTEuOTQzLS4xNC4wOC0uNjc0IDcuMjU0LS4zMTYuMzctLjcyOS4yOC0uNjA3LS40NjEtLjMyMi0uNzQ3LjMyMi0xLjQ3Ni4zODktMS45MjQuMzE1LTEuNTMuMjg2LTEuOS4xNy0uNjMyLS4wMTItLjA0Mi0uMTQuMDE4LTEuNDM0IDEuOTY3LTIuMTggMi45NDUtMS43MjYgMS44NDUtLjQxNC4xNjQtLjcxNy0uMzcuMDY3LS42NjIuNDAxLS41ODkgMi4zODgtMy4wMzYgMS40NC0xLjg4Mi45My0xLjA4Ni0uMDA2LS4xNThoLS4wNTVMNC4xMzIgMTguNTZsLTEuMTMuMTQ2LS40ODctLjQ1Ni4wNjEtLjc0Ni4yMzEtLjI0MyAxLjkwOC0xLjMxMi0uMDA2LjAwNnoiIGZpbGw9IiNEOTc3NTciIGZpbGwtcnVsZT0ibm9uemVybyI+PC9wYXRoPjwvc3ZnPg==","agy":"data:image/png;base64,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"};
    function providerOf(session) {
      if (session.provider) return session.provider;
      const prefix = String(session.sessionId || "").split(":")[0];
      return prefix === "kimi-cli" ? "kimi" : PROVIDERS[prefix] ? prefix : "codex";
    }

    function agentClientLabel(session) {
      const labels = { app: "桌面应用", codex_app: "桌面应用", vscode: "VS Code", cli: "CLI", exec: "Exec", dsh: "DeepSeek Harness",
        "kimi-vscode": "VS Code", "kimi-cli": "CLI", "kimi-desktop": "桌面应用", "kimi-unknown": "来源未记录",
        "claude-vscode": "VS Code", "claude-cli": "CLI", claude: "客户端", "agy-hub": "agy Hub", "agy-cli": "CLI" };
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
              React.createElement("span", { className: "cdm-subtitle" }, "Codex · DSH · Kimi · Claude · Antigravity")
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
          description: () => "查看 Codex、DSH、Kimi、Claude 和 Antigravity 正在执行的会话" }]
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
