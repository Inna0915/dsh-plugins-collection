import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dataHome, validId, jsonRead, jsonWrite, atomicWrite, withLock } from './store.js';
import type { Auth, Profile } from '../types.js';
import { ReadCache } from '../shared/read-cache.js';
const decryptedCredentials = new ReadCache<string>(60_000, 8);

export const installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileFile = (id: string) => path.join(dataHome(), 'profiles', `${validId(id)}.json`);
const credentialFile = (id: string) => path.join(dataHome(), 'credentials', `${validId(id)}.dpapi`);
function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Jira 地址必须是无凭证的 HTTP(S) 地址');
  return url.toString().replace(/\/+$/, '');
}
export function normalizeProfile(input: Partial<Profile>, existing?: Profile): Profile {
  const value = { ...existing, ...input };
  const id = validId(value.id || 'work-jira');
  const host = origin(value.host || '');
  const projects = value.projectKeys?.map((key) => key.trim().toUpperCase()).filter(Boolean) || [];
  if (!projects.length || projects.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key)))
    throw new Error('至少配置一个有效的 Jira 项目 Key');
  const field = (name: string | undefined, fallback: string) => {
    const result = name || fallback;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(result)) throw new Error('自定义字段名称无效');
    return result;
  };
  const statusColumns = value.statusColumns || {};
  if (Object.values(statusColumns).some((column) => !['todo', 'doing', 'review', 'done'].includes(column)))
    throw new Error('看板列映射无效');
  return {
    id,
    name: value.name?.trim() || id,
    host,
    browseHost: origin(value.browseHost || host),
    projectKeys: [...new Set(projects)],
    jql: value.jql ?? 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    storyPointsField: field(value.storyPointsField, 'customfield_10111'),
    dueDateField: field(value.dueDateField, 'duedate'),
    sprintField: field(value.sprintField, 'customfield_10109'),
    workspace: value.workspace || '',
    agentPreset: value.agentPreset || '',
    allowWrites: value.allowWrites === true,
    credentialStore: value.credentialStore === 'environment' ? 'environment' : 'windows-dpapi',
    statusColumns,
    developmentStatuses: value.developmentStatuses || [
      'EXECUTED',
      'VALIDATING',
      'Build Done 构建完成',
      'Validating 验证',
      '已构建',
      '验收中',
    ],
  };
}
export async function profiles(): Promise<Profile[]> {
  const names = await readdir(path.join(dataHome(), 'profiles')).catch(() => [] as string[]);
  return Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => getProfile(name.slice(0, -5))),
  );
}
export async function getProfile(id = 'work-jira'): Promise<Profile> {
  try {
    return normalizeProfile(await jsonRead<Profile>(profileFile(id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`连接 ${id} 尚未配置，请先导入 Obsidian 设置或打开连接设置`);
    throw error;
  }
}
async function crypt(mode: 'protect' | 'unprotect', input: string): Promise<string> {
  if (process.platform !== 'win32')
    throw new Error('此凭证使用 Windows 用户保护；其他系统请配置 environment 凭证提供器');
  const script = path.join(installationRoot, 'scripts', 'credential-store.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => child.kill(), 15_000);
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (data) => {
      output += data;
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动 Windows 凭证提供器'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error('凭证读取失败，请用原 Windows 用户重新导入连接'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
export async function saveProfile(input: Partial<Profile>, auth?: Auth): Promise<Profile> {
  const old = await getProfile(input.id).catch(() => undefined);
  const profile = normalizeProfile(input, old);
  if (auth && (!auth.secret || (auth.kind === 'basic' && !auth.username))) throw new Error('认证信息不完整');
  await withLock(`profile-${profile.id}`, async () => {
    if (auth) {
      if (profile.credentialStore !== 'windows-dpapi') throw new Error('环境变量凭证不通过设置页面保存');
      const encrypted = await crypt('protect', JSON.stringify(auth));
      await atomicWrite(credentialFile(profile.id), encrypted);
    }
    await jsonWrite(profileFile(profile.id), profile);
  });
  return profile;
}
export async function getAuth(profile: Profile): Promise<Auth> {
  let protectedValue = '';
  if (profile.credentialStore === 'windows-dpapi')
    protectedValue = await readFile(credentialFile(profile.id), 'utf8').catch(() => {
      throw new Error('连接没有凭证，请重新导入');
    });
  const raw =
    profile.credentialStore === 'environment'
      ? process.env[`JIRA_FLOW_AUTH_${profile.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]
      : await decryptedCredentials.get(credentialFile(profile.id) + protectedValue, () =>
          crypt('unprotect', protectedValue),
        );
  if (!raw) throw new Error('未设置该连接的认证环境变量');
  let auth: Auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error('认证格式无效');
  }
  if (!auth.secret || !['basic', 'bearer'].includes(auth.kind)) throw new Error('认证配置不完整');
  return auth;
}
export async function importObsidian(source: string, id = 'work-jira', workspace = ''): Promise<Profile> {
  const settings = await jsonRead<Record<string, unknown>>(path.resolve(source));
  if (!settings.jiraHost || !settings.jiraPassword || !settings.jiraUsername)
    throw new Error('所选文件不是已配置的 Obsidian Jira Flow 设置');
  const string = (key: string) => (typeof settings[key] === 'string' ? (settings[key] as string) : '');
  return saveProfile(
    {
      id,
      name: '工作 Jira',
      host: string('jiraHost'),
      browseHost: string('jiraBrowseHost') || string('jiraHost'),
      projectKeys: [string('projectKey')],
      jql: string('jql'),
      storyPointsField: string('storyPointsField'),
      dueDateField: string('dueDateField'),
      sprintField: string('sprintField'),
      workspace,
      credentialStore: 'windows-dpapi',
      allowWrites: false,
    },
    { kind: 'basic', username: string('jiraUsername'), secret: string('jiraPassword') },
  );
}
