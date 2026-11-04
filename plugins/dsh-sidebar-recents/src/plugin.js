import { writeFileSync } from 'node:fs';

export const inject = [];

// Record the real host lifecycle so installation can be checked without
// controlling the user's window or reading their conversation contents.
export function apply(ctx) {
  const receiptPath = new URL('../runtime-status.json', import.meta.url);
  const activatedAt = new Date().toISOString();
  const writeReceipt = (active) => writeFileSync(receiptPath, JSON.stringify({
    plugin: 'dsh-sidebar-recents',
    version: '0.1.8',
    pid: process.pid,
    active,
    activatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  ctx.effect(() => {
    writeReceipt(true);
    return () => writeReceipt(false);
  }, 'sidebar-recents: local lifecycle receipt');
}
