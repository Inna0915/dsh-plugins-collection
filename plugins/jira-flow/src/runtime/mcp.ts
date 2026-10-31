import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JiraService } from './service.js';
import { message } from './store.js';
export async function startMcp() {
  const service = new JiraService();
  const server = new McpServer({ name: 'jira-flow', version: '0.1.8' });
  server.registerTool(
    'jira_flow',
    {
      title: '任务看板',
      description:
        '默认查询当前用户的进行中迭代任务；支持创建 Task/Bug/Story、用户与创建字段查询、详情、图文导出及周报。创建默认自己和当前迭代；create/attach 可通过 imagePaths 上传用户指定的本机图片，apply=false 仅预览。写入需用户指令、启用更新、apply=true；创建及上传必须带稳定 requestId。创建后图片失败仍保留任务编号，用 uploadRequestId 补传，不重新建单。',
      inputSchema: {
        operation: z.enum([
          'profiles',
          'doctor',
          'search',
          'issue',
          'export',
          'transitions',
          'history',
          'weekly',
          'sprints',
          'transition',
          'update',
          'comment',
          'users',
          'create-context',
          'create',
          'attach',
          'attachment-settings',
          'results.import',
        ]),
        profile: z.string().optional(),
        key: z.string().optional(),
        keys: z
          .array(z.string())
          .optional()
          .describe('export 的多个任务；history 传多个编号时批量读取，返回 items'),
        jql: z.string().optional(),
        project: z.string().optional(),
        issueType: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        imagePaths: z
          .array(z.string())
          .min(1)
          .max(20)
          .optional()
          .describe('create/attach 的用户指定本机图片绝对路径；上传真实字节，非图片链接。最多20张。'),
        assignee: z
          .string()
          .optional()
          .describe('默认 me；创建时为 username/accountId 或唯一姓名；search 支持 all'),
        sprint: z
          .string()
          .optional()
          .describe('默认 current；创建支持进行中迭代 ID/名称或 none；search 另支持 all'),
        query: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().optional(),
        outputDir: z.string().optional(),
        comments: z.boolean().optional(),
        includeDescription: z
          .boolean()
          .optional()
          .describe('search 是否返回正文，默认 true；只需列表时传 false 可大幅缩小输出'),
        detail: z
          .enum(['compact', 'full'])
          .optional()
          .describe('issue 输出，默认 compact：省略 HTML 正文与 bodyMarkdown，保留 markdown'),
        changeFields: z
          .array(z.string())
          .optional()
          .describe('history 只保留这些变更字段（如 status、assignee、resolution），并精简作者信息'),
        attachments: z.enum(['images', 'all', 'none']).optional(),
        zip: z.boolean().optional(),
        transitionId: z.string().optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
        body: z.string().optional(),
        comment: z.string().optional(),
        expectedUpdated: z.string().optional(),
        apply: z.boolean().optional(),
        requestId: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      },
    },
    async ({ operation, ...args }, extra) => {
      try {
        const params = operation === 'issue' ? { ...args, detail: args.detail ?? 'compact' } : args;
        const value = await service.execute(operation, params, extra.signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: message(error) }] };
      }
    },
  );
  await server.connect(new StdioServerTransport());
  const close = async () => {
    service.dispose();
    await server.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  return { close };
}
