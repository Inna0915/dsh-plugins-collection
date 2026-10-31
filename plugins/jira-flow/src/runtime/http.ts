import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { JiraService } from './service.js';
import { inlineImages } from '../core/markdown.js';
import { resolveAttachment } from '../core/assets.js';
import { installationRoot } from './config.js';
import { issueKey, message, inside } from './store.js';
import type { Issue } from '../types.js';
import { ReadCache } from '../shared/read-cache.js';

export function createHttpHandler(service: JiraService) {
  const token = randomBytes(32).toString('hex');
  const controllers = new Set<AbortController>();
  const assetIssues = new ReadCache<Issue>(5_000);
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
      send(res, 403, { error: '任务看板仅允许本机访问' });
      return;
    }
    // DNS 重绑定时 Origin 与 Host 一致，只能靠 Host 白名单拦截。
    try {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL('http://' + req.headers.host).hostname))
        throw new Error();
    } catch {
      send(res, 403, { error: '无效的本机 Host' });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) throw new Error();
      } catch {
        send(res, 403, { error: '来源不匹配' });
        return;
      }
    }
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/jira-flow/bootstrap' && req.method === 'GET') {
      send(res, 200, { token, version: '0.1.8', dispatch: !!service.adapter });
      return;
    }
    const provided =
      typeof req.headers['x-jira-flow-token'] === 'string' ? req.headers['x-jira-flow-token'] : '';
    if (provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
      send(res, 403, { code: 'PAGE_TOKEN_EXPIRED', error: '页面连接已失效，请刷新' });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8 * 60_000);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      if (url.pathname === '/jira-flow/asset' && req.method === 'GET') {
        const profile = url.searchParams.get('profile') || 'work-jira';
        const key = issueKey(url.searchParams.get('key'));
        const attachmentId = url.searchParams.get('id');
        const client = await service.client(profile, controller.signal);
        const cacheKey = JSON.stringify([profile, key, url.searchParams.get('updated')]);
        const issue = await assetIssues.get(cacheKey, () => client.get(key, false));
        const source = url.searchParams.get('source');
        const attachment = attachmentId
          ? issue.attachments.find((asset) => asset.id === attachmentId)
          : source
            ? resolveAttachment(issue, source)
            : undefined;
        const allowedSource = source && inlineImages(issue).includes(source) ? source : undefined;
        if (
          (!attachment && !allowedSource) ||
          (attachment && !/^image\/(png|jpeg|gif|webp|bmp)$/i.test(attachment.mimeType))
        )
          throw new Error('图片附件不存在或格式不支持');
        const downloaded = await client.download(attachment?.content || allowedSource!);
        if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(downloaded.mimeType))
          throw new Error('附件内容类型不是可显示图片');
        res.writeHead(200, {
          'Content-Type': downloaded.mimeType,
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(downloaded.bytes);
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/jira-flow/api') {
        send(res, 404, { error: '接口不存在' });
        return;
      }
      if (!req.headers['content-type']?.startsWith('application/json'))
        throw new Error('请求格式必须是 JSON');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('请求内容过大');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof input.operation !== 'string') throw new Error('缺少操作名称');
      const value = await service.execute(input.operation, input.args || {}, controller.signal);
      if (!res.destroyed) send(res, 200, { data: value });
    } catch (error) {
      if (!res.destroyed) send(res, 400, { error: message(error) });
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  return {
    handler,
    dispose: () => {
      assetIssues.clear();
      for (const controller of controllers) controller.abort();
    },
  };
}
export async function serve(port = 43127, service = new JiraService()) {
  const api = createHttpHandler(service);
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/jira-flow/')) {
      await api.handler(req, res);
      return;
    }
    const name = req.url?.split('?')[0] === '/standalone.js' ? 'standalone.js' : 'index.html';
    try {
      const data = await readFile(inside(path.join(installationRoot, 'dist'), name));
      res.writeHead(200, {
        'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end('Build the application first.');
    }
  });
  server.requestTimeout = 9 * 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    close: async () => {
      api.dispose();
      service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
