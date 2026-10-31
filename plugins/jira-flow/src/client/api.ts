import type { Issue } from '../types.js';
import { ReadCache } from '../shared/read-cache.js';
import { createTransport } from './transport.js';
export type IssueDetail = Issue & { markdown: string; bodyMarkdown: string };
const details = new ReadCache<IssueDetail>(30_000);
const images = new ReadCache<Blob>(120_000, 12);
const transport = createTransport();
export const bootstrap = transport.bootstrap;
export function loadIssue(profile: string, key: string, updated = '', refresh = false) {
  const cacheKey = JSON.stringify([profile, key, updated]);
  if (refresh) details.delete(cacheKey);
  return details.get(cacheKey, async () => {
    const result = await api<IssueDetail>('issue', { profile, key });
    if (result.updated !== updated)
      void details.get(JSON.stringify([profile, key, result.updated]), async () => result);
    return result;
  });
}
export function invalidateReads() {
  details.clear();
  images.clear();
}
export async function api<T = any>(
  operation: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(
    ['search', 'transitions', 'transition-context'].includes(operation) ? 45_000 : 8 * 60_000,
  );
  const response = await transport.request(
    '/jira-flow/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, args }),
    },
    signal ? AbortSignal.any([timeout, signal]) : timeout,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data.data as T;
}
export async function assetUrl(
  profile: string,
  key: string,
  id?: string,
  source?: string,
  updated = '',
): Promise<string> {
  const query = new URLSearchParams({
    profile,
    key,
    updated,
    ...(id ? { id } : {}),
    ...(source ? { source } : {}),
  });
  const blob = await images.get(query.toString(), async () => {
    const response = await transport.request(`/jira-flow/asset?${query}`, {}, AbortSignal.timeout(45_000));
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '图片加载失败');
    }
    return response.blob();
  });
  return URL.createObjectURL(blob);
}
export async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error('剪贴板访问失败，请从任务包文件复制内容');
  }
}
