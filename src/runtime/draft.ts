import { readFile } from 'node:fs/promises';
import type { ComposerDraft, TaskPackage } from '../types.js';
import { inside } from './store.js';

// Only registered export packages can reach this function through the HTTP API.
export async function prepareComposerDraft(task: TaskPackage, signal?: AbortSignal): Promise<ComposerDraft> {
  if (task.markdown.length > 180_000) throw new Error('正文过长，请减少任务数量或使用任务包目录');
  const warnings = task.errors.map((error) => `${error.key}：${error.error}`);
  const images: ComposerDraft['images'] = [];
  let bytes = 0;
  for (const asset of task.assets) {
    signal?.throwIfAborted();
    if (asset.status !== 'downloaded' || !asset.path) {
      warnings.push(`${asset.issueKey} / ${asset.filename}：图片未下载，保留任务包中的引用`);
      continue;
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(asset.mimeType)) {
      warnings.push(`${asset.filename}：请从任务包查看此附件`);
      continue;
    }
    const buffer = await readFile(inside(task.directory, asset.path));
    if (images.length >= 20 || bytes + buffer.length > 25 * 1024 * 1024) {
      warnings.push(`${asset.filename}：超出单次图片限制（20 张 / 25 MB），保留在任务包`);
      continue;
    }
    bytes += buffer.length;
    images.push({
      name: `${asset.issueKey}-${asset.filename}`,
      mimeType: asset.mimeType,
      data: buffer.toString('base64'),
    });
  }
  return {
    text: [
      `以下为 Jira 任务资料，请按本会话中我的要求处理。任务包索引：${task.indexPath}。图片同时作为附件加入；本地原图与逐条任务可从索引读取。`,
      task.markdown,
      images.length ? `随附图片（按此顺序）：\n${images.map((image) => `- ${image.name}`).join('\n')}` : '',
      warnings.length ? `资源缺口：\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    images,
    warnings,
  };
}
