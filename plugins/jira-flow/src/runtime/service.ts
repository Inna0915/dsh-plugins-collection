import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { JiraClient } from '../core/jira.js';
import { issueMarkdown } from '../core/markdown.js';
import { exportTasks } from '../core/export.js';
import { weeklyReport } from '../core/report.js';
import { prepareComposerDraft } from './draft.js';
import {
  prepareImages,
  imageManifest,
  uploadImages,
  creationUploadId,
  type ImageManifest,
} from './attachments.js';
import { createContext, prepareCreate, assignableUsers, queryJql } from '../core/creation.js';
import { getAuth, getProfile, profiles, saveProfile, importObsidian } from './config.js';
import { dataHome, jsonRead, jsonWrite, issueKey, validId, withLock, message, inside } from './store.js';
import type { Profile, SearchResult, TaskPackage, RunRecord, TaskResult } from '../types.js';

export interface DispatchAdapter {
  targets(signal: AbortSignal): Promise<{
    sessions: Array<{ id: string; title: string; cwd?: string; running?: boolean }>;
    presets: Array<{ id: string; name?: string; broken?: unknown }>;
  }>;
  create(
    input: { cwd: string; agentPreset?: string; sessionId: string; title: string },
    signal: AbortSignal,
  ): Promise<string>;
  send(
    sessionId: string,
    requestId: string,
    task: TaskPackage,
    prompt: string,
    includeImages: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}
export type Args = Record<string, any>;
export class JiraService {
  readonly shutdown = new AbortController();
  constructor(readonly adapter?: DispatchAdapter) {}
  async client(profile: string, signal?: AbortSignal): Promise<JiraClient> {
    const config = await getProfile(profile);
    return new JiraClient(
      config,
      await getAuth(config),
      fetch,
      AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]),
    );
  }
  async execute(operation: string, args: Args = {}, signal?: AbortSignal): Promise<any> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
    signal?.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const profile = typeof args.profile === 'string' ? validId(args.profile) : 'work-jira';
    const key = () => issueKey(args.key);
    const text = (name: string, fallback = '') => (typeof args[name] === 'string' ? args[name] : fallback);
    if (operation === 'profiles') return profiles();
    if (operation === 'settings.save') return saveProfile(args.config, args.auth);
    if (operation === 'settings.import') return importObsidian(text('source'), profile, text('workspace'));
    if (operation === 'targets') {
      if (!this.adapter) return { sessions: [], presets: [], available: false };
      return { ...(await this.adapter.targets(signal || this.shutdown.signal)), available: true };
    }
    if (operation === 'runs') {
      const files = await readdir(path.join(dataHome(), 'runs')).catch(() => [] as string[]);
      const runs = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => jsonRead<RunRecord>(path.join(dataHome(), 'runs', file))),
      );
      return runs
        .filter((run) => run.profile === profile)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);
    }
    if (operation === 'cache')
      return jsonRead<SearchResult | null>(path.join(dataHome(), 'cache', `${profile}.json`), null);
    if (operation === 'results') {
      const files = await readdir(path.join(dataHome(), 'results')).catch(() => [] as string[]);
      const batches = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => jsonRead<any>(path.join(dataHome(), 'results', file))),
      );
      return batches
        .filter((batch) => batch.profile === profile)
        .flatMap((batch) =>
          batch.results
            .filter((row: TaskResult) => !args.key || row.key === issueKey(args.key))
            .map((row: TaskResult) => ({ ...row, batchId: batch.id, importedAt: batch.importedAt })),
        )
        .sort((a: any, b: any) => b.importedAt.localeCompare(a.importedAt));
    }
    if (operation === 'results.import') {
      const data = args.data;
      if (!data || data.schemaVersion !== 1 || !Array.isArray(data.results) || data.results.length > 100)
        throw new Error('结果文件格式无效');
      const results: TaskResult[] = data.results.map((row: any) => {
        const k = issueKey(row.key);
        if (typeof row.summary !== 'string' || !row.summary.trim() || typeof row.verification !== 'string')
          throw new Error(`${k} 缺少结果摘要或验证信息`);
        return {
          key: k,
          summary: row.summary.slice(0, 20000),
          verification: row.verification.slice(0, 20000),
          artifacts: Array.isArray(row.artifacts)
            ? row.artifacts.filter((v: unknown) => typeof v === 'string').slice(0, 100)
            : [],
          remaining: typeof row.remaining === 'string' ? row.remaining : '',
          expectedUpdated: typeof row.expectedUpdated === 'string' ? row.expectedUpdated : '',
        };
      });
      const id = randomUUID();
      await jsonWrite(path.join(dataHome(), 'results', `${id}.json`), {
        id,
        profile,
        importedAt: new Date().toISOString(),
        packageId: data.packageId,
        results,
      });
      return { id, results, jiraUpdated: false };
    }
    if (operation === 'dispatch') return this.dispatch(profile, args, signal || this.shutdown.signal);
    if (operation === 'draft') {
      const task = await this.package(text('packageId'));
      if (task.profile !== profile) throw new Error('任务包不属于当前连接');
      return prepareComposerDraft(task, signal || this.shutdown.signal);
    }
    const client = await this.client(profile, signal);
    switch (operation) {
      case 'doctor':
        return { profile, user: await client.me(), configured: true, readOnly: !client.profile.allowWrites };
      case 'search': {
        const result = await client.search(queryJql(args), Number(args.limit) || 500);
        await jsonWrite(path.join(dataHome(), 'cache', `${profile}.json`), result);
        return result;
      }
      case 'issue': {
        const issue = await client.get(key(), args.comments !== false);
        return {
          ...issue,
          markdown: issueMarkdown(issue),
          bodyMarkdown: issueMarkdown(issue, new Map(), true, {
            includeMetadata: false,
            omitInlineAttachments: true,
          }),
        };
      }
      case 'export':
        return exportTasks(client, {
          keys: Array.isArray(args.keys) ? args.keys : [key()],
          outputDir: text('outputDir') || undefined,
          comments: args.comments !== false,
          attachments: ['images', 'all', 'none'].includes(args.attachments) ? args.attachments : 'images',
          zip: args.zip === true,
          signal,
        });
      case 'transitions':
        return client.transitions(key());
      case 'users':
        return assignableUsers(client, args.project, text('query', 'me'));
      case 'create-context':
        return createContext(client, args);
      case 'attachment-settings':
        return client.attachmentSettings();
      case 'attach': {
        if (args.apply !== true) {
          const issue = await client.get(key(), false);
          const images = imageManifest(await prepareImages(client, args.imagePaths));
          return {
            apply: false,
            ready: true,
            key: issue.key,
            images,
            requestId: args.requestId || randomUUID(),
          };
        }
        if (!args.requestId) throw new Error('上传需要 requestId；请复用预览或创建返回的上传标识');
        return uploadImages(client, key(), args.imagePaths, args.requestId, signal || this.shutdown.signal);
      }
      case 'create': {
        const withImages = args.imagePaths !== undefined;
        if (args.apply !== true) {
          const plan = await prepareCreate(client, args);
          const images = withImages ? imageManifest(await prepareImages(client, args.imagePaths)) : [];
          return { ...plan, ...(withImages ? { images } : {}), requestId: args.requestId || randomUUID() };
        }
        if (!client.profile.allowWrites) throw new Error('此连接处于只读模式，请在连接设置中启用 Jira 更新');
        if (!args.requestId) throw new Error('创建需要 requestId；请复用预览返回的标识，避免重复建单');
        let plan: Awaited<ReturnType<typeof prepareCreate>>;
        let images: ImageManifest[] = [];
        const created = (await this.mutate(
          profile,
          args,
          operation,
          async () => ({
            ...(await client.createPrepared(plan, true)),
            ...(withImages
              ? {
                  imageManifest: images,
                  uploadRequestId: creationUploadId(profile, args.requestId),
                }
              : {}),
          }),
          async () => {
            plan = await prepareCreate(client, args);
            if (!plan.ready)
              throw new Error(
                `缺少必填字段：${plan.missingFields.map((field) => `${field.name} (${field.key})`).join('、')}`,
              );
            if (withImages) images = imageManifest(await prepareImages(client, args.imagePaths));
          },
        )) as Awaited<ReturnType<JiraClient['createPrepared']>> & {
          imageManifest?: ImageManifest[];
          uploadRequestId?: string;
        };
        if (!created.imageManifest?.length) return created;
        try {
          const uploads = await uploadImages(
            client,
            created.key,
            args.imagePaths,
            created.uploadRequestId!,
            signal || this.shutdown.signal,
            created.imageManifest,
          );
          return { ...created, uploads };
        } catch (error) {
          // Creation already succeeded and was durably recorded. Always expose its
          // key, even if reading an attachment or persisting upload progress fails.
          return {
            ...created,
            uploads: {
              complete: false,
              requestId: created.uploadRequestId,
              error: message(error),
              instruction: '任务已创建，请对该编号补传图片，不要重新建单',
            },
          };
        }
      }
      case 'transition-context': {
        // Jira search can truncate updated to whole seconds. Write preconditions
        // must come from the authoritative detail endpoint, never the board row.
        const issue = await client.get(key(), false);
        if (!issue.updated) throw new Error('无法获取任务版本，请刷新任务与流转后重试');
        const transitions = await client.transitions(issue.key);
        return { issue, transitions };
      }
      case 'transition':
        return this.mutate(profile, args, operation, () =>
          client.transition(
            key(),
            text('transitionId'),
            args.fields || {},
            text('comment'),
            text('expectedUpdated'),
            args.apply === true,
          ),
        );
      case 'update':
        return this.mutate(profile, args, operation, () =>
          client.update(key(), args.fields || {}, text('expectedUpdated'), args.apply === true),
        );
      case 'comment':
        return this.mutate(profile, args, operation, () =>
          client.comment(key(), text('body'), args.apply === true),
        );
      case 'history':
        return client.history(key());
      case 'sprints':
        return client.sprints(args.project);
      case 'weekly':
        return weeklyReport(
          client,
          text('start') || undefined,
          text('end') || undefined,
          text('jql') || undefined,
        );
      default:
        throw new Error(`未知操作：${operation}`);
    }
  }
  private async mutate(
    profile: string,
    args: Args,
    operation: string,
    task: () => Promise<unknown>,
    prepare?: () => Promise<void>,
  ): Promise<unknown> {
    const operationId = validId(args.requestId || randomUUID());
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          profile,
          operation,
          key: args.key,
          fields: args.fields,
          body: args.body,
          comment: args.comment,
          transitionId: args.transitionId,
          expectedUpdated: args.expectedUpdated,
          ...(operation === 'create'
            ? {
                project: args.project,
                issueType: args.issueType,
                summary: args.summary,
                description: args.description,
                assignee: args.assignee,
                sprint: args.sprint,
                imagePaths: args.imagePaths,
              }
            : {}),
        }),
      )
      .digest('hex');
    return withLock(`op-${operationId}`, async () => {
      const file = path.join(dataHome(), 'operations', `${operationId}.json`);
      const prior = await jsonRead<any>(file, null);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('操作标识已用于其他请求');
        if (prior.state === 'confirmed') return prior.result;
        throw new Error('此操作之前的结果尚未确认，请先检查 Jira，不能自动重试');
      }
      await prepare?.();
      await jsonWrite(file, {
        id: operationId,
        profile,
        key: args.key,
        operation,
        fingerprint,
        state: 'pending',
        at: new Date().toISOString(),
      });
      try {
        const result = await task();
        await jsonWrite(file, {
          id: operationId,
          profile,
          key: args.key,
          operation,
          fingerprint,
          state: 'confirmed',
          at: new Date().toISOString(),
          result,
        });
        return result;
      } catch (error) {
        await jsonWrite(file, {
          id: operationId,
          profile,
          key: args.key,
          operation,
          fingerprint,
          state: 'unconfirmed',
          at: new Date().toISOString(),
          error: message(error),
        });
        throw error;
      }
    });
  }
  async package(id: string): Promise<TaskPackage> {
    const record = await jsonRead<{ directory: string }>(
      path.join(dataHome(), 'packages', `${validId(id)}.json`),
    );
    const task = await jsonRead<TaskPackage>(path.join(record.directory, 'manifest.json'));
    task.markdown = await readFile(path.join(record.directory, 'combined.md'), 'utf8');
    return task;
  }
  private async dispatch(profile: string, args: Args, signal: AbortSignal): Promise<RunRecord> {
    const adapter = this.adapter;
    if (!adapter) throw new Error('当前运行方式不能投递 DSH 会话；请复制执行指令到目标 agent');
    const id = validId(args.runId || randomUUID());
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          profile,
          packageId: args.packageId,
          sessionId: args.sessionId,
          workspace: args.workspace,
          agentPreset: args.agentPreset,
          prompt: args.prompt,
          includeImages: args.includeImages,
        }),
      )
      .digest('hex');
    return withLock(`run-${id}`, async () => {
      const file = path.join(dataHome(), 'runs', `${id}.json`);
      let run = await jsonRead<RunRecord | null>(file, null);
      if (run && run.fingerprint !== fingerprint) throw new Error('派发参数已改变，请新建一次派发');
      if (run?.state === 'delivered') return run;
      const task = await this.package(String(args.packageId));
      if (task.profile !== profile) throw new Error('任务包与所选 Jira 连接不匹配');
      const config = await getProfile(profile);
      if (!task.keys.length) throw new Error('任务包没有成功导出的任务');
      if (run && (run.packageId !== task.id || run.profile !== profile))
        throw new Error('此派发标识已绑定其他任务包');
      run ||= {
        id,
        profile,
        packageId: task.id,
        keys: task.keys,
        fingerprint,
        state: 'prepared',
        createdAt: new Date().toISOString(),
        requestId: `jira-flow-${id}`,
      };
      if (!run.sessionReady) {
        run.sessionId ||= args.sessionId || `jira-flow-${id}`;
        await jsonWrite(file, run);
        if (!args.sessionId) {
          const cwd = args.workspace || config.workspace;
          if (!cwd || !path.isAbsolute(cwd)) throw new Error('请指定新会话的绝对代码目录');
          run.sessionId = await adapter.create(
            {
              cwd,
              agentPreset: args.agentPreset || config.agentPreset || undefined,
              sessionId: run.sessionId!,
              title: `[Jira] ${task.keys.join(', ')}`,
            },
            signal,
          );
        }
        run.sessionReady = true;
        await jsonWrite(file, run);
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      try {
        await adapter.send(run.sessionId!, run.requestId, task, prompt, args.includeImages !== false, signal);
        run.state = 'delivered';
        delete run.error;
      } catch (error) {
        run.state = 'delivery-unknown';
        run.error = message(error);
        await jsonWrite(file, run);
        throw error;
      }
      await jsonWrite(file, run);
      return run;
    });
  }
  dispose(): void {
    this.shutdown.abort();
  }
}
