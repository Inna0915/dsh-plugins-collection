import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
  useId,
  memo,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  Issue,
  Profile,
  Column,
  SearchResult,
  TaskPackage,
  Transition,
  TransitionContext,
  JiraField,
  RunRecord,
  ComposerDraft,
} from '../types.js';
import type { CaptureComposer } from './composer.js';
import { api, assetUrl, bootstrap, copy, loadIssue, invalidateReads, type IssueDetail } from './api.js';
import { ImageViewer, useOverlay, type PreviewImage } from './overlays.js';
import { resolveAttachment } from '../core/assets.js';
import { useTaskDrag, useCardMotion } from './drag.js';
import { requiresTransitionInput } from '../shared/workflow.js';
import styles from './styles.css';

const columns: Array<{ id: Column; name: string; description: string }> = [
  { id: 'todo', name: '待办', description: '准备开始' },
  { id: 'doing', name: '处理中', description: '正在推进' },
  { id: 'review', name: '待验证', description: '测试与验收' },
  { id: 'done', name: '已完成', description: '最终状态' },
];
const errorText = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? '请求超时，请检查连接后重试'
    : error instanceof Error
      ? error.message
      : '操作失败';
const shortDate = (value: string) => (value ? value.slice(0, 10) : '');
const typeName = (type: string) =>
  /bug/i.test(type) ? 'BUG' : /story/i.test(type) ? 'STORY' : type.toUpperCase();
const icons = { refresh: '↻', close: '×', export: '↗', copy: '⧉', settings: '⚙', plus: '＋' };
export function Style() {
  return <style data-jira-flow>{styles}</style>;
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useOverlay(ref, onClose);
  return (
    <div
      className="jf-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className={`jf-modal ${wide ? 'jf-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="jf-icon" aria-label="关闭" onClick={onClose}>
            {icons.close}
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function TaskImage({
  profile,
  issue,
  src,
  id,
  alt,
  updated,
  onPreview,
}: {
  profile: string;
  issue: string;
  src?: string;
  id?: string;
  alt?: string;
  updated: string;
  onPreview: (image: PreviewImage) => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setError('');
    setUrl('');
    void assetUrl(profile, issue, id, src, updated)
      .then((value) => {
        objectUrl = value;
        if (alive) setUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profile, issue, src, id, updated]);
  return error ? (
    <span className="jf-image-error">
      {alt || '图片'}：{error}
    </span>
  ) : url ? (
    <button
      className="jf-image-button"
      type="button"
      onClick={() => onPreview({ url, alt: alt || '任务图片' })}
      aria-label={`放大查看 ${alt || '任务图片'}`}
    >
      <img src={url} alt={alt || '任务图片'} loading="lazy" />
      <span className="jf-image-hint">⤢ 点击放大</span>
    </button>
  ) : (
    <span className="jf-image-loading">正在加载 {alt || '图片'}…</span>
  );
}
const TaskMarkdown = memo(function TaskMarkdown({
  value,
  profile,
  issue,
}: {
  value: string;
  profile: string;
  issue: Issue;
}) {
  const [preview, setPreview] = useState<PreviewImage>();
  const components = useMemo(
    () => ({
      a: ({ children, href }: any) => (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ),
      img: ({ src, alt }: any) => {
        const source = typeof src === 'string' ? src : '';
        const attachment = resolveAttachment(issue, source);
        return (
          <TaskImage
            profile={profile}
            issue={issue.key}
            src={attachment ? undefined : source}
            id={attachment?.id}
            alt={alt}
            updated={issue.updated}
            onPreview={setPreview}
          />
        );
      },
    }),
    [issue, profile],
  );
  return (
    <>
      <div className="jf-markdown">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {value}
        </Markdown>
      </div>
      {preview && <ImageViewer image={preview} onClose={() => setPreview(undefined)} />}
    </>
  );
});
function Settings({
  profile,
  onClose,
  onSaved,
}: {
  profile?: Profile;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [config, setConfig] = useState<Partial<Profile>>(
    profile || {
      id: 'work-jira',
      name: '工作 Jira',
      projectKeys: [],
      allowWrites: false,
      host: '',
      credentialStore: 'windows-dpapi',
    },
  );
  const [projects, setProjects] = useState(profile?.projectKeys.join(', ') || '');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [mapping, setMapping] = useState(JSON.stringify(profile?.statusColumns || {}, null, 2));
  const save = async (importing = false) => {
    setBusy(true);
    setError('');
    try {
      if (importing)
        await api('settings.import', { source, profile: config.id, workspace: config.workspace });
      else
        await api('settings.save', {
          config: {
            ...config,
            projectKeys: projects.split(/[,，\s]+/).filter(Boolean),
            statusColumns: JSON.parse(mapping),
          },
          ...(secret ? { auth: { kind: 'basic', username, secret } } : {}),
        });
      setSecret('');
      await onSaved();
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const field = (name: keyof Profile, label: string, placeholder = '') => (
    <label>
      {label}
      <input
        value={String(config[name] ?? '')}
        placeholder={placeholder}
        onChange={(event) => setConfig({ ...config, [name]: event.target.value })}
      />
    </label>
  );
  return (
    <Modal title="Jira 连接与工作区" onClose={onClose}>
      <div className="jf-modal-body jf-form">
        <p className="jf-muted">
          连接可供看板、CLI 和其他 agent 共用。凭证由当前 Windows 用户保护，不写入 Skill。
        </p>
        <div className="jf-form-grid">
          {field('id', '连接别名', 'work-jira')}
          {field('name', '显示名称', '工作 Jira')}
          {field('host', 'Jira API 地址', 'https://jira.example.com')}
          {field('browseHost', '浏览地址（可留空）')}
          <label>
            项目 Key
            <input
              value={projects}
              onChange={(event) => setProjects(event.target.value)}
              placeholder="PROJ，多个项目以逗号分隔"
            />
          </label>
          {field('workspace', '默认代码目录', 'D:\\dev\\project')}
        </div>
        <div className="jf-form-grid">
          <label>
            用户名
            <input
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="仅更换凭证时填写"
            />
          </label>
          <label>
            密码 / Token
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="留空保留已保存凭证"
            />
          </label>
        </div>
        <label className="jf-check">
          <input
            type="checkbox"
            checked={config.allowWrites === true}
            onChange={(event) => setConfig({ ...config, allowWrites: event.target.checked })}
          />
          允许更新 Jira 字段、评论和状态
        </label>
        <button className="jf-text-button" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '收起' : '展开'}字段与状态映射
        </button>
        {advanced && (
          <>
            <div className="jf-form-grid">
              {field('storyPointsField', '故事点字段', 'customfield_10111')}
              {field('dueDateField', '截止日期字段', 'duedate')}
              {field('sprintField', '迭代字段', 'customfield_10109')}
              {field('agentPreset', '默认 Agent 预设 ID')}
            </div>
            {field('jql', '默认 JQL')}
            <label>
              状态映射（状态 ID / 名称 → todo、doing、review、done）
              <textarea rows={5} value={mapping} onChange={(event) => setMapping(event.target.value)} />
            </label>
          </>
        )}
        <details>
          <summary>从 Obsidian Jira Flow 导入</summary>
          <label>
            插件 data.json 的绝对路径
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="…/.obsidian/plugins/obsidian-jira-flow/data.json"
            />
          </label>
          <button disabled={busy || !source} onClick={() => void save(true)}>
            导入并保护凭证
          </button>
        </details>
        {error && (
          <p className="jf-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button onClick={onClose}>取消</button>
        <button className="jf-primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存连接'}
        </button>
      </footer>
    </Modal>
  );
}
function ExportModal({
  keys,
  profile,
  onClose,
  onReady,
}: {
  keys: string[];
  profile: Profile;
  onClose: () => void;
  onReady: (task: TaskPackage) => void;
}) {
  const [directory, setDirectory] = useState(
    profile.workspace ? `${profile.workspace}/.jira-flow/packages` : '',
  );
  const [comments, setComments] = useState(true);
  const [attachments, setAttachments] = useState('images');
  const [zip, setZip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const task = await api<TaskPackage>('export', {
        profile: profile.id,
        keys,
        outputDir: directory,
        comments,
        attachments,
        zip,
      });
      onReady(task);
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`导出 ${keys.length} 个任务`} onClose={onClose}>
      <div className="jf-modal-body jf-form">
        <p className="jf-key-list">{keys.join(' · ')}</p>
        <label>
          导出到
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="留空保存在任务看板用户目录"
          />
        </label>
        <label>
          附件
          <select value={attachments} onChange={(event) => setAttachments(event.target.value)}>
            <option value="images">下载所有图片</option>
            <option value="all">下载所有附件</option>
            <option value="none">仅 Markdown 与附件链接</option>
          </select>
        </label>
        <label className="jf-check">
          <input type="checkbox" checked={comments} onChange={(event) => setComments(event.target.checked)} />
          包含任务评论
        </label>
        <label className="jf-check">
          <input type="checkbox" checked={zip} onChange={(event) => setZip(event.target.checked)} />
          同时生成 ZIP，便于上传给远端 agent
        </label>
        <p className="jf-muted">任务包包含索引、逐条任务、图片及资源清单。接收它的 agent 无需 Jira 凭证。</p>
        {error && <p className="jf-error">{error}</p>}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="jf-primary" disabled={busy} onClick={() => void run()}>
          {busy ? '正在读取任务与下载附件…' : '生成图文任务包'}
        </button>
      </footer>
    </Modal>
  );
}
function PackageModal({
  task,
  onClose,
  onDispatch,
  onAdd,
  adding,
  notify,
}: {
  task: TaskPackage;
  onClose: () => void;
  onDispatch: () => void;
  onAdd?: () => void;
  adding?: boolean;
  notify: (text: string) => void;
}) {
  const failed = task.assets.filter((asset) => asset.status === 'failed');
  return (
    <Modal title="任务包已生成" onClose={onClose}>
      <div className="jf-modal-body">
        <div className="jf-success-card">
          <span>✓</span>
          <div>
            <strong>
              {task.keys.length} 个任务 · {task.assets.filter((a) => a.status === 'downloaded').length} 个附件
            </strong>
            <p>正文和资源已保存，可交给其他 agent。</p>
          </div>
        </div>
        <label className="jf-path-label">
          任务索引
          <input readOnly value={task.indexPath} onFocus={(event) => event.target.select()} />
        </label>
        <textarea readOnly rows={5} value={task.instruction} aria-label="执行指令" />
        {(failed.length > 0 || task.errors.length > 0) && (
          <div className="jf-warning">
            <strong>部分内容未完成导出</strong>
            {task.errors.map((error) => (
              <p key={error.key}>
                {error.key}：{error.error}
              </p>
            ))}
            {failed.map((asset) => (
              <p key={asset.issueKey + asset.attachmentId}>
                {asset.issueKey} / {asset.filename}：{asset.error}
              </p>
            ))}
          </div>
        )}
        <p className="jf-muted">
          同机 agent 可读取以上路径；远端 agent 需要上传整个任务包。Markdown
          中的图片路径不会单独复制图片文件。
        </p>
      </div>
      <footer className="jf-wrap">
        <button
          onClick={() =>
            void copy(task.indexPath)
              .then(() => notify('已复制索引路径'))
              .catch((error) => notify(errorText(error)))
          }
        >
          复制路径
        </button>
        <button
          onClick={() =>
            void copy(task.markdown)
              .then(() => notify('已复制 Markdown；图片位于任务包目录'))
              .catch((error) => notify(errorText(error)))
          }
        >
          复制 Markdown
        </button>
        <button
          className="jf-primary"
          onClick={() =>
            void copy(task.instruction)
              .then(() => notify('已复制执行指令'))
              .catch((error) => notify(errorText(error)))
          }
        >
          复制执行指令
        </button>
        {onAdd && (
          <button disabled={adding} onClick={onAdd}>
            {adding ? '添加中…' : '添加到当前会话'}
          </button>
        )}
        <button onClick={onDispatch}>交给 DSH agent</button>
      </footer>
    </Modal>
  );
}
function DispatchModal({
  task,
  profile,
  onClose,
  notify,
  onSent,
}: {
  task: TaskPackage;
  profile: Profile;
  onClose: () => void;
  notify: (text: string) => void;
  onSent: () => void;
}) {
  const [targets, setTargets] = useState<any>();
  const [target, setTarget] = useState('new');
  const [workspace, setWorkspace] = useState(profile.workspace);
  const [preset, setPreset] = useState(profile.agentPreset);
  const [prompt, setPrompt] = useState(
    '请根据任务正文与图片完成分析和实现，遵守代码工作区的 AGENTS.md，验证后报告结果。',
  );
  const [images, setImages] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const runId = useRef(crypto.randomUUID());
  useEffect(() => {
    void api('targets')
      .then(setTargets)
      .catch((error) => setError(errorText(error)));
  }, []);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api('dispatch', {
        profile: profile.id,
        packageId: task.id,
        runId: runId.current,
        sessionId: target === 'new' ? undefined : target,
        workspace,
        agentPreset: preset,
        prompt,
        includeImages: images,
      });
      notify('任务已投递；繁忙会话将排队处理');
      onSent();
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="交给 Agent" onClose={onClose}>
      <div className="jf-modal-body jf-form">
        <p className="jf-key-list">{task.keys.join(' · ')}</p>
        {targets?.available === false ? (
          <div className="jf-warning">
            此页面未运行在 DSH 内。请使用“复制执行指令”，或在 DSH 的任务看板中派发。
          </div>
        ) : (
          <>
            <label>
              目标会话
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                <option value="new">新建任务专属会话</option>
                {targets?.sessions?.map((session: any) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                    {session.running ? ' · 运行中' : ''}
                  </option>
                ))}
              </select>
            </label>
            {target === 'new' && (
              <>
                <label>
                  代码工作目录
                  <input
                    value={workspace}
                    onChange={(event) => setWorkspace(event.target.value)}
                    placeholder="输入绝对目录"
                  />
                </label>
                <label>
                  Agent 预设
                  <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                    <option value="">使用 DSH 默认预设</option>
                    {targets?.presets?.map((item: any) => (
                      <option key={item.id} value={item.id} disabled={!!item.broken}>
                        {item.name || item.id}
                        {item.broken ? '（不可用）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              执行要求
              <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            </label>
            <label className="jf-check">
              <input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />
              将图片直接附加到消息（需目标模型支持图片）
            </label>
            <p className="jf-muted">
              不附加图片时，agent 必须能访问任务包目录并具有读图工具。派发不会修改 Jira 经办人。
            </p>
          </>
        )}
        {error && <p className="jf-error">{error}</p>}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="jf-primary" disabled={busy || !targets?.available} onClick={() => void send()}>
          {busy ? '正在投递…' : '派发任务'}
        </button>
      </footer>
    </Modal>
  );
}
function TransitionModal({
  issue,
  profile,
  targetColumn,
  onClose,
  onUpdated,
  initialTarget,
}: {
  issue: Issue;
  profile: Profile;
  targetColumn?: Column;
  onClose: () => void;
  onUpdated: (issue: Issue) => void;
  initialTarget?: Transition;
}) {
  const transitionGroup = useId();
  const [transitions, setTransitions] = useState<Transition[]>(initialTarget ? [initialTarget] : []);
  const [currentIssue, setCurrentIssue] = useState<Issue>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [id, setId] = useState(initialTarget?.id || '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCurrentIssue(undefined);
    setError('');
    void api<TransitionContext>(
      'transition-context',
      { profile: profile.id, key: issue.key },
      controller.signal,
    )
      .then(({ issue: current, transitions: rows }) => {
        if (controller.signal.aborted) return;
        setCurrentIssue(current);
        setTransitions(rows);
        setId((previous) =>
          rows.some((row) => row.id === previous) ? previous : rows.length === 1 ? rows[0].id : '',
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [profile.id, issue.key, refreshVersion]);
  const selected = transitions.find((t) => t.id === id);
  const submit = async () => {
    if (!currentIssue || loading || busy || !selected) return;
    setBusy(true);
    setError('');
    try {
      const fields: Record<string, unknown> = {};
      for (const [key, definition] of Object.entries(selected?.fields || {})) {
        if (key === 'comment') continue;
        const value = values[key];
        if (!value) continue;
        if (definition.allowedValues?.length) {
          const allowed = definition.allowedValues.find(
            (item) => (item.id || item.value || item.name) === value,
          );
          const item = allowed?.id
            ? { id: allowed.id }
            : allowed?.value
              ? { value: allowed.value }
              : { name: allowed?.name };
          fields[key] = definition.schema?.type === 'array' ? [item] : item;
        } else if (definition.schema?.type === 'number') fields[key] = Number(value);
        else if (key === 'assignee') fields[key] = { name: value };
        else if (['object', 'array'].includes(definition.schema?.type || '')) fields[key] = JSON.parse(value);
        else fields[key] = value;
      }
      const updated = await api<Issue>('transition', {
        profile: profile.id,
        key: issue.key,
        transitionId: id,
        fields,
        comment,
        expectedUpdated: currentIssue.updated,
        apply: true,
        requestId: crypto.randomUUID(),
      });
      invalidateReads();
      onUpdated(updated);
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`更新 ${issue.key} 状态`} onClose={onClose}>
      <div className="jf-modal-body jf-form">
        <p>
          当前：<strong>{currentIssue?.status.name || issue.status.name}</strong>
          {targetColumn && (
            <> · 选择移至“{columns.find((c) => c.id === targetColumn)?.name}”的具体 Jira 流转</>
          )}
        </p>
        <fieldset className="jf-transition-options" disabled={busy || loading || !currentIssue}>
          <legend>可用流转</legend>
          {loading ? (
            <p className="jf-muted">正在读取可用流转…</p>
          ) : transitions.length === 0 ? (
            <p className="jf-muted">当前没有可用流转</p>
          ) : (
            transitions.map((t) => (
              <label key={t.id} className={`jf-transition-option ${id === t.id ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name={transitionGroup}
                  value={t.id}
                  checked={id === t.id}
                  onChange={() => {
                    setId(t.id);
                    setValues({});
                  }}
                />
                <span>
                  <strong>{t.name}</strong>
                  <small>→ {t.to.name}</small>
                </span>
              </label>
            ))
          )}
        </fieldset>
        {selected &&
          Object.entries(selected.fields)
            .filter(([key]) => key !== 'comment')
            .map(([key, definition]) => (
              <label key={key}>
                {definition.name}
                {definition.required ? ' *' : ''}
                {definition.allowedValues?.length ? (
                  <select
                    value={values[key] || ''}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  >
                    <option value="">请选择</option>
                    {definition.allowedValues.map((item, index) => (
                      <option key={item.id || index} value={item.id || item.value || item.name}>
                        {item.name || item.value || item.displayName || item.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={values[key] || ''}
                    type={definition.schema?.type === 'number' ? 'number' : 'text'}
                    placeholder={
                      ['object', 'array'].includes(definition.schema?.type || '')
                        ? '输入 JSON'
                        : key === 'assignee'
                          ? 'Jira 用户名'
                          : ''
                    }
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  />
                )}
              </label>
            ))}
        <label>
          备注{selected?.fields.comment?.required ? ' *' : ''}
          <textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        {!profile.allowWrites && <p className="jf-warning">此连接为只读，请先在连接设置中启用 Jira 更新。</p>}
        {error && <p className="jf-error">{error}</p>}
      </div>
      <footer>
        {error && (
          <button disabled={busy || loading} onClick={() => setRefreshVersion((version) => version + 1)}>
            刷新任务与流转
          </button>
        )}
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="jf-primary"
          disabled={busy || loading || !currentIssue || !selected || !profile.allowWrites}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '更新 Jira'}
        </button>
      </footer>
    </Modal>
  );
}
function Detail({
  taskKey,
  seed,
  refreshVersion,
  profile,
  onClose,
  onExport,
  onAdd,
  adding,
  onTransition,
  onUpdated,
  notify,
}: {
  taskKey: string;
  seed?: Issue;
  refreshVersion: number;
  profile: Profile;
  onClose: () => void;
  onExport: (keys: string[]) => void;
  onAdd?: (keys: string[]) => void;
  adding?: boolean;
  onTransition: (issue: Issue) => void;
  onUpdated: (issue: Issue) => void;
  notify: (message: string) => void;
}) {
  const [issue, setIssue] = useState<IssueDetail>();
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(ref, onClose);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState('');
  const [points, setPoints] = useState('');
  const [comment, setComment] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const load = useCallback(
    async (refresh = false) => {
      setError('');
      const issue = await loadIssue(profile.id, taskKey, seed?.updated, refresh);
      setIssue(issue);
      setDue(shortDate(issue.dueDate));
      setPoints(issue.storyPoints === null ? '' : String(issue.storyPoints));
      return issue;
    },
    [profile.id, taskKey, seed?.updated, refreshVersion],
  );
  useEffect(() => {
    void load().catch((error) => setError(errorText(error)));
  }, [load]);
  useEffect(() => {
    let active = true;
    void api<any[]>('results', { profile: profile.id, key: taskKey })
      .then((value) => {
        if (active) setResults(value);
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [profile.id, taskKey]);
  const update = async (isComment = false) => {
    setBusy(true);
    try {
      if (isComment)
        await api('comment', {
          profile: profile.id,
          key: taskKey,
          body: comment,
          apply: true,
          requestId: crypto.randomUUID(),
        });
      else {
        const fields: Record<string, unknown> = {};
        if (due !== shortDate(issue?.dueDate || '')) fields[profile.dueDateField] = due || null;
        if (points !== (issue?.storyPoints === null ? '' : String(issue?.storyPoints)))
          fields[profile.storyPointsField] = points === '' ? null : Number(points);
        await api('update', {
          profile: profile.id,
          key: taskKey,
          fields,
          expectedUpdated: issue?.updated,
          apply: true,
          requestId: crypto.randomUUID(),
        });
      }
      setComment('');
      invalidateReads();
      const refreshed = await load(true);
      onUpdated(refreshed);
      notify('Jira 已更新');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="jf-drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="jf-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`任务详情 ${taskKey}`}
      >
        <header>
          <div className="jf-card-meta">
            <span className={`jf-type ${/bug/i.test((issue || seed)?.type || '') ? 'jf-bug' : 'jf-story'}`}>
              {typeName((issue || seed)?.type || 'Task')}
            </span>
            <a href={(issue || seed)?.url} target="_blank" rel="noreferrer">
              {taskKey} ↗
            </a>
            {(issue || seed) && (
              <span className={`jf-status jf-status-${(issue || seed)!.column}`}>
                {(issue || seed)!.status.name}
              </span>
            )}
          </div>
          <button className="jf-icon" aria-label="关闭详情" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <p className="jf-error">{error}</p>}
        {!issue ? (
          <>
            <h2 className="jf-detail-seed-title">{seed?.summary}</h2>
            <div className="jf-loading">正在读取任务正文…</div>
          </>
        ) : (
          <>
            <div className="jf-detail-title">
              <h2>{issue.summary}</h2>
            </div>
            <div className="jf-detail-actions">
              <button
                onClick={() =>
                  void copy(issue.markdown)
                    .then(() => notify('完整 Markdown 已复制；图片保留来源引用'))
                    .catch((error) => notify(errorText(error)))
                }
              >
                复制完整 Markdown
              </button>
              <button onClick={() => onExport([issue.key])}>图文任务包</button>
              {onAdd && (
                <button disabled={adding} onClick={() => onAdd([issue.key])}>
                  {adding ? '添加中…' : '添加到当前会话'}
                </button>
              )}
              <button disabled={!profile.allowWrites} onClick={() => onTransition(issue)}>
                更新状态
              </button>
            </div>
            <div className="jf-detail-meta">
              <span>
                负责人 <strong>{issue.assignee || '未分配'}</strong>
              </span>
              <span>
                迭代 <strong>{issue.sprint || '—'}</strong>
              </span>
              <span>
                优先级 <strong>{issue.priority || '—'}</strong>
              </span>
              <span>
                更新 <strong>{shortDate(issue.updated)}</strong>
              </span>
              <span>
                报告人 <strong>{issue.reporter || '—'}</strong>
              </span>
              <span>
                截止 <strong>{shortDate(issue.dueDate) || '—'}</strong> · 故事点{' '}
                <strong>{issue.storyPoints ?? '—'}</strong>
              </span>
            </div>
            <details className="jf-edit-fields">
              <summary>更新计划 / 写入进度</summary>
              <div className="jf-form">
                <div className="jf-form-grid">
                  <label>
                    截止日期
                    <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
                  </label>
                  <label>
                    故事点
                    <input
                      type="number"
                      min="0"
                      value={points}
                      onChange={(event) => setPoints(event.target.value)}
                    />
                  </label>
                </div>
                <button disabled={!profile.allowWrites || busy} onClick={() => void update()}>
                  保存字段到 Jira
                </button>
                <label>
                  进度评论
                  <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} />
                </label>
                <button
                  disabled={!profile.allowWrites || busy || !comment.trim()}
                  onClick={() => void update(true)}
                >
                  添加评论
                </button>
              </div>
            </details>
            {results.length > 0 && (
              <section className="jf-results">
                <h3>Agent 执行结果</h3>
                {results.map((result, index) => (
                  <details key={result.batchId + index}>
                    <summary>
                      {shortDate(result.importedAt)} · {result.summary.slice(0, 80)}
                    </summary>
                    <p>{result.summary}</p>
                    <p>
                      <strong>验证：</strong>
                      {result.verification}
                    </p>
                    {result.remaining && (
                      <p>
                        <strong>剩余：</strong>
                        {result.remaining}
                      </p>
                    )}
                    <button
                      onClick={() => {
                        setComment(
                          `${result.summary}\n\n验证：${result.verification}\n${result.remaining ? `剩余：${result.remaining}` : ''}`,
                        );
                        notify('已填入进度评论，可展开“更新计划 / 写入进度”检查后提交');
                      }}
                    >
                      填入进度评论
                    </button>
                  </details>
                ))}
              </section>
            )}
            <TaskMarkdown value={issue.bodyMarkdown} profile={profile.id} issue={issue} />
          </>
        )}
      </div>
    </div>
  );
}
function WeeklyModal({
  profile,
  onClose,
  notify,
}: {
  profile: Profile;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [report, setReport] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const generate = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(
        await api('weekly', {
          profile: profile.id,
          start: start ? `${start}T00:00:00+08:00` : undefined,
          end: end ? `${end}T00:00:00+08:00` : undefined,
        }),
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="周报事实清单" onClose={onClose} wide>
      <div className="jf-modal-body">
        <div className="jf-form-grid jf-form">
          <label>
            开始（留空为本周一）
            <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
          </label>
          <label>
            结束（不包含当天）
            <input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
          </label>
        </div>
        <p className="jf-muted">
          以 Jira 状态历史统计开发完成、最终状态和重开事件。AI 可据此撰写周报；历史缺口会明确列出。
        </p>
        {error && <p className="jf-error">{error}</p>}
        {report && (
          <>
            <div className="jf-report-stats">
              {Object.entries({
                开发里程碑: report.counts.development,
                最终状态: report.counts.business,
                重开返工: report.counts.reopened,
                当前在途: report.counts.active,
              }).map(([name, count]) => (
                <div key={name}>
                  <strong>{String(count)}</strong>
                  <span>{name}</span>
                </div>
              ))}
            </div>
            {!report.complete && (
              <p className="jf-warning">本次历史数据不完整，不能作为完整统计；详见数据缺口。</p>
            )}
            <div className="jf-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{report.markdown}</Markdown>
            </div>
          </>
        )}
      </div>
      <footer>
        <button onClick={onClose}>关闭</button>
        {report && (
          <button
            onClick={() =>
              void copy(report.markdown)
                .then(() => notify('周报事实清单已复制'))
                .catch((error) => notify(errorText(error)))
            }
          >
            复制周报
          </button>
        )}
        <button className="jf-primary" disabled={busy} onClick={() => void generate()}>
          {busy ? '正在读取历史…' : report ? '重新生成' : '生成本周事实清单'}
        </button>
      </footer>
    </Modal>
  );
}
export function App({
  workspacePane = false,
  active = true,
  onOpenWorkspace,
  onOpenFullPage,
  bindRefresh,
  captureComposer,
}: {
  workspacePane?: boolean;
  active?: boolean;
  onOpenWorkspace?: () => void;
  onOpenFullPage?: () => void;
  bindRefresh?: (refresh: () => void) => () => void;
  captureComposer?: CaptureComposer;
} = {}) {
  const appRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = appRef.current!;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      root.style.setProperty('--jf-overlay-top', `${Math.max(0, rect.top)}px`);
      root.style.setProperty('--jf-overlay-left', `${Math.max(0, rect.left)}px`);
      root.style.setProperty('--jf-overlay-right', `${Math.max(0, window.innerWidth - rect.right)}px`);
      root.style.setProperty('--jf-overlay-bottom', `${Math.max(0, window.innerHeight - rect.bottom)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (root.parentElement) observer.observe(root.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const [connections, setConnections] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncState, setSyncState] = useState<'loading' | 'fresh' | 'error' | 'idle'>('idle');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const searchController = useRef<AbortController | undefined>(undefined);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [text, setText] = useState('');
  const [type, setType] = useState('all');
  const [sprint, setSprint] = useState('');
  const [scope, setScope] = useState('configured');
  const [includeDone, setIncludeDone] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState('');
  const [settings, setSettings] = useState(false);
  const [exportKeys, setExportKeys] = useState<string[]>();
  const [taskPackage, setTaskPackage] = useState<TaskPackage>();
  const [dispatch, setDispatch] = useState(false);
  const [transition, setTransition] = useState<{ issue: Issue; target?: Transition }>();
  const [pendingKey, setPendingKey] = useState('');
  const [movedKey, setMovedKey] = useState('');
  const [weekly, setWeekly] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [copying, setCopying] = useState(false);
  const [copyingKey, setCopyingKey] = useState('');
  const [adding, setAdding] = useState(false);
  const addingController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => addingController.current?.abort(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastIndex = useRef<number | undefined>(undefined);
  const profile = connections.find((c) => c.id === profileId);
  const fetchId = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!movedKey) return;
    const timer = setTimeout(() => setMovedKey(''), 1200);
    return () => clearTimeout(timer);
  }, [movedKey]);
  const loadConnections = useCallback(async () => {
    const values = await api<Profile[]>('profiles');
    setConnections(values);
    setProfileId((old) => (values.some((profile) => profile.id === old) ? old : values[0]?.id || ''));
    if (!values.length) setSettings(true);
  }, []);
  useEffect(() => {
    void bootstrap()
      .then(loadConnections)
      .catch((error) => setError(errorText(error)));
  }, [loadConnections]);
  const refreshRuns = useCallback(async () => {
    if (profileId) setRuns(await api('runs', { profile: profileId }));
  }, [profileId]);
  useEffect(() => {
    setSelected(new Set());
    setDetail('');
    setData(null);
    setScope('configured');
    setQuery('');
    setSprint('');
    setText('');
    invalidateReads();
    if (profile) {
      const id = ++fetchId.current;
      const controller = new AbortController();
      searchController.current?.abort();
      searchController.current = controller;
      let fresh = false;
      setLoading(true);
      setError('');
      setSyncState('loading');
      void api<SearchResult | null>('cache', { profile: profileId })
        .then((value) => {
          if (!fresh && id === fetchId.current) setData(value);
        })
        .catch(() => undefined);
      void api<SearchResult>(
        'search',
        { profile: profileId, jql: profile.jql, limit: 1000 },
        controller.signal,
      )
        .then((value) => {
          fresh = true;
          if (id === fetchId.current) {
            setData(value);
            setSyncState('fresh');
            setRefreshVersion((version) => version + 1);
          }
        })
        .catch((error) => {
          if (id === fetchId.current && !controller.signal.aborted) {
            setError(errorText(error));
            setSyncState('error');
          }
        })
        .finally(() => {
          if (id === fetchId.current) setLoading(false);
        });
      void refreshRuns().catch((error) => setError(errorText(error)));
    }
    return () => {
      searchController.current?.abort();
      fetchId.current++;
    };
  }, [profile, profileId, refreshRuns]);
  const sync = useCallback(async () => {
    if (!profile) return;
    const id = ++fetchId.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    setSyncState('loading');
    setError('');
    invalidateReads();
    try {
      const base =
        scope === 'mine'
          ? 'assignee = currentUser()'
          : scope === 'reported'
            ? 'reporter = currentUser()'
            : scope === 'project'
              ? ''
              : scope === 'custom'
                ? query
                : profile.jql;
      const jql = ['configured', 'custom'].includes(scope)
        ? base
        : `${base}${!includeDone ? `${base ? ' AND ' : ''}statusCategory != Done` : ''} ORDER BY updated DESC`;
      const value = await api<SearchResult>(
        'search',
        { profile: profile.id, jql, limit: 1000 },
        controller.signal,
      );
      if (id === fetchId.current) {
        const previous = new Map(dataRef.current?.issues.map((issue) => [issue.key, issue]));
        const changed = value.issues.filter(
          (issue) =>
            previous.get(issue.key)?.updated !== issue.updated ||
            previous.get(issue.key)?.status.id !== issue.status.id ||
            previous.get(issue.key)?.summary !== issue.summary,
        ).length;
        setData(value);
        setSyncState('fresh');
        setRefreshVersion((version) => version + 1);
        notify(`刷新完成：${value.issues.length} 条任务，${changed} 条新增或变化`);
        setSelected(
          (previous) =>
            new Set([...previous].filter((key) => value.issues.some((issue) => issue.key === key))),
        );
      }
    } catch (error) {
      if (id === fetchId.current && !controller.signal.aborted) {
        setError(errorText(error));
        setSyncState('error');
      }
    } finally {
      if (id === fetchId.current) setLoading(false);
    }
  }, [profile, scope, includeDone, query]);
  const sprintOptions = useMemo(
    () => [...new Set((data?.issues || []).map((issue) => issue.sprint).filter(Boolean))],
    [data],
  );
  const activeSprint =
    sprint === 'all' ? 'all' : sprintOptions.includes(sprint) ? sprint : sprintOptions[0] || 'all';
  const deferredText = useDeferredValue(text);
  const visible = useMemo(() => {
    const search = deferredText.trim().toLowerCase();
    return (data?.issues || []).filter(
      (issue) =>
        (type === 'all' ||
          (/bug/i.test(issue.type) ? 'bug' : /story/i.test(issue.type) ? 'story' : 'task') === type) &&
        (activeSprint === 'all' || issue.sprint === activeSprint) &&
        (!search || `${issue.key} ${issue.summary} ${issue.assignee}`.toLowerCase().includes(search)),
    );
  }, [data, type, activeSprint, deferredText]);
  const captureCards = useCardMotion(boardRef, visible);
  const updateIssue = useCallback((updated: Issue) => {
    captureCards();
    setMovedKey(updated.key);
    setData((previous) =>
      previous
        ? {
            ...previous,
            issues: previous.issues.map((issue) => (issue.key === updated.key ? updated : issue)),
          }
        : previous,
    );
  }, []);
  const drag = useTaskDrag(profile, (issue, target) => {
    if (pendingKey || !profile?.allowWrites) return;
    if (requiresTransitionInput(target)) {
      setTransition({ issue, target });
      return;
    }
    setPendingKey(issue.key);
    void api<Issue>('transition', {
      profile: profile.id,
      key: issue.key,
      transitionId: target.id,
      fields: {},
      comment: '',
      expectedUpdated: issue.updated,
      apply: true,
      requestId: crypto.randomUUID(),
    })
      .then((updated) => {
        invalidateReads();
        updateIssue(updated);
        notify(`${updated.key} 已移至「${updated.status.name}」`);
      })
      .catch((error) => setError(`流转未确认：${errorText(error)}。请刷新核实，未自动重试。`))
      .finally(() => setPendingKey(''));
  });
  useEffect(() => {
    if (!active) drag.clear();
  }, [active]);
  useEffect(
    () =>
      bindRefresh?.(() => {
        if (!pendingKey && !drag.drag) void sync();
      }),
    [bindRefresh, sync, pendingKey, drag.drag],
  );
  const addToComposer = async (keys: string[], prepared?: TaskPackage) => {
    if (!captureComposer || addingController.current) return;
    const controller = new AbortController();
    addingController.current = controller;
    setAdding(true);
    let task = prepared;
    try {
      const insert = captureComposer();
      task ||= await api<TaskPackage>(
        'export',
        { profile: profileId, keys, attachments: 'images' },
        controller.signal,
      );
      if (!task.keys.length) throw new Error('没有可添加的任务，请检查任务包中的错误');
      const draft = await api<ComposerDraft>(
        'draft',
        { profile: profileId, packageId: task.id },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const warnings = insert(draft);
      setTaskPackage(undefined);
      setDetail('');
      notify(`已添加 ${task.keys.length} 个任务到当前会话输入框，原草稿已保留，尚未发送`);
      if (warnings.length) setError(`正文已添加；${warnings.join('；')}。任务包：${task.indexPath}`);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (task) setTaskPackage(task);
        setError(errorText(error));
        notify(errorText(error));
      }
    } finally {
      addingController.current = undefined;
      setAdding(false);
    }
  };
  const copyIssue = async (issue: Issue) => {
    setCopyingKey(issue.key);
    try {
      const value = await loadIssue(profileId, issue.key, issue.updated);
      await copy(value.markdown);
      notify('已复制完整 Markdown');
    } catch (error) {
      notify(errorText(error));
    } finally {
      setCopyingKey('');
    }
  };
  const toggle = (key: string, event: React.MouseEvent | React.ChangeEvent, index: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if ('shiftKey' in event && event.shiftKey && lastIndex.current !== undefined) {
        for (const item of visible.slice(
          Math.min(lastIndex.current, index),
          Math.max(lastIndex.current, index) + 1,
        ))
          next.add(item.key);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastIndex.current = index;
  };
  const copySelected = async () => {
    setCopying(true);
    try {
      const result = await api<TaskPackage>('export', {
        profile: profileId,
        keys: [...selected],
        attachments: 'none',
      });
      await copy(result.markdown);
      notify(
        `已复制 ${result.keys.length} 个任务的完整 Markdown${result.errors.length ? `；${result.errors.length} 个失败，详情见任务包` : ''}`,
      );
      if (result.errors.length) setTaskPackage(result);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setCopying(false);
    }
  };
  const importResults = async (file: File) => {
    try {
      const result = await api('results.import', { profile: profileId, data: JSON.parse(await file.text()) });
      notify(`已导入 ${result.results.length} 条执行结果，尚未修改 Jira`);
      setText(result.results[0]?.key || '');
      setDetail(result.results[0]?.key || '');
    } catch (error) {
      setError(errorText(error));
    }
  };
  return (
    <div
      ref={appRef}
      inert={!active}
      className={`jf-app ${workspacePane ? 'jf-app-pane' : ''} ${drag.drag ? 'is-drag-active' : ''}`}
    >
      <Style />
      <header className="jf-topbar">
        <div className="jf-brand">
          <span aria-hidden="true">▤</span>
          <h1>任务看板</h1>
          <span className="jf-version">v0.1.8</span>
          <span className="jf-brand-note">Jira · Story · Bug</span>
          {(onOpenWorkspace || onOpenFullPage) && (
            <button
              className="jf-layout-action"
              disabled={!!pendingKey || !!drag.drag}
              title={workspacePane ? '打开完整任务看板' : '与会话并排显示，可拖动标签页分栏'}
              onClick={() => {
                try {
                  (onOpenWorkspace || onOpenFullPage)?.();
                } catch (error) {
                  notify(errorText(error));
                }
              }}
            >
              {workspacePane ? '全页查看' : '在工作区打开'}
            </button>
          )}
        </div>
        <div className="jf-top-actions">
          <input
            aria-label="搜索任务"
            className="jf-search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="搜索编号、标题或负责人"
          />
          <select
            aria-label="筛选迭代"
            value={activeSprint}
            onChange={(event) => {
              setSprint(event.target.value);
              setSelected(new Set());
            }}
          >
            <option value="all">所有迭代</option>
            {sprintOptions.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <select
            aria-label="Jira 连接"
            value={profileId}
            disabled={!!pendingKey || !!drag.drag}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
          <button
            aria-label="刷新看板"
            title="从 Jira 获取最新任务"
            disabled={!profile || !!pendingKey || !!drag.drag}
            className={`jf-refresh ${loading ? 'is-loading' : ''}`}
            onClick={() => void sync()}
          >
            <span aria-hidden="true">{icons.refresh}</span>
            {loading ? '刷新中' : '刷新'}
          </button>
          <button aria-label="连接设置" title="连接设置" onClick={() => setSettings(true)}>
            {icons.settings}
          </button>
        </div>
      </header>
      <div className="jf-status-strip" aria-live="polite">
        <span className={`jf-health jf-health-${syncState}`}>
          <i />
          {loading
            ? '正在刷新 Jira'
            : syncState === 'fresh'
              ? '数据已同步'
              : syncState === 'error'
                ? '刷新失败'
                : '等待连接'}
        </span>
        <span>
          显示 <strong>{visible.length}</strong> / {data?.issues.length || 0}
        </span>
        {profile && (
          <span>
            {profile.projectKeys.join(' / ')} · {profile.allowWrites ? '可更新' : '只读'}
          </span>
        )}
        {data && <span>更新 {new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
        <div className="jf-workspace-links">
          <button className="jf-text-button" disabled={!profile} onClick={() => setWeekly(true)}>
            生成周报
          </button>
          <button className="jf-text-button" onClick={() => fileInput.current?.click()} disabled={!profile}>
            导入执行结果
          </button>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importResults(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>
      <div className="jf-toolbar">
        <div className="jf-tabs">
          {[
            ['all', '全部'],
            ['story', 'Story'],
            ['bug', 'Bug'],
            ['task', '其他任务'],
          ].map(([value, label]) => (
            <button key={value} className={type === value ? 'is-active' : ''} onClick={() => setType(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="jf-filters">
          <label className="jf-check">
            <input
              type="checkbox"
              checked={visible.length > 0 && visible.every((issue) => selected.has(issue.key))}
              onChange={(event) =>
                setSelected(event.target.checked ? new Set(visible.map((issue) => issue.key)) : new Set())
              }
            />
            选择当前任务
          </label>
          <span className="jf-drag-help">拖动卡片 → 选择目标节点</span>
          <details className="jf-scope">
            <summary>查询范围</summary>
            <div className="jf-scope-popover jf-form">
              <label>
                范围
                <select value={scope} onChange={(event) => setScope(event.target.value)}>
                  <option value="configured">连接默认查询</option>
                  <option value="mine">我负责的</option>
                  <option value="reported">我报告的</option>
                  <option value="project">项目内全部</option>
                  <option value="custom">自定义 JQL</option>
                </select>
              </label>
              {scope === 'custom' ? (
                <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} />
              ) : (
                scope !== 'configured' && (
                  <label className="jf-check">
                    <input
                      type="checkbox"
                      checked={includeDone}
                      onChange={(event) => setIncludeDone(event.target.checked)}
                    />
                    包含已完成任务
                  </label>
                )
              )}
              <button disabled={loading} onClick={() => void sync()}>
                应用并同步
              </button>
            </div>
          </details>
        </div>
      </div>
      {error && (
        <div className="jf-banner jf-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {data && !data.complete && (
        <div className="jf-banner jf-warning">
          已显示 {data.issues.length}/{data.total} 条结果；请缩小查询范围。未返回的任务没有被删除。
        </div>
      )}
      <main ref={boardRef} className={`jf-board ${detail ? 'has-detail' : ''}`} aria-label="任务看板">
        {columns.map((column) => {
          const cards = visible.filter((issue) => issue.column === column.id);
          return (
            <section key={column.id} className={`jf-column jf-column-${column.id}`}>
              <header>
                <div>
                  <span className="jf-column-dot" />
                  <h3>{column.name}</h3>
                  <span className="jf-count">{cards.length}</span>
                </div>
                <small>{column.description}</small>
              </header>
              <div className="jf-cards">
                {cards.map((issue) => {
                  const run = runs.find((run) => run.keys.includes(issue.key));
                  const index = visible.indexOf(issue);
                  return (
                    <article
                      key={issue.key}
                      data-task-key={issue.key}
                      aria-busy={pendingKey === issue.key}
                      draggable={profile?.allowWrites && !pendingKey}
                      onDragStart={(event) => {
                        captureCards();
                        drag.begin(issue, event);
                      }}
                      onDragEnd={drag.clear}
                      className={`jf-card jf-card-${/bug/i.test(issue.type) ? 'bug' : /story/i.test(issue.type) ? 'story' : 'task'} ${selected.has(issue.key) ? 'is-selected' : ''} ${detail === issue.key ? 'is-open' : ''} ${drag.drag?.issue.key === issue.key ? 'is-dragging' : ''} ${pendingKey === issue.key ? 'is-pending' : ''} ${movedKey === issue.key ? 'just-moved' : ''}`}
                    >
                      <div className="jf-card-meta">
                        <span className={`jf-type ${/bug/i.test(issue.type) ? 'jf-bug' : 'jf-story'}`}>
                          <span aria-hidden="true" className="jf-type-icon">
                            {/bug/i.test(issue.type) ? '!' : /story/i.test(issue.type) ? '▤' : '◆'}
                          </span>
                          {typeName(issue.type)}
                        </span>
                        <button
                          className="jf-card-key"
                          title={issue.key}
                          onClick={() => setDetail(issue.key)}
                        >
                          {issue.key}
                        </button>
                        <button
                          className="jf-drag-handle"
                          aria-label={`选择 ${issue.key} 的目标节点`}
                          title="拖动卡片或点击选择目标节点"
                          disabled={!profile?.allowWrites || !!pendingKey}
                          onClick={(event) => drag.begin(issue, undefined, event.currentTarget)}
                        >
                          ⠿
                        </button>
                        <input
                          aria-label={`选择 ${issue.key}`}
                          type="checkbox"
                          checked={selected.has(issue.key)}
                          onChange={(event) => toggle(issue.key, event, index)}
                          onClick={(event) => {
                            if (event.shiftKey) {
                              event.preventDefault();
                              toggle(issue.key, event, index);
                            }
                          }}
                        />
                      </div>
                      <button className="jf-card-title" onClick={() => setDetail(issue.key)}>
                        {issue.summary}
                      </button>
                      <div className="jf-card-tags">
                        <span>{issue.status.name}</span>
                        {issue.priority && (
                          <span
                            className={
                              /highest|high|critical|blocker|高|严重/i.test(issue.priority)
                                ? 'jf-priority-high'
                                : ''
                            }
                          >
                            {issue.priority}
                          </span>
                        )}
                      </div>
                      <div className="jf-card-bottom">
                        <span className="jf-assignee" title={issue.assignee}>
                          <i>{issue.assignee?.slice(0, 1) || '?'}</i>
                          {issue.assignee || '未分配'}
                        </span>
                        <span
                          className={
                            issue.dueDate &&
                            shortDate(issue.dueDate) < new Date().toLocaleDateString('en-CA') &&
                            issue.column !== 'done'
                              ? 'jf-overdue'
                              : ''
                          }
                        >
                          {shortDate(issue.dueDate) || '无截止日期'}
                        </span>
                      </div>
                      {run && (
                        <div className="jf-agent-badge">
                          ◌{' '}
                          {run.state === 'delivered'
                            ? '已派发给 Agent'
                            : run.state === 'delivery-unknown'
                              ? '派发待核实'
                              : '任务已准备'}
                        </div>
                      )}
                      {pendingKey === issue.key && (
                        <div className="jf-moving-label">
                          <span className="jf-spinner" />
                          正在更新状态…
                        </div>
                      )}
                      <div className="jf-card-actions">
                        <button disabled={!!copyingKey} onClick={() => void copyIssue(issue)}>
                          {copyingKey === issue.key ? '读取中…' : '复制'}
                        </button>
                        <button onClick={() => setExportKeys([issue.key])}>任务包 / 派发</button>
                        {captureComposer && (
                          <button
                            title="将图文任务插入输入框，保留原草稿，由你发送"
                            disabled={adding}
                            onClick={() => void addToComposer([issue.key])}
                          >
                            {adding ? '添加中…' : '添加到会话'}
                          </button>
                        )}
                        <button
                          disabled={!profile?.allowWrites || !!pendingKey}
                          onClick={() => setTransition({ issue })}
                        >
                          流转
                        </button>
                      </div>
                    </article>
                  );
                })}
                {!cards.length && (
                  <div className="jf-empty-column">{loading ? '正在同步…' : '此列暂无任务'}</div>
                )}
              </div>
            </section>
          );
        })}
      </main>
      {!data && !loading && (
        <div className="jf-start-hint">
          {profile
            ? '点击“刷新”获取任务；已保存的任务可离线查看。'
            : '先在连接设置中导入现有 Obsidian 配置。'}
        </div>
      )}
      {selected.size > 0 && (
        <div className="jf-batch-bar">
          <strong>已选择 {selected.size} 个任务</strong>
          <button disabled={copying} onClick={() => void copySelected()}>
            {copying ? '读取中…' : '复制完整 Markdown'}
          </button>
          <button className="jf-primary" onClick={() => setExportKeys([...selected])}>
            生成图文任务包
          </button>
          {captureComposer && (
            <button disabled={adding} onClick={() => void addToComposer([...selected])}>
              {adding ? '正在读取图文…' : '添加到当前会话'}
            </button>
          )}
          <button className="jf-icon" aria-label="清除选择" onClick={() => setSelected(new Set())}>
            ×
          </button>
        </div>
      )}
      {detail && profile && (
        <Detail
          key={detail + profileId}
          taskKey={detail}
          seed={data?.issues.find((issue) => issue.key === detail)}
          refreshVersion={refreshVersion}
          profile={profile}
          onClose={() => setDetail('')}
          onExport={setExportKeys}
          onAdd={captureComposer ? (keys) => void addToComposer(keys) : undefined}
          adding={adding}
          onTransition={(issue) => setTransition({ issue })}
          onUpdated={updateIssue}
          notify={notify}
        />
      )}
      {settings && (
        <Settings profile={profile} onClose={() => setSettings(false)} onSaved={loadConnections} />
      )}
      {exportKeys && profile && (
        <ExportModal
          keys={exportKeys}
          profile={profile}
          onClose={() => setExportKeys(undefined)}
          onReady={setTaskPackage}
        />
      )}
      {taskPackage && !dispatch && (
        <PackageModal
          task={taskPackage}
          onClose={() => setTaskPackage(undefined)}
          onDispatch={() => setDispatch(true)}
          onAdd={captureComposer ? () => void addToComposer([], taskPackage) : undefined}
          adding={adding}
          notify={notify}
        />
      )}
      {taskPackage && dispatch && profile && (
        <DispatchModal
          task={taskPackage}
          profile={profile}
          onClose={() => setDispatch(false)}
          onSent={() => void refreshRuns()}
          notify={notify}
        />
      )}
      {transition && profile && (
        <TransitionModal
          issue={transition.issue}
          initialTarget={transition.target}
          profile={profile}
          onClose={() => setTransition(undefined)}
          onUpdated={updateIssue}
        />
      )}
      {weekly && profile && (
        <WeeklyModal profile={profile} onClose={() => setWeekly(false)} notify={notify} />
      )}
      {toast && (
        <div className="jf-toast" role="status">
          {toast}
        </div>
      )}
      {drag.panel}
    </div>
  );
}
