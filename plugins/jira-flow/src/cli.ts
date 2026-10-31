#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { JiraService } from './runtime/service.js';
import { serve } from './runtime/http.js';
import { installSkills } from './runtime/skills.js';
import { startMcp } from './runtime/mcp.js';
import { message } from './runtime/store.js';

const help = `任务看板 0.1.8

  jira-flow auth import-obsidian --source <插件 data.json> [--workspace <代码目录>]
  jira-flow profiles | doctor
  jira-flow search [--assignee me|all|<用户标识>] [--sprint current|all|none|<ID或名称>] [--type Bug] [--jql <完整条件>] [--limit 500] [--no-description]
  jira-flow create-context [--project <项目>] [--type Task|Bug|Story]
  jira-flow users [--project <项目>] [--query <用户名或姓名>]
  jira-flow create --type Bug --summary <标题> [--body-file <正文>] [--assignee <用户>] [--sprint current|none|<进行中迭代ID>] [--fields-file <JSON>] [--image <图片绝对路径> ...] [--apply --request-id <预览标识>]
  jira-flow attach PROJ-123 --image <图片绝对路径> [--image <第二张>] [--apply --request-id <上传标识>]
  jira-flow attachment-settings       只读查询附件开关与大小限制
  jira-flow issue PROJ-123 [--format markdown] [--no-comments] [--detail compact|full]
  jira-flow export PROJ-123 PROJ-124 [--output <目录>] [--attachments images|all|none] [--zip]
  jira-flow history PROJ-123 [PROJ-124 ...] [--change-fields status,assignee,resolution]
  jira-flow transitions PROJ-123 | sprints
  jira-flow transition PROJ-123 --transition-id <ID> [--fields-file <JSON>] [--expected-updated <时间>] --apply
  jira-flow update PROJ-123 --fields-file <JSON> [--expected-updated <时间>] --apply
  jira-flow comment PROJ-123 --body-file <UTF-8文件> --apply
  jira-flow weekly [--start <ISO时间>] [--end <ISO时间>] [--jql <范围>] [--format markdown]
  jira-flow results import --source <results.json>
  jira-flow exports [--older-than 30]  只列出长期未改动的任务包及占用，不删除
  jira-flow skills install [--output <Skills目录>]
  jira-flow serve [--port 43127]       本机独立看板，Ctrl+C 停止
  jira-flow mcp                      MCP stdio 服务

通用参数：--profile work-jira、--format json|markdown、--request-id <幂等标识>
issue 默认 compact：省略 HTML 正文与 bodyMarkdown，保留 markdown；--detail full 返回全部。
history 多个编号时返回 items 数组，单条失败不影响其他；--change-fields 只保留指定变更字段。
每天首次调用先清理超过 30 天的写操作回执（operations、uploads）；任务包不会自动删除。
凭证通过独立导入/连接设置保存；不要把密码或 token 写入命令、Skill 或聊天。
`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      profile: { type: 'string' },
      source: { type: 'string' },
      workspace: { type: 'string' },
      jql: { type: 'string' },
      project: { type: 'string' },
      type: { type: 'string' },
      summary: { type: 'string' },
      assignee: { type: 'string' },
      sprint: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string' },
      attachments: { type: 'string' },
      image: { type: 'string', multiple: true },
      zip: { type: 'boolean' },
      'no-comments': { type: 'boolean' },
      'no-description': { type: 'boolean' },
      detail: { type: 'string' },
      'change-fields': { type: 'string' },
      'older-than': { type: 'string' },
      'transition-id': { type: 'string' },
      'fields-file': { type: 'string' },
      'body-file': { type: 'string' },
      'expected-updated': { type: 'string' },
      apply: { type: 'boolean' },
      'request-id': { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      port: { type: 'string' },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command, ...rest] = positionals;
  if (command === 'mcp') {
    await startMcp();
    return;
  }
  if (command === 'serve') {
    const port = Number(values.port || 43127);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
    const running = await serve(port);
    process.stderr.write(`Jira Flow: http://127.0.0.1:${port}\n`);
    process.once('SIGINT', () => void running.close());
    process.once('SIGTERM', () => void running.close());
    return;
  }
  const service = new JiraService();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8 * 60_000);
  process.once('SIGINT', () => abort.abort());
  try {
    let operation = command;
    const args: Record<string, unknown> = {
      profile: values.profile,
      key: rest[0],
      keys: rest,
      jql: values.jql,
      project: values.project,
      issueType: values.type,
      summary: values.summary,
      assignee: values.assignee,
      sprint: values.sprint,
      query: values.query,
      limit: values.limit ? Number(values.limit) : undefined,
      outputDir: values.output,
      attachments: values.attachments,
      imagePaths: values.image,
      zip: values.zip,
      comments: !values['no-comments'],
      includeDescription: values['no-description'] ? false : undefined,
      detail: values.detail || (command === 'issue' ? 'compact' : undefined),
      changeFields: values['change-fields'],
      olderThan: values['older-than'],
      transitionId: values['transition-id'],
      expectedUpdated: values['expected-updated'],
      apply: values.apply,
      requestId: values['request-id'],
      start: values.start,
      end: values.end,
    };
    let result: any;
    if (command === 'skills' && rest[0] === 'install') result = await installSkills(values.output);
    else {
      if (command === 'auth' && rest[0] === 'import-obsidian') {
        operation = 'settings.import';
        args.source = values.source;
        args.workspace = values.workspace;
      }
      if (command === 'results' && rest[0] === 'import') {
        operation = 'results.import';
        args.data = JSON.parse(await readFile(values.source || '', 'utf8'));
      }
      if (values['fields-file']) args.fields = JSON.parse(await readFile(values['fields-file'], 'utf8'));
      if (values['body-file']) {
        args.body = await readFile(values['body-file'], 'utf8');
        args.comment = args.body;
        if (command === 'create') args.description = args.body;
      }
      result = await service.execute(operation, args, abort.signal);
    }
    if (values.format === 'markdown') {
      if (typeof result?.markdown !== 'string') throw new Error('此操作没有 Markdown 输出');
      process.stdout.write(result.markdown + '\n');
    } else {
      if (operation === 'export') {
        const { markdown, ...summary } = result;
        result = summary;
      }
      process.stdout.write(JSON.stringify({ ok: true, data: result }, null, 2) + '\n');
    }
  } finally {
    clearTimeout(timer);
    service.dispose();
  }
}
main().catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, error: message(error) }) + '\n');
  process.exitCode = 1;
});
