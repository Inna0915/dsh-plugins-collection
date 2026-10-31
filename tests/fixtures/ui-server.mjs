// Synthetic UI verification. All mutations are in memory; no Jira credentials.
import {
  serve,
  normalizeIssue,
  normalizeProfile,
  issueMarkdown,
  createHttpHandler,
} from '../../dist/test-exports.js';
const profile = normalizeProfile({
  id: 'fixture',
  name: '交互验证（模拟）',
  host: 'https://jira.example.test',
  projectKeys: ['DEMO'],
  allowWrites: true,
  credentialStore: 'environment',
});
const issues = [
  ['DEMO-1', 'Bug', '修复库存查询超时', 'Open', 'todo', '迭代 01'],
  ['DEMO-2', 'Story', '增加库存批量导出', 'In Progress', 'doing', '迭代 01'],
  ['DEMO-3', 'Story', '完善操作记录与验收', 'Build Done', 'review', '迭代 02'],
].map(([key, type, summary, status, column, sprint]) => ({
  ...normalizeIssue(
    {
      id: key,
      key,
      fields: {
        project: { key: 'DEMO' },
        summary,
        issuetype: { name: type },
        status: { id: status, name: status },
        updated: '2026-10-25T10:00:00.375+08:00',
      },
    },
    profile,
  ),
  column,
  sprint,
  assignee: '开发者',
  priority: 'Medium',
  description:
    '<p>点击查询后应及时返回结果，并提供明确的加载提示。</p><p>验收：重复操作不会发送重复请求。</p><img src="https://jira.example.test/secure/attachment/1/screenshot.png" alt="验证截图">',
  descriptionFormat: 'html',
  attachments: [
    {
      id: '1',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 68,
      content: 'https://jira.example.test/secure/attachment/1/screenshot.png',
    },
  ],
}));
const counts = {};
let failTransition = false;
let rotatedHandler;
const transitions = [
  { id: '11', name: '开始任务', to: { id: '3', name: 'In Progress 处理中' }, fields: {} },
  {
    id: '12',
    name: '开始细化',
    to: { id: '2', name: 'Defining 定义' },
    fields: { resolution: { name: '原因', required: true, allowedValues: [{ id: '1', name: '需求澄清' }] } },
  },
  { id: '13', name: '退回待办', to: { id: '1', name: 'Open 打开' }, fields: {} },
];
const service = {
  adapter: undefined,
  async client() {
    return {
      get: async (key) => {
        counts.assetDetails = (counts.assetDetails || 0) + 1;
        return issues.find((i) => i.key === key);
      },
      download: async () => {
        counts.images = (counts.images || 0) + 1;
        return {
          bytes: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGwoAAAAASUVORK5CYII=',
            'base64',
          ),
          mimeType: 'image/png',
        };
      },
    };
  },
  async execute(operation, args = {}) {
    counts[operation] = (counts[operation] || 0) + 1;
    if (operation === 'profiles') return [profile];
    if (operation === 'cache') return null;
    if (operation === 'search')
      return {
        issues: issues.map((issue) => ({ ...issue, updated: issue.updated.replace(/\.\d{3}/, '.000') })),
        total: issues.length,
        complete: true,
        fetchedAt: new Date().toISOString(),
        jql: '',
      };
    if (operation === 'runs' || operation === 'results') return [];
    if (operation === 'fixture.stats') return counts;
    if (operation === 'fixture.change') {
      issues[0].summary = '刷新已获取最新任务内容';
      issues[0].updated = new Date().toISOString();
      return { changed: true };
    }
    if (operation === 'fixture.fail-transition') {
      failTransition = true;
      return { ready: true };
    }
    if (operation === 'fixture.rotate') {
      rotatedHandler?.dispose();
      rotatedHandler = createHttpHandler(service);
      app.server.removeAllListeners('request');
      app.server.on('request', (req, res) =>
        req.url?.startsWith('/jira-flow/') ? void rotatedHandler.handler(req, res) : staticHandler(req, res),
      );
      return { rotated: true };
    }
    const issue = issues.find((row) => row.key === args.key);
    if (!issue) throw new Error('fixture issue not found');
    if (operation === 'issue')
      return {
        ...issue,
        markdown: issueMarkdown(issue),
        bodyMarkdown: issueMarkdown(issue, new Map(), true, {
          includeMetadata: false,
          omitInlineAttachments: true,
        }),
      };
    if (operation === 'transitions') return transitions;
    if (operation === 'transition-context') return { issue, transitions };
    if (operation === 'transition') {
      if (args.expectedUpdated !== issue.updated) throw new Error('Jira 任务已变化，请刷新后重试');
      if (failTransition) {
        failTransition = false;
        throw new Error('模拟任务冲突，未写入');
      }
      const target = transitions.find((target) => target.id === args.transitionId);
      if (!target) throw new Error('无效流转');
      for (const [name, definition] of Object.entries(target.fields))
        if (definition.required && !args.fields?.[name]) throw new Error('缺少必填字段');
      counts.writes = (counts.writes || 0) + 1;
      issue.column = target.id === '11' ? 'doing' : 'todo';
      issue.status = { ...issue.status, ...target.to };
      issue.updated = new Date().toISOString();
      return issue;
    }
    throw new Error('unsupported fixture operation');
  },
  dispose() {},
};
const app = await serve(43129, service);
const staticHandler = app.server.listeners('request')[0];
console.log('Synthetic UI ready on 127.0.0.1:43129');
const close = () => {
  clearTimeout(timer);
  rotatedHandler?.dispose();
  void app.close();
};
const timer = setTimeout(close, 10 * 60_000);
process.once('SIGINT', close);
process.once('SIGTERM', close);
