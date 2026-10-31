import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Build through the native esbuild CLI with inherited stdio. The DSH sandbox
 * blocks Node child processes that capture piped stdio, so the JS service API
 * (which uses pipes) is not usable here; the CLI binary is still the same
 * esbuild engine and runs inside the bounded Job Object.
 */
function findEsbuildBinary() {
  const candidates = [];
  if (process.env.ESBUILD_BIN) candidates.push(process.env.ESBUILD_BIN);
  candidates.push(
    path.resolve('node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.resolve('node_modules/@esbuild/win32-arm64/esbuild.exe'),
    path.resolve('node_modules/@esbuild/linux-x64/bin/esbuild'),
    path.resolve('node_modules/@esbuild/darwin-arm64/bin/esbuild'),
    path.resolve('node_modules/@esbuild/darwin-x64/bin/esbuild'),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'esbuild binary not found. Run `npm install`, or set ESBUILD_BIN to the platform esbuild executable.',
  );
}

function runEsbuild(binary, args) {
  const result = spawnSync(binary, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`esbuild exited with ${result.status ?? 'unknown'} for ${args.join(' ')}`);
  }
}

const binary = findEsbuildBinary();
console.log(`Using esbuild: ${binary}`);

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await mkdir('.task-temp', { recursive: true });
const clientBody = path.resolve('.task-temp/client.body.js');

runEsbuild(binary, [
  'src/plugin.js',
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=esm',
  '--legal-comments=none',
  '--outfile=dist/plugin.js',
]);

runEsbuild(binary, [
  'src/client/index.js',
  '--bundle',
  '--platform=browser',
  '--target=es2022',
  '--format=cjs',
  '--external:react',
  '--external:react-dom',
  '--external:react/jsx-runtime',
  '--external:@deepseek-ai/dsh-client-ui-primitives',
  '--external:@deepseek-ai/dsh-client-store',
  '--loader:.js=jsx',
  '--legal-comments=none',
  `--outfile=${clientBody}`,
]);

const source = await readFile(clientBody, 'utf8');
const wrapped = `window.__ModuleLoader__.load({id:"dsh-sidebar-recents",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${source}\nreturn module.exports;}});\n`;
await writeFile('dist/client.js', wrapped, 'utf8');
await rm(clientBody, { force: true });

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
console.log(
  `Built ${packageJson.name}@${packageJson.version}: dist/plugin.js, dist/client.js (${wrapped.length} bytes client wrapper).`,
);
