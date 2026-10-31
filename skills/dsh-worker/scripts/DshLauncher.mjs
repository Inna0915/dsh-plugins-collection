// Read only the selected desktop provider. Credentials remain environment references.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const options = JSON.parse(process.env.DSH_DELEGATE_CONFIG);
delete process.env.DSH_DELEGATE_CONFIG;
const require = createRequire(path.join(options.dshPackage, 'package.json'));
const yaml = require('js-yaml');
class Expression { constructor(value) { this.value = value; } }
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => new Expression(value),
}));
let ownsPatch = false;
function cleanup() {
  if (ownsPatch) {
    try { fs.unlinkSync(options.patch); ownsPatch = false; }
    catch (error) { if (error.code !== 'ENOENT') process.stderr.write('DSH overlay cleanup failed.\n'); }
  }
}
process.on('exit', cleanup);
try {
  const rows = yaml.load(fs.readFileSync(options.sourceConfig, 'utf8'), { schema });
  const row = rows.find(row => row.id === 'llm-pi-ai');
  const provider = row?.config?.providers?.[options.provider];
  if (!provider) throw new Error(`Desktop provider not found: ${options.provider}`);
  function validate(value) {
    if (value instanceof Expression) throw new Error('Selected provider contains a dynamic !!js expression; a static provider is required.');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/^(apiKey|token|secret|authorization)$/i.test(key)) throw new Error('Use apiKeyEnv instead of inline credentials in the selected provider.');
        validate(child);
      }
    }
  }
  validate(provider);
  const model = provider.models?.find(model => model.id === options.model);
  if (provider.models && !model) throw new Error(`Model is not configured on provider ${options.provider}: ${options.model}`);
  if (model?.reasoningEfforts && !Object.hasOwn(model.reasoningEfforts, options.effort)) {
    throw new Error(`Effort ${options.effort} is not declared for ${options.model}`);
  }
  const patch = [
    { id: 'llm-pi-ai', config: { providers: { [options.provider]: provider } } },
    { id: 'agent-default-model', config: { provider: options.provider, model: options.model, reasoningEffort: options.effort } },
    { id: 'sandbox-policy', config: { mode: options.mode, workspaceRoot: process.cwd() } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: options.mode,
      presets: { [options.mode]: { sandbox: options.mode, approval: 'never' } } } },
  ];
  fs.writeFileSync(options.patch, JSON.stringify(patch, null, 2), { flag: 'wx', mode: 0o600 });
  ownsPatch = true;
  const version = JSON.parse(fs.readFileSync(path.join(options.dshPackage, 'package.json'), 'utf8')).version;
  process.stdout.write(JSON.stringify({ type: 'delegate_config', dshVersion: version, nodeVersion: process.version,
    provider: options.provider, model: options.model, effort: options.effort, mode: options.mode,
    approval: 'never', sourceConfig: options.sourceConfig }) + '\n');
  // Explicit call works both before and after Node introduced import.meta.main.
  const entry = options.entry || path.join(options.dshPackage, 'lib', 'bin.js');
  const { runCli } = await import(pathToFileURL(entry).href);
  await runCli();
} catch (error) {
  process.stderr.write(`DSH launcher: ${error.message}\n`);
  cleanup();
  process.exitCode = 1;
}
