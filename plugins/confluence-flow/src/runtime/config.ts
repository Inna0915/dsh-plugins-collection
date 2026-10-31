import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  dataHome,
  dataFile,
  validId,
  pageId,
  jsonRead,
  jsonWrite,
  atomicWrite,
  withLock,
} from "./store.js";
import type { Auth, Profile } from "../types.js";

export const installationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const credentialFile = (id: string) =>
  path.join(dataHome(), "credentials", `${validId(id)}.dpapi`);
export function normalizeProfile(input: Partial<Profile>): Profile {
  const url = new URL(input.host || "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("请输入不包含账号密码的 Confluence 地址");
  }
  const targets = input.targets || {};
  for (const [name, id] of Object.entries(targets)) {
    if (!name.trim()) {
      throw new Error("发布位置名称不能为空");
    }
    pageId(id);
  }
  return {
    id: validId(input.id || "work-confluence"),
    name: input.name?.trim() || "工作 Confluence",
    host: url.toString().replace(/\/+$/, ""),
    rootPageIds: (input.rootPageIds || []).map(pageId),
    spaceKey: input.spaceKey?.trim() || "",
    targets,
    allowWrites: input.allowWrites === true,
    credentialStore:
      input.credentialStore === "environment" ? "environment" : "windows-dpapi",
  };
}
export async function profiles(): Promise<Profile[]> {
  const names = await readdir(path.join(dataHome(), "profiles")).catch(
    () => [] as string[],
  );
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => getProfile(name.slice(0, -5))),
  );
}
export async function getProfile(id = "work-confluence"): Promise<Profile> {
  try {
    return normalizeProfile(await jsonRead<Profile>(dataFile("profiles", id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`连接 ${id} 尚未配置，请先导入 Obsidian 设置`);
    }
    throw error;
  }
}
async function crypt(
  mode: "protect" | "unprotect",
  input: string,
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error(
      "此连接需要原 Windows 用户；其他系统可使用 environment 凭据",
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(installationRoot, "scripts", "credential-store.ps1"),
        "-Mode",
        mode,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => child.kill(), 15_000);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (data) => {
      output += data;
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("无法启动 Windows 凭据保护程序"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error("凭据保护失败，请用原 Windows 用户重新导入"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
export async function saveProfile(
  input: Partial<Profile>,
  auth?: Auth,
): Promise<Profile> {
  const profile = normalizeProfile(input);
  if (
    auth &&
    (!auth.secret ||
      !["basic", "bearer"].includes(auth.kind) ||
      (auth.kind === "basic" && !auth.username))
  ) {
    throw new Error("认证信息不完整");
  }
  await withLock(`profile-${profile.id}`, async () => {
    if (auth) {
      if (profile.credentialStore !== "windows-dpapi") {
        throw new Error("环境变量凭据不能通过页面保存");
      }
      await atomicWrite(
        credentialFile(profile.id),
        await crypt("protect", JSON.stringify(auth)),
      );
    }
    await jsonWrite(dataFile("profiles", profile.id), profile);
  });
  return profile;
}
export async function getAuth(profile: Profile): Promise<Auth> {
  const raw =
    profile.credentialStore === "environment"
      ? process.env[
          `CONFLUENCE_FLOW_AUTH_${profile.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`
        ]
      : await crypt(
          "unprotect",
          await readFile(credentialFile(profile.id), "utf8").catch(() => {
            throw new Error("凭据不存在，请重新导入连接");
          }),
        );
  if (!raw) {
    throw new Error("没有设置此连接的认证环境变量");
  }
  let auth: Auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error("认证格式无效");
  }
  if (
    !auth.secret ||
    !["basic", "bearer"].includes(auth.kind) ||
    (auth.kind === "basic" && !auth.username)
  ) {
    throw new Error("认证信息不完整");
  }
  return auth;
}
export async function importObsidian(
  source: string,
  allowWrites = false,
): Promise<Profile> {
  const data = await jsonRead<Record<string, any>>(path.resolve(source));
  if (!data.confluenceBaseUrl || !data.username || !data.password) {
    throw new Error("文件不是已配置的 Confluence Sync 设置");
  }
  const rootPageIds = String(data.rootPageIds || "")
    .split(/[\s,，]+/)
    .filter(Boolean);
  return saveProfile(
    {
      id: "work-confluence",
      host: data.confluenceBaseUrl,
      rootPageIds,
      spaceKey: data.spaceKey || "",
      allowWrites,
    },
    { kind: "basic", username: data.username, secret: data.password },
  );
}
