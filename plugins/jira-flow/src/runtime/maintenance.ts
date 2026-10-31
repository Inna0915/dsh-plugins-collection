import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataHome, jsonRead } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
// Write receipts guard request IDs; a month covers any realistic retry. Export packages are user
// deliverables and are only listed by staleExports, never removed here.
export const retentionDays: Record<string, number> = { operations: 30, uploads: 30 };
let checked = '';

function localDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
async function prune(directory: string, cutoff: number, keep = ''): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const removed = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name !== keep)
      .map(async (entry) => {
        const file = path.join(directory, entry.name);
        try {
          if ((await stat(file)).mtimeMs >= cutoff) return 0;
          await unlink(file);
          return 1;
        } catch {
          return 0;
        }
      }),
  );
  return removed.reduce<number>((sum, value) => sum + value, 0);
}
// Runs before the first operation of each local day. Repeat calls in a process cost nothing; across
// processes an exclusive per-day marker lets exactly one caller prune. Failures never block the caller.
export async function dailyMaintenance(now = new Date()): Promise<{ ran: boolean; removed: number }> {
  const day = localDay(now);
  const home = dataHome();
  if (checked === `${home}|${day}`) return { ran: false, removed: 0 };
  checked = `${home}|${day}`;
  const markers = path.join(home, 'maintenance');
  try {
    await mkdir(markers, { recursive: true });
    await writeFile(path.join(markers, day), '', { flag: 'wx' });
  } catch {
    return { ran: false, removed: 0 };
  }
  try {
    const counts = await Promise.all([
      ...Object.entries(retentionDays).map(([folder, days]) =>
        prune(path.join(home, folder), now.getTime() - days * DAY),
      ),
      prune(markers, Number.POSITIVE_INFINITY, day),
    ]);
    return { ran: true, removed: counts.reduce((sum, value) => sum + value, 0) };
  } catch {
    return { ran: true, removed: 0 };
  }
}

async function usage(target: string): Promise<{ bytes: number; files: number; modified: number }> {
  const info = await stat(target);
  if (!info.isDirectory()) return { bytes: info.size, files: 1, modified: info.mtimeMs };
  const total = { bytes: 0, files: 0, modified: info.mtimeMs };
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const child = await usage(path.join(target, entry.name));
    total.bytes += child.bytes;
    total.files += child.files;
    total.modified = Math.max(total.modified, child.modified);
  }
  return total;
}
// Read-only overview of export packages not touched for olderThanDays, for the user to decide on.
export async function staleExports(olderThanDays = 30, now = Date.now()) {
  const registry = path.join(dataHome(), 'packages');
  const indexed = new Set<string>();
  const rows: Array<{
    id: string;
    directory: string;
    profile: string;
    indexed: boolean;
    missing: boolean;
    modified: string;
    ageDays: number;
    bytes: number;
    files: number;
  }> = [];
  const add = async (id: string, directory: string, profile: string, inRegistry: boolean) => {
    const parts = await Promise.all(
      [directory, `${directory}.zip`].map((target) => usage(target).catch(() => undefined)),
    );
    const found = parts.filter((part): part is NonNullable<typeof part> => part !== undefined);
    const modified = Math.max(0, ...found.map((part) => part.modified));
    if (found.length && now - modified < olderThanDays * DAY) return;
    rows.push({
      id,
      directory,
      profile,
      indexed: inRegistry,
      missing: !found.length,
      modified: found.length ? new Date(modified).toISOString() : '',
      ageDays: found.length ? Math.floor((now - modified) / DAY) : 0,
      bytes: found.reduce((sum, part) => sum + part.bytes, 0),
      files: found.reduce((sum, part) => sum + part.files, 0),
    });
  };
  const names = await readdir(registry).catch(() => [] as string[]);
  for (const name of names.filter((value) => value.endsWith('.json'))) {
    const record = await jsonRead<{ id?: string; directory?: string; profile?: string } | null>(
      path.join(registry, name),
      null,
    ).catch(() => null);
    if (!record?.directory) continue;
    const directory = path.resolve(record.directory);
    indexed.add(directory);
    await add(record.id || name.slice(0, -5), directory, record.profile || '', true);
  }
  const exportsRoot = path.join(dataHome(), 'exports');
  for (const entry of await readdir(exportsRoot, { withFileTypes: true }).catch(() => [])) {
    const directory = path.join(exportsRoot, entry.name);
    if (entry.isDirectory() && !indexed.has(directory)) await add('', directory, '', false);
  }
  rows.sort((a, b) => b.ageDays - a.ageDays);
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const markdown = [
    `# ${olderThanDays} 天未改动的任务包（只列出，不删除）`,
    '',
    `共 ${rows.length} 个，${size(totalBytes)}。删除前确认没有 agent 或看板还在使用。`,
    '',
    ...(rows.length
      ? [
          '| 任务包 | 天数 | 大小 | 文件 | 目录 |',
          '|---|---|---|---|---|',
          ...rows.map(
            (row) =>
              `| ${row.id || '（无索引）'} | ${row.missing ? '目录已不存在' : row.ageDays} | ${size(row.bytes)} | ${row.files} | ${row.directory} |`,
          ),
        ]
      : ['无']),
  ].join('\n');
  return { olderThanDays, count: rows.length, totalBytes, packages: rows, markdown };
}
