import { readFile } from 'node:fs/promises';
import type { DispatchAdapter } from '../runtime/service.js';
import type { TaskPackage } from '../types.js';
import { inside } from '../runtime/store.js';

export function dshAdapter(ctx: any): DispatchAdapter {
  return {
    async targets(signal) {
      const controller = ctx.get('sessionController');
      if (!controller) throw new Error('DSH 会话控制服务不可用');
      const catalog = await controller.list({}, signal);
      const presets = (await ctx.get('agentPresets')?.list()) || [];
      return {
        sessions: (catalog.items || [])
          .filter((row: any) => !row.parentSession)
          .map((row: any) => ({
            id: row.id || row.sessionId,
            title: row.title || row.id || row.sessionId,
            cwd: row.cwd,
            running: row.running === true,
          })),
        presets,
      };
    },
    async create(input, signal) {
      signal.throwIfAborted();
      const controller = ctx.get('sessionController');
      const result = await controller.create({
        cwd: input.cwd,
        agentPreset: input.agentPreset,
        sessionId: input.sessionId,
      });
      try {
        await controller.rename({ sessionId: result.sessionId, title: input.title });
      } catch {
        /* Session creation is successful even if a cosmetic rename fails. */
      }
      return result.sessionId;
    },
    async send(sessionId, requestId, task: TaskPackage, prompt, includeImages, signal) {
      const parts: any[] = [
        {
          type: 'text',
          text: [
            prompt || '请分析并完成以下 Jira 任务，先确认验收标准与代码范围。',
            task.instruction,
            '',
            task.markdown,
          ].join('\n\n'),
        },
      ];
      const images = task.assets.filter(
        (asset) =>
          asset.status === 'downloaded' && asset.path && /^image\/(png|jpeg|webp|gif)$/.test(asset.mimeType),
      );
      let totalBytes = 0;
      let imageCount = 0;
      if (includeImages)
        for (const asset of images) {
          signal.throwIfAborted();
          const bytes = await readFile(inside(task.directory, asset.path!));
          totalBytes += bytes.length;
          imageCount++;
          if (imageCount > 20 || totalBytes > 25 * 1024 * 1024)
            throw new Error('图片超过单次投递限制（20 张 / 25 MB），请分批派发或使用任务包目录模式');
          parts.push({ type: 'text', text: `以下图片对应 ${asset.issueKey}：${asset.filename}` });
          parts.push({
            type: 'image',
            mediaType: asset.mimeType,
            data: bytes.toString('base64'),
            name: `${asset.issueKey}-${asset.filename}`,
          });
        }
      if (task.markdown.length > 180_000)
        throw new Error('任务正文超过一次投递限制，请减少所选任务或使用任务包目录模式');
      const controller = ctx.get('sessionController');
      await controller.prompt(
        { sessionId, requestId, mode: 'queue', content: parts, clientTimeZone: 'Asia/Shanghai' },
        signal,
      );
    },
  };
}
