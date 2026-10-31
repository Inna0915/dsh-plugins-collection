import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export function dataHome(): string {
  return path.resolve(
    process.env.CONFLUENCE_FLOW_HOME ||
      path.join(homedir(), ".confluence-flow"),
  );
}
export function validId(value: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("无效标识");
  }
  return value;
}
export function pageId(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error("页面 ID 必须是数字");
  }
  return value;
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function dataFile(folder: string, id: string): string {
  return path.join(dataHome(), folder, `${validId(id)}.json`);
}
export async function jsonRead<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      fallback !== undefined
    ) {
      return fallback;
    }
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
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}
export async function withLock<T>(
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const file = dataFile("locks", name);
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  const deadline = Date.now() + 5000;
  while (!handle) {
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number(await readFile(file, "utf8").catch(() => "0"));
      if (owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(file).catch(() => undefined);
            continue;
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error("另一操作正在提交，请稍后查询操作状态");
      }
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
  return error instanceof Error ? error.message : "操作失败";
}
