import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const inject = ['webServer'];
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function send(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error('请求体过大'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('请求格式错误');
  return value;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
    throw new Error('拒绝跨站请求');
  }
}
export function apply(ctx) {
  let runtimePromise, disposed = false;
  const receipt = { plugin: 'dsh-project-package', version: '0.1.6', hostPid: process.pid,
    active: true, engineStarts: 0, enginePid: null, activeTask: null };
  let receiptWrite = Promise.resolve();
  const report = state => {
    Object.assign(receipt, state, { updatedAt: new Date().toISOString() });
    const snapshot = JSON.stringify(receipt, null, 2);
    receiptWrite = receiptWrite.then(() => writeFile(path.join(packageRoot, 'runtime-status.json'), snapshot)).catch(() => {});
  };
  report({});
  async function runtime() {
    if (disposed) throw new Error('插件已停用');
    if (!runtimePromise) runtimePromise = import('./runtime.js').then(({ createRuntime }) => createRuntime({ packageRoot, onStatus: report }));
    return runtimePromise;
  }
  function register(url, handler) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: url, handler: async (req, res) => {
      try { sameOrigin(req); await handler(req, res); }
      catch (error) { if (!res.headersSent) send(res, 400, { ok: false, error: error.message }); }
    } }), `project-package: ${url}`);
  }
  register('/dsh-project-package/panel.js', async (req, res) => {
    if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return; }
    const content = await readFile(path.join(packageRoot, 'dist', 'panel.js'));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); res.end(content);
  });
  register('/dsh-project-package/api', async (req, res) => {
    if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { send(res, 405, { error: 'POST JSON required' }); return; }
    const input = await body(req);
    if (input.operation === 'close') {
      if (runtimePromise) await (await runtimePromise).release(input.lease);
      send(res, 200, { ok: true, value: {} }); return;
    }
    const engine = await runtime(); engine.touch(input.lease);
    const data = input.data || {};
    if (input.operation === 'scan') {
      const registry = ctx.get('workspaceRegistry');
      if (!registry) throw new Error('DSH 工作区服务尚未就绪');
      data.workspaces = registry.list().map(w => ({ id: String(w.id), path: w.path, title: w.title }));
    }
    if (input.operation === 'pick') {
      const capability = ctx.get('directoryPicker')?.capability();
      if (capability?.kind !== 'native') throw new Error('当前宿主不支持目录对话框，请直接输入项目路径');
      const selected = await capability.pick(AbortSignal.timeout(120000));
      send(res, 200, { ok: true, value: { path: selected } }); return;
    }
    if (['copyFile', 'reveal'].includes(input.operation)) {
      const { path: artifact } = await engine.call('artifact', data);
      await desktopFileAction(input.operation, artifact);
      send(res, 200, { ok: true, value: {} }); return;
    }
    if (!['state', 'scan', 'select', 'settings', 'start', 'cancel', 'monitor', 'acknowledge', 'jenkins'].includes(input.operation)) throw new Error('不支持的操作');
    send(res, 200, { ok: true, value: await engine.call(input.operation, data) });
  });
  ctx.effect(() => async () => {
    disposed = true;
    if (runtimePromise) await (await runtimePromise).dispose();
    report({ active: false, enginePid: null });
    await receiptWrite;
  }, 'project-package: owned runtime cleanup');
}

async function desktopFileAction(operation, file) {
  if (process.platform !== 'win32') throw new Error('文件复制与定位目前支持 Windows Desktop');
  if (operation === 'reveal') {
    // Explorer hands the location to the user's existing shell.
    return run('explorer.exe', ['/select,', file], 10000, true);
  }
  const literal = file.replaceAll("'", "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms\n$files = New-Object System.Collections.Specialized.StringCollection\n[void]$files.Add('${literal}')\n[System.Windows.Forms.Clipboard]::SetFileDropList($files)`;
  return run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 10000);
}
function run(executable, args, timeout, explorer = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('系统操作超时')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 || explorer ? resolve() : reject(new Error('系统操作失败')); });
  });
}
