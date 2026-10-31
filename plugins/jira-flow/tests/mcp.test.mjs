import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP 标准客户端可发现并调用工具，服务退出清理子进程', async () => {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const home = await mkdtemp(path.resolve('.task-temp', 'mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/cli.js'), 'mcp'],
    env: { ...process.env, JIRA_FLOW_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'jira-flow-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === 'jira_flow'));
    const response = await client.callTool({ name: 'jira_flow', arguments: { operation: 'profiles' } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), []);
    const create = await client.callTool({
      name: 'jira_flow',
      arguments: {
        operation: 'create',
        summary: 'Fixture preview',
        assignee: 'me',
        sprint: 'none',
        imagePaths: [path.resolve('fixture.png')],
      },
    });
    assert.equal(create.isError, true);
    assert.match(
      create.content[0].text,
      /尚未配置/,
      'new creation parameters must reach the service, not fail MCP schema validation',
    );
    const attach = await client.callTool({
      name: 'jira_flow',
      arguments: { operation: 'attach', key: 'DEMO-1', imagePaths: [path.resolve('fixture.png')] },
    });
    assert.equal(attach.isError, true);
    assert.match(attach.content[0].text, /尚未配置/, 'attachment parameters must reach the service');
    const invalid = await client.callTool({
      name: 'jira_flow',
      arguments: { operation: 'issue', key: '../escape' },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await transport.close();
    assert.ok(home.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(home, { recursive: true, force: true });
  }
});
