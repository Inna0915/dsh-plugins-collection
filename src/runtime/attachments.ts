import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JiraClient, JiraHttpError } from '../core/jira.js';
import { dataHome, issueKey, jsonRead, jsonWrite, message, validId, withLock } from './store.js';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_BATCH = 50 * 1024 * 1024;
export interface ImageManifest {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}
interface PreparedImage extends ImageManifest {
  bytes: Buffer;
}
export interface ImageUpload extends ImageManifest {
  state: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'unknown';
  attachment?: Awaited<ReturnType<JiraClient['uploadImage']>>;
  error?: string;
}
interface UploadBatch {
  requestId: string;
  profile: string;
  key: string;
  images: ImageUpload[];
}

export function imagePaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20)
    throw new Error('请选择 1 至 20 张本地图片（imagePaths / --image）');
  const paths = input.map((file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /^[/\\]{2}/.test(file))
      throw new Error('图片必须是本机文件的绝对路径，不接受网址、网络路径或设备路径');
    return path.normalize(file);
  });
  const names = paths.map((file) => path.basename(file).toLowerCase());
  if (new Set(names).size !== names.length)
    throw new Error('同批图片文件名重复，请先重命名，避免 Jira 附件混淆');
  return paths;
}
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (bytes.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  return undefined;
}
async function readImage(file: string, limit: number): Promise<PreparedImage> {
  const resolved = await realpath(file);
  if (/^[/\\]{2}/.test(resolved)) throw new Error('图片链接指向网络或设备路径，请使用本机文件');
  const handle = await open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error(`不是有效图片文件：${path.basename(file)}`);
    if (stat.size > limit) throw new Error(`图片 ${path.basename(file)} 超过单张限制 ${limit} 字节`);
    // Bounded read also catches a file that grows after stat; never read an
    // unbounded local file into a tool response or upload buffer.
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error(`图片在读取时发生变化：${path.basename(file)}`);
    const bytes = buffer.subarray(0, size);
    const mimeType = imageMime(bytes);
    const extension = path.extname(file).toLowerCase();
    const supported: Record<string, string[]> = {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/gif': ['.gif'],
      'image/webp': ['.webp'],
      'image/bmp': ['.bmp'],
    };
    if (!mimeType || !supported[mimeType].includes(extension))
      throw new Error(`图片 ${path.basename(file)} 的内容与格式不符；支持 PNG/JPEG/GIF/WebP/BMP`);
    return {
      path: file,
      filename: path.basename(file).replace(/[\r\n"]/g, '_'),
      size,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    };
  } finally {
    await handle.close();
  }
}
export function imageManifest(files: PreparedImage[]): ImageManifest[] {
  return files.map(({ bytes, ...manifest }) => manifest);
}
export async function prepareImages(client: JiraClient, input: unknown): Promise<PreparedImage[]> {
  const paths = imagePaths(input);
  const settings = await client.attachmentSettings();
  if (!settings.enabled) throw new Error('此 Jira 未启用附件，尚未创建任务或上传图片');
  const files: PreparedImage[] = [];
  let total = 0;
  for (const file of paths) {
    const image = await readImage(file, Math.min(MAX_FILE, settings.uploadLimit));
    total += image.size;
    if (total > MAX_BATCH) throw new Error('本批图片超过 50 MB，请分批上传');
    files.push(image);
  }
  if (new Set(files.map((file) => file.filename.toLowerCase())).size !== files.length)
    throw new Error('图片上传名称重复，请先重命名');
  return files;
}
export function creationUploadId(profile: string, requestId: string): string {
  return `create-${createHash('sha256')
    .update(JSON.stringify([profile, requestId]))
    .digest('hex')
    .slice(0, 40)}`;
}
function progress(batch: UploadBatch) {
  const images = batch.images.map((image) =>
    image.state === 'uploading'
      ? {
          ...image,
          state: 'unknown' as const,
          error: '上次上传中断，结果不明，请先核实 Jira 附件，不能直接重传',
        }
      : image,
  );
  return {
    key: batch.key,
    requestId: batch.requestId,
    complete: images.every((image) => image.state === 'uploaded'),
    images,
  };
}

/** Resumable per-image writes. A server failure cannot invalidate a created issue receipt. */
export async function uploadImages(
  client: JiraClient,
  key: string,
  input: unknown,
  requestId: string,
  signal?: AbortSignal,
  createdManifest?: ImageManifest[],
) {
  if (!client.profile.allowWrites) throw new Error('此连接处于只读模式，请启用 Jira 更新');
  const paths = imagePaths(input);
  const id = validId(requestId);
  const target = issueKey(key);
  if (!client.profile.projectKeys.includes(target.replace(/-\d+$/, '')))
    throw new Error('任务不在此连接允许的项目范围内');
  const lock = `upload-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
  return withLock(lock, async () => {
    const file = path.join(dataHome(), 'uploads', `${id}.json`);
    let batch = await jsonRead<UploadBatch | null>(file, null);
    let prepared: PreparedImage[] | undefined;
    if (batch) {
      if (
        batch.profile !== client.profile.id ||
        batch.key !== target ||
        JSON.stringify(batch.images.map((row) => row.path)) !== JSON.stringify(paths)
      )
        throw new Error('此上传 requestId 已用于其他任务或图片，请核实原上传批次');
      if (batch.images.every((row) => ['uploaded', 'unknown', 'uploading'].includes(row.state)))
        return progress(batch);
    } else {
      // get() enforces the configured project scope, even when called from attach.
      if (!createdManifest) {
        await client.get(target, false);
        prepared = await prepareImages(client, paths);
      }
      const manifest = createdManifest || imageManifest(prepared!);
      if (JSON.stringify(manifest.map((row) => row.path)) !== JSON.stringify(paths))
        throw new Error('创建时的图片清单不匹配');
      batch = {
        requestId: id,
        profile: client.profile.id,
        key: target,
        images: manifest.map((row) => ({ ...row, state: 'pending' })),
      };
      await jsonWrite(file, batch);
      // Preserve a created issue's original manifest even if its first detail
      // lookup fails, so standalone attach retries still enforce content hashes.
      if (createdManifest) await client.get(target, false);
    }
    const settings = await client.attachmentSettings();
    if (!settings.enabled) throw new Error('Jira 已关闭附件；任务编号与上传记录保留，未上传');
    for (const image of batch.images) {
      if (['uploaded', 'unknown', 'uploading'].includes(image.state)) continue;
      if (signal?.aborted) break;
      let imageData: PreparedImage;
      try {
        imageData =
          prepared?.find((row) => row.path === image.path) ||
          (await readImage(image.path, Math.min(MAX_FILE, settings.uploadLimit)));
        if (imageData.size > settings.uploadLimit)
          throw new Error('图片超过 Jira 当前上传限制，请调整配置后补传');
        if (imageData.sha256 !== image.sha256)
          throw new Error('图片内容已改变，请恢复原图；如需上传新图，请单独发起 attach');
      } catch (error) {
        image.state = 'failed';
        image.error = message(error);
        await jsonWrite(file, batch);
        continue;
      }
      image.state = 'uploading';
      delete image.error;
      // Persist intent BEFORE sending. If the process dies after POST, subsequent
      // calls stop on this image instead of silently uploading it twice.
      await jsonWrite(file, batch);
      try {
        image.attachment = await client.uploadImage(target, imageData, true);
        image.state = 'uploaded';
      } catch (error) {
        const rejected =
          error instanceof JiraHttpError && [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status);
        image.state = rejected ? 'failed' : 'unknown';
        image.error = rejected
          ? message(error)
          : `${message(error)}；结果不明，请核实 Jira 附件，不能自动重传`;
      }
      await jsonWrite(file, batch);
    }
    return progress(batch);
  });
}
