import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root,'node_modules','@esbuild','win32-x64','esbuild.exe');
await mkdir(path.join(root,'dist'),{recursive:true});
function compile(input, platform, format, extra=[]) {
  const result = spawnSync(binary,[input,'--bundle',`--platform=${platform}`,`--format=${format}`,'--target=es2022','--legal-comments=none',...extra], {cwd:root,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error('Build failed: '+input+' '+result.stderr);
  return result.stdout;
}
// Runtime is a separate ESM entry; preserve the lazy import in the host shell.
await writeFile(path.join(root,'dist/plugin.js'),compile('src/plugin.js','node','esm',['--external:./runtime.js']));
await writeFile(path.join(root,'dist/runtime.js'),compile('src/runtime.js','node','esm'));
const entry=compile('src/client/index.jsx','browser','cjs',['--external:react']);
const panel=compile('src/client/panel.jsx','browser','cjs',['--external:react']);
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(root,'dist/client.js'),`window.__ModuleLoader__.load({id:"dsh-project-package",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${entry}\nreturn module.exports;}});\n`);
await writeFile(path.join(root,'dist/panel.js'),`globalThis.__dshProjectPackagePanelVersion=${JSON.stringify(version)};\nglobalThis.__dshProjectPackagePanelFactory=(require)=>{var module={exports:{}};var exports=module.exports;\n${panel}\nreturn module.exports;};\n`);
console.log(JSON.stringify({entryBytes:Buffer.byteLength(entry),lazyPanelBytes:Buffer.byteLength(panel)}));
