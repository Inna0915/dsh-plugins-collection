import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConfluenceClient, ConfluenceError } from "../core/confluence.js";
import type { Attachment } from "../types.js";
import {
  dataFile,
  hash,
  jsonRead,
  jsonWrite,
  message,
  validId,
  withLock,
} from "./store.js";

const MAX_FILES = 10;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_BATCH = 100 * 1024 * 1024;

interface FileKind {
  mediaType: string;
  extensions: string[];
  matches(bytes: Uint8Array): boolean;
}
// 统一用 Uint8Array：本项目的 @types/node 与 TS 5.9 的泛型 Uint8Array 定义不兼容 Buffer。
const leading = (bytes: Uint8Array, size: number) =>
  String.fromCharCode(...bytes.subarray(0, size));
const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((value, index) => bytes[index] === value);
// TextDecoder 默认去掉 UTF-8 BOM。
const xmlHead = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
const zipped = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 3, 4]);
// 只放行文档常用格式，并用文件头确认内容与扩展名一致，避免误传其他本机文件。
const KINDS: FileKind[] = [
  {
    mediaType: "image/png",
    extensions: [".png"],
    matches: (b) => startsWith(b, [137, 80, 78, 71, 13, 10, 26, 10]),
  },
  {
    mediaType: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mediaType: "image/gif",
    extensions: [".gif"],
    matches: (b) => /^GIF8[79]a$/.test(leading(b, 6)),
  },
  {
    mediaType: "image/webp",
    extensions: [".webp"],
    matches: (b) =>
      leading(b, 4) === "RIFF" && leading(b.subarray(8), 4) === "WEBP",
  },
  {
    mediaType: "image/bmp",
    extensions: [".bmp"],
    matches: (b) => leading(b, 2) === "BM",
  },
  {
    mediaType: "image/svg+xml",
    extensions: [".svg"],
    matches: (b) =>
      /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
        xmlHead(b),
      ),
  },
  {
    // 与浏览器上传 .drawio 时的类型一致。
    mediaType: "application/octet-stream",
    extensions: [".drawio"],
    matches: (b) => /^(<\?xml[^>]*>\s*)?<mxfile[\s>]/.test(xmlHead(b)),
  },
  {
    mediaType: "application/pdf",
    extensions: [".pdf"],
    matches: (b) => leading(b, 5) === "%PDF-",
  },
  {
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    matches: zipped,
  },
  {
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    matches: zipped,
  },
  {
    mediaType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    matches: zipped,
  },
];
const SUPPORTED = KINDS.flatMap((kind) => kind.extensions).join("/");

interface UploadManifest {
  path: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
}
interface PreparedFile extends UploadManifest {
  bytes: Uint8Array;
}
type UploadState = "pending" | "uploading" | "uploaded" | "failed" | "unknown";
interface UploadFile extends UploadManifest {
  state: UploadState;
  action?: "create" | "new-version";
  attachment?: Attachment;
  error?: string;
}
interface UploadBatch {
  kind: "upload";
  requestId: string;
  profile: string;
  host: string;
  pageId: string;
  title: string;
  comment: string;
  status: "pending" | "complete" | "failed" | "unknown";
  files: UploadFile[];
}

/** 校验本机绝对路径；同批文件名不能重复，否则无法判断各自对应的附件。 */
export function uploadPaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FILES) {
    throw new Error(`请提供 1 至 ${MAX_FILES} 个本机文件路径（files）`);
  }
  const paths = input.map((file) => {
    if (
      typeof file !== "string" ||
      !path.isAbsolute(file) ||
      /^[/\\]{2}/.test(file)
    ) {
      throw new Error(
        "附件必须是本机文件的绝对路径，不接受网址、网络路径或设备路径",
      );
    }
    return path.normalize(file);
  });
  const names = paths.map((file) => path.basename(file).toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new Error("同批文件名重复，请先重命名，避免附件对应错误");
  }
  return paths;
}
async function readUpload(file: string): Promise<PreparedFile> {
  const resolved = await realpath(file);
  if (/^[/\\]{2}/.test(resolved)) {
    throw new Error("文件链接指向网络或设备路径，请使用本机文件");
  }
  const name = path.basename(file);
  const handle = await open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`不是有效文件：${name}`);
    }
    if (stat.size > MAX_FILE) {
      throw new Error(`文件 ${name} 超过单个 ${MAX_FILE / 1024 / 1024} MB 限制`);
    }
    // 多读一个字节，发现读取期间文件变大；不把无界本机文件读入上传缓冲。
    const buffer = new Uint8Array(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) {
        break;
      }
      size += result.bytesRead;
    }
    if (size !== stat.size) {
      throw new Error(`文件在读取时发生变化：${name}`);
    }
    const bytes = buffer.subarray(0, size);
    const extension = path.extname(name).toLowerCase();
    const kind = KINDS.find((row) => row.extensions.includes(extension));
    if (!kind) {
      throw new Error(`不支持的附件格式：${name}；支持 ${SUPPORTED}`);
    }
    if (!kind.matches(bytes)) {
      throw new Error(`文件 ${name} 的内容与扩展名不符`);
    }
    return {
      path: file,
      filename: name.replace(/[\r\n"]/g, "_"),
      mediaType: kind.mediaType,
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } finally {
    await handle.close();
  }
}
async function prepareFiles(paths: string[]): Promise<PreparedFile[]> {
  const files: PreparedFile[] = [];
  let total = 0;
  for (const file of paths) {
    const prepared = await readUpload(file);
    total += prepared.size;
    if (total > MAX_BATCH) {
      throw new Error(`本批文件超过 ${MAX_BATCH / 1024 / 1024} MB，请分批上传`);
    }
    files.push(prepared);
  }
  return files;
}
const manifest = ({ bytes, ...row }: PreparedFile): UploadManifest => row;

/** 预览只读：校验文件并按文件名标明新增或上传新版本，不写入 Confluence。 */
export async function previewUpload(
  client: ConfluenceClient,
  reference: string,
  paths: string[],
  comment = "",
) {
  const page = await client.get(reference);
  const files = await prepareFiles(paths);
  const rows = [];
  for (const file of files) {
    const existing = await client.findAttachment(page.id, file.filename);
    rows.push({
      ...manifest(file),
      action: existing ? "new-version" : "create",
      attachmentId: existing?.id,
      currentVersion: existing?.version ?? undefined,
    });
  }
  return {
    status: "preview",
    pageId: page.id,
    title: page.title,
    url: page.url,
    comment,
    files: rows,
    message:
      "预览未上传。使用相同参数加 apply=true 与稳定 requestId 上传；同名附件将生成新版本。",
  };
}
function batchStatus(files: UploadFile[]): UploadBatch["status"] {
  if (files.every((file) => file.state === "uploaded")) {
    return "complete";
  }
  if (files.some((file) => ["unknown", "uploading"].includes(file.state))) {
    return "unknown";
  }
  return files.some((file) => file.state === "failed") ? "failed" : "pending";
}
function progress(batch: UploadBatch) {
  const files = batch.files.map(({ sha256, ...file }) =>
    file.state === "uploading"
      ? {
          ...file,
          state: "unknown" as const,
          error: "上次上传中断，结果不明，请先核实 Confluence 附件，不能直接重传",
        }
      : file,
  );
  return {
    status: batchStatus(batch.files),
    requestId: batch.requestId,
    pageId: batch.pageId,
    title: batch.title,
    complete: files.every((file) => file.state === "uploaded"),
    files,
  };
}

/**
 * 逐个文件上传并持久化进度，记录与页面写入共用 operations 目录，requestId 不能跨用途复用。
 * 发送前先记为 uploading：进程中断或回执不明时停在该文件，不会静默重复上传；
 * 明确被服务器拒绝的文件记为 failed，同一 requestId 再次调用时重试。
 */
export async function applyUpload(
  client: ConfluenceClient,
  reference: string,
  paths: string[],
  comment: string,
  requestId: string,
  signal?: AbortSignal,
) {
  if (!client.profile.allowWrites) {
    throw new Error("此连接尚未启用写入，请在连接设置启用");
  }
  const operationId = `${client.profile.id}-${validId(requestId)}`;
  const file = dataFile("operations", operationId);
  return withLock(`submit-${hash(operationId).slice(0, 32)}`, async () => {
    const resolved = await client.resolve(reference);
    let batch = await jsonRead<UploadBatch | null>(file, null);
    let prepared: PreparedFile[] | undefined;
    if (batch) {
      if (
        batch.kind !== "upload" ||
        batch.profile !== client.profile.id ||
        batch.pageId !== resolved ||
        batch.comment !== comment ||
        JSON.stringify(batch.files.map((row) => row.path)) !==
          JSON.stringify(paths)
      ) {
        throw new Error("此 requestId 已用于其他内容，请使用新的请求标识");
      }
      if (batch.host !== client.profile.host) {
        throw new Error("连接地址已改变，请核实原上传记录");
      }
      if (
        batch.files.every((row) =>
          ["uploaded", "unknown", "uploading"].includes(row.state),
        )
      ) {
        return progress(batch);
      }
    } else {
      const page = await client.get(resolved);
      prepared = await prepareFiles(paths);
      batch = {
        kind: "upload",
        requestId,
        profile: client.profile.id,
        host: client.profile.host,
        pageId: page.id,
        title: page.title,
        comment,
        status: "pending",
        files: prepared.map((row) => ({ ...manifest(row), state: "pending" })),
      };
      await jsonWrite(file, batch);
    }
    const save = async () => {
      batch!.status = batchStatus(batch!.files);
      await jsonWrite(file, batch);
    };
    for (const row of batch.files) {
      if (["uploaded", "unknown", "uploading"].includes(row.state)) {
        continue;
      }
      if (signal?.aborted) {
        break;
      }
      let data: PreparedFile;
      let existing: Attachment | undefined;
      try {
        data =
          prepared?.find((item) => item.path === row.path) ||
          (await readUpload(row.path));
        if (data.sha256 !== row.sha256) {
          throw new Error(
            "文件内容已改变，请恢复原文件；如需上传新内容，请使用新的 requestId",
          );
        }
        // 查找发生在写入之前，失败不会产生附件，可安全记为 failed。
        existing = await client.findAttachment(batch.pageId, row.filename);
      } catch (error) {
        row.state = "failed";
        row.error = message(error);
        await save();
        continue;
      }
      row.action = existing ? "new-version" : "create";
      row.state = "uploading";
      delete row.error;
      await save();
      try {
        row.attachment = await client.uploadAttachment(
          batch.pageId,
          data,
          batch.comment,
          existing?.id,
        );
        row.state = "uploaded";
      } catch (error) {
        const rejected =
          error instanceof ConfluenceError &&
          [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(error.status);
        row.state = rejected ? "failed" : "unknown";
        row.error = rejected
          ? message(error)
          : `${message(error)}；结果不明，请先核实 Confluence 附件，不能自动重传`;
      }
      await save();
    }
    return progress(batch);
  });
}
