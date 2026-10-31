import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
export async function runCli() {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
  const args = process.argv.slice(2);
  const patch = JSON.parse(fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
  const task = /任务：([^\r\n]+)/.exec(prompt)[1];
  const logs = path.join(process.cwd(), 'work/alpha/logs', task);
  fs.writeFileSync(path.join(logs, 'fake-input.json'), JSON.stringify({ args, prompt, patch, cwd: process.cwd(), mode: process.env.DSH_PERMISSION_MODE }));
  const id = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : 'session-01234567-1234-1234-1234-123456789abc';
  console.log(JSON.stringify({ type: 'session', sessionId: id }));
  if (prompt.includes('TEST_CHILD')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    child.unref();
    fs.writeFileSync(path.join(logs, 'fake-child.json'), JSON.stringify({ pid: child.pid }));
  }
  if (prompt.includes('TEST_WAIT')) await new Promise(resolve => setTimeout(resolve, 120000));
  if (!prompt.includes('TEST_NO_COMPLETED')) console.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: prompt.includes('TEST_FAIL') ? 'error' : 'completed' } }));
  console.log(JSON.stringify({ type: 'final', text: '模拟最终结果 DSH_READY' }));
  process.exit(prompt.includes('TEST_FAIL') ? 7 : 0);
}
