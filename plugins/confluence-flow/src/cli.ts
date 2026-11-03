#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ConfluenceService } from "./runtime/service.js";
import type { DeleteAuthorization, DeleteTarget } from "./runtime/deletes.js";
import { importObsidian, saveProfile, getProfile } from "./runtime/config.js";
import { installSkills } from "./runtime/skills.js";
import { startMcp } from "./runtime/mcp.js";
import { serve } from "./runtime/http.js";
import { message } from "./runtime/store.js";

const help = `Confluence Flow 0.6.0
  confluence-flow call --input request.json [--wiki-file content.wiki]
  confluence-flow read --page ID_OR_URL [--grep IDOC --context 120] [--head 30] [--format wiki|outline|full]
  confluence-flow read --snapshot-id SNAPSHOT_ID --offset NEXT_OFFSET
  confluence-flow scan --pages ID1,ID2,ID3 --grep IDOC
  confluence-flow scan --scan-id SCAN_ID --start NEXT_START
  confluence-flow read --pages ID1,ID2 [--max-bytes 8192]
  confluence-flow search --query 关键词 [--match all|any|phrase] [--parent ID] [--space KEY] [--label LABEL]
  confluence-flow create --parent ID --title 标题 --wiki-file content.wiki
  confluence-flow update --page ID --expected-version N --mode replace-section --section-id r1-s1 --wiki-file content.wiki
  confluence-flow update --page ID --expected-version N --mode replace-page --storage-file content.xhtml
  confluence-flow commit --draft-id ID --request-id UNIQUE_ID
  confluence-flow upload --page ID --files A.png,B.drawio [--comment 备注] [--apply --request-id UNIQUE_ID]
  confluence-flow move --page ID --parent NEW_PARENT_ID [--expected-version N] [--apply --request-id UNIQUE_ID]
  confluence-flow delete-preview --page ID [--keep-root true]
  confluence-flow delete --page ID --token TOKEN --title 根页标题 --count N --request-id UNIQUE_ID
  confluence-flow restore --delete-request-id ID [--apply --request-id UNIQUE_ID]
  confluence-flow profiles | doctor | children --page ID | attachments --page ID
  confluence-flow operation-status --request-id UNIQUE_ID
  confluence-flow auth import-obsidian --source PATH [--enable-writes]
  confluence-flow auth writes --enabled true|false [--profile NAME]
  confluence-flow skills install [--output PATH]
  confluence-flow mcp
  confluence-flow serve [--port 43138]

create/update/upload/move 默认仅预览。提交需明确用户指令；apply=true 时必须提供 requestId。
upload 的 --files 以英文逗号分隔，相对路径按当前目录解析；同名附件上传为新版本。
move 把页面连同子页面移到同空间的新父页下，正文不变，页面产生一个小改动版本。
delete 把子树移到回收站，须先 delete-preview，并在交互式终端输入根页标题确认；agent 请用 confluence_flow_delete 工具。
参数 --input 接受 JSON 文件，--wiki-file 读取 UTF-8 wiki，避免多行 shell 转义。
--storage-file 读取 UTF-8 storage（XHTML），与 wiki 二选一，用于合并单元格等 wiki 无法表达的格式，提交前经服务器解析校验。
读取默认使用五分钟缓存与 8 KiB JSON 预算；--refresh 强制最新。full 为显式完整输出。
`;
/** CLI 删除由用户在交互式终端输入根页标题确认；非交互调用（agent 经 Skill 脚本执行）一律拒绝。 */
async function terminalConfirm(
  target: DeleteTarget,
  signal: AbortSignal,
): Promise<DeleteAuthorization> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "CLI 删除需要用户在交互式终端中输入标题确认，未删除任何页面；agent 请改用 confluence_flow_delete 工具（DSH 或 MCP），由宿主确认",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const scope = target.keepRoot
      ? `《${target.title}》下的全部子页面共 ${target.count} 页（保留该页面本身）`
      : `《${target.title}》${target.count > 1 ? `及其全部子页面共 ${target.count} 页` : ""}`;
    const answer = await prompt.question(
      `将把${scope}移到回收站（空间 ${target.spaceKey}）。\n输入根页面标题确认，其他输入取消：`,
      { signal },
    );
    if (answer.trim() !== target.title.trim()) {
      throw new Error("输入与标题不一致，已取消，未删除任何页面");
    }
    return { method: "terminal" };
  } finally {
    prompt.close();
  }
}
function options(args: string[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`未知参数 ${key}`);
    }
    const equalAt = key.indexOf("=");
    const name = (equalAt >= 0 ? key.slice(2, equalAt) : key.slice(2)).replace(
      /-([a-z])/g,
      (_, letter: string) => letter.toUpperCase(),
    );
    const next = args[index + 1];
    result[name] =
      equalAt >= 0
        ? key.slice(equalAt + 1)
        : next && !next.startsWith("--")
          ? args[++index]
          : true;
  }
  return result;
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (command === "mcp") {
    await startMcp();
    return;
  }
  if (command === "serve") {
    const args = options(rest);
    const app = await serve(Number(args.port || 43138));
    process.stdout.write(
      `Confluence 文档：http://127.0.0.1:${(app.server.address() as any).port}\n`,
    );
    process.once("SIGINT", () => void app.close());
    process.once("SIGTERM", () => void app.close());
    return;
  }
  if (command === "skills" && rest[0] === "install") {
    process.stdout.write(
      JSON.stringify(
        await installSkills(options(rest.slice(1)).output),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (command === "auth") {
    const [action, ...raw] = rest;
    const args = options(raw);
    let result;
    if (action === "import-obsidian") {
      result = await importObsidian(
        String(args.source || ""),
        args.enableWrites === true || args.enableWrites === "true",
      );
    } else if (action === "writes") {
      if (!["true", "false"].includes(args.enabled)) {
        throw new Error("--enabled 必须是 true 或 false");
      }
      result = await saveProfile({
        ...(await getProfile(args.profile)),
        allowWrites: args.enabled === "true",
      });
    } else {
      throw new Error("不支持的 auth 操作");
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const args = options(rest);
  let input: Record<string, any> = args.input
    ? JSON.parse(await readFile(String(args.input), "utf8"))
    : {};
  const { input: inputPath, wikiFile, storageFile, ...flags } = args;
  input = {
    ...input,
    ...flags,
    operation: command === "call" ? input.operation : command,
  };
  if (wikiFile) {
    input.wiki = await readFile(String(wikiFile), "utf8");
  }
  if (storageFile) {
    input.storage = await readFile(String(storageFile), "utf8");
  }
  if (typeof input.pages === "string") {
    input.pages = input.pages.split(/[,，\s]+/).filter(Boolean);
  }
  // 文件名可能含空格或中文逗号，只按英文逗号/换行切分；命令行允许相对路径，工具调用仍要求绝对路径。
  if (typeof input.files === "string") {
    input.files = input.files
      .split(/[,\n]/)
      .map((file: string) => file.trim())
      .filter(Boolean);
  }
  if (Array.isArray(input.files)) {
    input.files = input.files.map((file: unknown) =>
      typeof file === "string" ? path.resolve(file) : file,
    );
  }
  for (const key of [
    "start",
    "limit",
    "expectedVersion",
    "context",
    "offset",
    "matchOffset",
    "maxMatches",
    "head",
    "maxBytes",
    "count",
  ]) {
    if (input[key] !== undefined) {
      input[key] = Number(input[key]);
    }
  }
  for (const key of ["raw", "apply", "caseSensitive", "refresh", "keepRoot"]) {
    if (input[key] !== undefined) {
      if (![true, false, "true", "false"].includes(input[key])) {
        throw new Error(`${key} 必须是 true 或 false`);
      }
      input[key] = input[key] === true || input[key] === "true";
    }
  }
  const service = new ConfluenceService();
  const controller = new AbortController();
  const deleting = input.operation === "delete";
  // 删除含终端确认与逐页请求，放宽到 10 分钟。
  const timer = setTimeout(
    () => controller.abort(),
    deleting ? 600_000 : 120_000,
  );
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let result;
    if (deleting) {
      const { operation, ...rest } = input;
      result = await service.executeDelete(
        rest,
        (target) => terminalConfirm(target, controller.signal),
        controller.signal,
      );
    } else {
      result = await service.execute(input, controller.signal);
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    clearTimeout(timer);
    service.dispose();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((error) => {
  process.stderr.write(message(error).slice(0, 2000) + "\n");
  process.exitCode = 1;
});
