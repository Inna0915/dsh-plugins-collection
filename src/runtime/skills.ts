import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { installationRoot } from './config.js';
import { dataHome, jsonWrite } from './store.js';
export async function bundledSkills() {
  const root = path.join(installationRoot, 'skills');
  const names = await readdir(root);
  return Promise.all(
    names
      .filter((name) => name.startsWith('jira-'))
      .map(async (name) => {
        const location = path.join(root, name, 'SKILL.md');
        const content = await readFile(location, 'utf8');
        const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || name;
        return { name, description, content, path: location, source: 'runtime', provider: 'jira-flow' };
      }),
  );
}
export async function installSkills(destination = path.join(homedir(), '.agents', 'skills')) {
  const skills = await bundledSkills();
  await mkdir(destination, { recursive: true });
  const installed: string[] = [];
  const existing: string[] = [];
  for (const skill of skills) {
    const target = path.join(destination, skill.name);
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        existing.push(target);
        continue;
      }
      throw error;
    }
    await cp(path.dirname(skill.path), target, { recursive: true });
    installed.push(target);
  }
  const { version } = JSON.parse(await readFile(path.join(installationRoot, 'package.json'), 'utf8'));
  await jsonWrite(path.join(dataHome(), 'installation.json'), {
    cli: path.join(installationRoot, 'dist', 'cli.js'),
    version,
  });
  return { installed, existing, runtime: installationRoot };
}
