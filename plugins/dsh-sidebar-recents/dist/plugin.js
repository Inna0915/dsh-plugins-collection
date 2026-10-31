// src/plugin.js
import { writeFileSync } from "node:fs";
var inject = [];
function apply(ctx) {
  const receiptPath = new URL("../runtime-status.json", import.meta.url);
  const activatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const writeReceipt = (active) => writeFileSync(receiptPath, JSON.stringify({
    plugin: "dsh-sidebar-recents",
    version: "0.1.7",
    pid: process.pid,
    active,
    activatedAt,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2), "utf8");
  ctx.effect(() => {
    writeReceipt(true);
    return () => writeReceipt(false);
  }, "sidebar-recents: local lifecycle receipt");
}
export {
  apply,
  inject
};
