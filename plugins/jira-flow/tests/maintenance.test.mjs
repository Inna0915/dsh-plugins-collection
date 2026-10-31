import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { dailyMaintenance, staleExports } from '../dist/test-exports.js';

const DAY = 24 * 60 * 60 * 1000;
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function withHome(task) {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const home = await mkdtemp(path.resolve('.task-temp', 'maintenance-test-'));
  const old = process.env.JIRA_FLOW_HOME;
  process.env.JIRA_FLOW_HOME = home;
  try {
    await task(home);
  } finally {
    if (old === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old;
    assert.ok(home.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(home, { recursive: true, force: true });
  }
}
async function file(home, relative, ageDays, now) {
  const target = path.join(home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'fixture');
  const time = new Date(now.getTime() - ageDays * DAY);
  await utimes(target, time, time);
  return target;
}

test('每天首次调用只清理过期回执，任务包与结果保留；同日与其他进程已执行时跳过', async () => {
  await withHome(async (home) => {
    const now = new Date(2026, 10, 2, 9, 0, 0);
    const oldReceipt = await file(home, 'operations/old.json', 40, now);
    const newReceipt = await file(home, 'operations/new.json', 3, now);
    const oldUpload = await file(home, 'uploads/old.json', 31, now);
    const result = await file(home, 'results/old.json', 90, now);
    const exported = await file(home, 'exports/batch/combined.md', 90, now);
    const staleMarker = await file(home, 'maintenance/2026-10-01', 32, now);

    assert.deepEqual(await dailyMaintenance(now), { ran: true, removed: 3 });
    assert.equal(await exists(oldReceipt), false);
    assert.equal(await exists(oldUpload), false);
    assert.equal(await exists(staleMarker), false);
    assert.equal(await exists(newReceipt), true);
    assert.equal(await exists(result), true);
    assert.equal(await exists(exported), true);
    assert.equal(await exists(path.join(home, 'maintenance/2026-11-02')), true);

    const later = await file(home, 'operations/later.json', 40, now);
    assert.deepEqual(await dailyMaintenance(new Date(2026, 10, 2, 18, 0, 0)), { ran: false, removed: 0 });
    assert.equal(await exists(later), true);

    const nextDay = new Date(2026, 10, 3, 9, 0, 0);
    await file(home, 'maintenance/2026-11-03', 0, nextDay);
    assert.deepEqual(await dailyMaintenance(nextDay), { ran: false, removed: 0 });
    assert.equal(await exists(later), true);
  });
});

test('任务包清单只列出超龄、孤立和目录缺失的任务包，不删除', async () => {
  await withHome(async (home) => {
    const now = new Date(2026, 10, 2, 9, 0, 0);
    const age = async (relative, days) => {
      const time = new Date(now.getTime() - days * DAY);
      await utimes(path.join(home, relative), time, time);
    };
    await file(home, 'exports/old/combined.md', 40, now);
    await age('exports/old', 40);
    await file(home, 'exports/fresh/combined.md', 2, now);
    await file(home, 'exports/orphan/combined.md', 50, now);
    await age('exports/orphan', 50);
    const write = (id, directory) =>
      writeFile(
        path.join(home, 'packages', `${id}.json`),
        JSON.stringify({ id, directory, profile: 'test' }),
      );
    await mkdir(path.join(home, 'packages'), { recursive: true });
    await write('old', path.join(home, 'exports/old'));
    await write('fresh', path.join(home, 'exports/fresh'));
    await write('gone', path.join(home, 'exports/gone'));

    const result = await staleExports(30, now.getTime());
    assert.deepEqual(
      result.packages.map((row) => [row.id || 'orphan', row.indexed, row.missing, row.ageDays]),
      [
        ['orphan', false, false, 50],
        ['old', true, false, 40],
        ['gone', true, true, 0],
      ],
    );
    assert.equal(result.totalBytes, 'fixture'.length * 2);
    assert.match(result.markdown, /只列出，不删除/);
    assert.equal(await exists(path.join(home, 'exports/old/combined.md')), true);
  });
});
