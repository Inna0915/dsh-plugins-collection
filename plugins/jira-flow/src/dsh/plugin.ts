import { JiraService } from '../runtime/service.js';
import { createHttpHandler } from '../runtime/http.js';
import { bundledSkills } from '../runtime/skills.js';
import { dshAdapter } from './adapter.js';

export const name = 'jira-flow';
export const inject = ['webServer', 'tools', 'skills'];
export async function apply(ctx: any): Promise<void> {
  const service = new JiraService(dshAdapter(ctx));
  const api = createHttpHandler(service);
  for (const route of ['/jira-flow/bootstrap', '/jira-flow/api', '/jira-flow/asset']) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route, handler: api.handler }),
      `jira-flow: ${route}`,
    );
  }
  const properties = {
    operation: {
      type: 'string',
      enum: [
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
        'runs',
        'users',
        'create-context',
        'create',
        'attach',
        'attachment-settings',
        'results.import',
      ],
    },
    profile: { type: 'string', description: '已配置的连接别名，默认 work-jira' },
    key: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
    jql: { type: 'string' },
    project: { type: 'string' },
    issueType: { type: 'string' },
    summary: { type: 'string' },
    description: { type: 'string' },
    imagePaths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 20,
      description: 'create/attach 的用户指定本机图片绝对路径，上传实际图片字节',
    },
    assignee: { type: 'string', description: '默认 me；创建用 username/accountId 或唯一姓名；查询支持 all' },
    sprint: { type: 'string', description: '默认 current；创建用进行中迭代 ID/名称或 none；查询另支持 all' },
    query: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
    limit: { type: 'number' },
    outputDir: { type: 'string' },
    comments: { type: 'boolean' },
    includeDescription: {
      type: 'boolean',
      description: 'search 是否返回正文，默认 true；只需列表时传 false',
    },
    detail: {
      type: 'string',
      enum: ['compact', 'full'],
      description: 'issue 输出，默认 compact：省略 HTML 正文与 bodyMarkdown，保留 markdown',
    },
    changeFields: {
      type: 'array',
      items: { type: 'string' },
      description: 'history 只保留这些变更字段，并精简作者信息；keys 传多个编号时批量读取',
    },
    attachments: { type: 'string', enum: ['images', 'all', 'none'] },
    zip: { type: 'boolean' },
    transitionId: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
    body: { type: 'string' },
    comment: { type: 'string' },
    expectedUpdated: { type: 'string' },
    apply: { type: 'boolean' },
    requestId: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
  };
  ctx.tools.register({
    name: 'jira_flow',
    description:
      '默认查询当前用户的进行中迭代任务。支持创建 Task/Bug/Story（默认自己与当前迭代），查询创建字段和可分配用户，读取任务及评论、图文导出、周报、更新字段/流转/评论和导入执行结果。create/attach 可通过 imagePaths 上传用户指定的本机图片；apply=false 只预览，实际创建及上传必须带稳定 requestId。创建后图片失败仍保留任务编号，用 uploadRequestId 补传，不重新建单。写操作需明确用户指令、连接启用更新且 apply=true。凭证由运行层读取。',
    parameters: { type: 'object', properties, required: ['operation'], additionalProperties: false },
    output: {
      schema: {},
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      if (!properties.operation.enum.includes(args.operation)) throw new Error('不支持的操作');
      const { operation, ...params } = args;
      const detail = operation === 'issue' ? { detail: params.detail ?? 'compact' } : {};
      return service.execute(operation, { ...params, ...detail }, exec.signal);
    },
  });
  for (const skill of await bundledSkills()) ctx.skills.register(skill);
  ctx.effect(
    () => () => {
      api.dispose();
      service.dispose();
    },
    'jira-flow: request cleanup',
  );
  ctx.logger.info('任务看板 0.1.8 ready: Kanban, workflow transitions and portable Skills.');
}
