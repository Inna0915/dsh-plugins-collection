import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dailyMaintenance } from "../dist/test-exports.js";

const DAY = 24 * 60 * 60 * 1000;
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

test("每天首次调用清理过期读取底稿与回执，凭证和配置不动；同日与其他进程已执行时跳过", async () => {
  await mkdir(path.resolve(".task-temp"), { recursive: true });
  const home = await mkdtemp(path.resolve(".task-temp", "maintenance-test-"));
  const old = process.env.CONFLUENCE_FLOW_HOME;
  process.env.CONFLUENCE_FLOW_HOME = home;
  const now = new Date(2026, 10, 2, 9, 0, 0);
  const file = async (relative, ageDays, at = now) => {
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "fixture");
    const time = new Date(at.getTime() - ageDays * DAY);
    await utimes(target, time, time);
    return target;
  };
  try {
    const expired = await Promise.all([
      file("snapshots/old.json", 8),
      file("scans/old.json", 8),
      file("read-cache/old.json", 8),
      file("drafts/old.json", 8),
      file("operations/old.json", 31),
      file("maintenance/2026-10-01", 32),
    ]);
    const kept = await Promise.all([
      file("snapshots/recent.json", 2),
      file("operations/recent.json", 20),
      file("credentials/work.dpapi", 400),
      file("profiles/work.json", 400),
    ]);

    assert.deepEqual(await dailyMaintenance(now), { ran: true, removed: 6 });
    for (const target of expired) assert.equal(await exists(target), false);
    for (const target of kept) assert.equal(await exists(target), true);

    const later = await file("snapshots/later.json", 8);
    assert.deepEqual(await dailyMaintenance(new Date(2026, 10, 2, 20, 0, 0)), {
      ran: false,
      removed: 0,
    });
    const nextDay = new Date(2026, 10, 3, 9, 0, 0);
    await file("maintenance/2026-11-03", 0, nextDay);
    assert.deepEqual(await dailyMaintenance(nextDay), {
      ran: false,
      removed: 0,
    });
    assert.equal(await exists(later), true);
  } finally {
    if (old === undefined) delete process.env.CONFLUENCE_FLOW_HOME;
    else process.env.CONFLUENCE_FLOW_HOME = old;
    assert.ok(home.startsWith(path.resolve(".task-temp") + path.sep));
    await rm(home, { recursive: true, force: true });
  }
});
