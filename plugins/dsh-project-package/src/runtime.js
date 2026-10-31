import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// The engine bounds each stage itself (release notes 4 min, Maven 60 min, WAR
// protection 12 min); note generation and dependency checks between them have no
// separate limit. This watchdog only catches an engine that stopped responding, so
// it must outlast all stages together or it kills a healthy task in its last stage.
export const TASK_WATCHDOG_MS = (4 + 60 + 12 + 30) * 60 * 1000;

export function createRuntime({ packageRoot = root, onStatus = () => {}, spawnProcess = spawn } = {}) {
  let child, ready, sequence = 0, buffer = '', idleTimer, disposed = false, lastActive = null;
  const requests = new Map();
  const leases = new Map();
  const status = { enginePid: null, engineStarts: 0, activeTask: null };
  let reapTimer, stopping;

  function report() { onStatus({ ...status }); }
  function failPending(error) {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); }
    requests.clear();
  }
  async function start() {
    if (stopping) await stopping;
    if (disposed) throw new Error('插件已停用');
    if (child) return ready;
    const executable = path.join(packageRoot, 'runtime', 'PackageEngine.exe');
    const python = process.env.DSH_PACKAGE_PYTHON || 'python';
    const compiled = existsSync(executable);
    const processRef = spawnProcess(compiled ? executable : python,
      compiled ? [] : ['-B', path.join(packageRoot, 'engine', 'worker.py')], {
        cwd: packageRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      });
    child = processRef;
    buffer = '';
    status.enginePid = child.pid;
    status.engineStarts++;
    report();
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('打包引擎启动超时')); void stop(); }, 20000);
      let errors = '';
      processRef.stderr.setEncoding('utf8');
      processRef.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
      processRef.stdout.setEncoding('utf8');
      processRef.stdout.on('data', data => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) { void stop(); reject(new Error('引擎响应过大')); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          if (value.type === 'ready') { clearTimeout(timer); resolve(); continue; }
          const request = requests.get(value.id);
          if (!request) continue;
          requests.delete(value.id); clearTimeout(request.timer);
          if (value.ok) {
            if ('activeTask' in (value.value || {})) {
              status.activeTask = value.value.activeTask;
              if (status.activeTask && !lastActive) lastActive = Date.now();
              if (!status.activeTask) lastActive = null;
              report();
            }
            request.resolve(value.value);
          } else request.reject(new Error(value.error || '打包引擎请求失败'));
        }
      });
      processRef.on('error', error => { clearTimeout(timer); reject(error); failPending(error); });
      processRef.on('close', code => {
        clearTimeout(timer);
        const error = new Error(`打包引擎已退出（${code}）${errors ? ': ' + errors.slice(-600) : ''}`);
        reject(error); failPending(error);
        if (child === processRef) { child = null; ready = null; status.enginePid = null; status.activeTask = null; lastActive = null; report(); }
      });
    });
    if (!reapTimer) reapTimer = setInterval(() => { void reap().catch(() => {}); }, 10000);
    reapTimer.unref?.();
    return ready;
  }
  async function call(operation, data = {}) {
    clearTimeout(idleTimer);
    await start();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id); reject(new Error('操作超时，已回收引擎进程；重新打开可恢复记录'));
        void stop();
      }, 50000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, operation, data }) + '\n', error => {
        if (error) { clearTimeout(timer); requests.delete(id); reject(error); }
      });
    });
  }
  function stop() {
    if (!stopping) stopping = stopWorker().finally(() => { stopping = null; });
    return stopping;
  }
  async function stopWorker() {
    clearTimeout(idleTimer);
    clearInterval(reapTimer); reapTimer = null;
    const processRef = child;
    if (!processRef) return;
    const closed = new Promise(resolve => processRef.once('close', resolve));
    try { processRef.stdin.write(JSON.stringify({ id: ++sequence, operation: 'shutdown' }) + '\n'); } catch {}
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1500))]);
    if (processRef.exitCode === null) {
      if (process.platform === 'win32' && processRef.pid) {
        await new Promise(resolve => {
          const killer = spawnProcess('taskkill.exe', ['/PID', String(processRef.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { killer.kill(); processRef.kill(); resolve(); }, 5000);
          killer.once('error', () => { clearTimeout(timer); processRef.kill(); resolve(); });
          killer.once('close', () => { clearTimeout(timer); resolve(); });
        });
      } else processRef.kill('SIGKILL');
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
  }
  async function reap() {
    for (const [id, updated] of leases) if (Date.now() - updated > 25000) leases.delete(id);
    if (lastActive && Date.now() - lastActive > TASK_WATCHDOG_MS) { await stop(); return; }
    if (!leases.size && child) {
      const state = await call('state');
      if (leases.size) return;
      if (!state.activeTask) await stop();
      else await call('close');
    }
  }
  return {
    call,
    touch(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('无效的面板标识'); leases.set(id, Date.now()); },
    async release(id) { leases.delete(id); if (!leases.size && child) { await call('close'); idleTimer = setTimeout(() => { void reap().catch(() => {}); }, 1500); } },
    async dispose() { disposed = true; leases.clear(); await stop(); },
    status: () => ({ ...status }),
  };
}
