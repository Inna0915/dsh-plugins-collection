import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function dataHome(): string {
  return path.resolve(process.env.JIRA_FLOW_HOME || path.join(homedir(), '.jira-flow'));
}
export function validId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) || value.includes('..')) throw new Error('无效标识');
  return value;
}
export function issueKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(value))
    throw new Error('请输入有效 Jira 编号，例如 PROJ-123');
  return value.toUpperCase();
}
export function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rest = path.relative(path.resolve(root), target);
  if (rest.startsWith('..') || path.isAbsolute(rest)) throw new Error('文件路径超出任务包范围');
  return target;
}
export async function jsonRead<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function jsonWrite(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}
export async function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const file = path.join(dataHome(), 'locks', `${validId(name)}.lock`);
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  const deadline = Date.now() + 5000;
  while (!handle) {
    try {
      handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 10_000) {
        const owner = Number(await readFile(file, 'utf8').catch(() => '0'));
        let alive = true;
        try {
          if (owner > 0) process.kill(owner, 0);
        } catch {
          alive = false;
        }
        if (!alive) {
          await unlink(file).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error('另一操作正在写入，请稍后重试');
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  try {
    return await task();
  } finally {
    await handle.close();
    await unlink(file).catch(() => undefined);
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}
