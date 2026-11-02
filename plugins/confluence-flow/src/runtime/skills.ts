import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { installationRoot } from "./config.js";
import { dataHome, jsonWrite } from "./store.js";

export async function bundledSkills() {
  const root = path.join(installationRoot, "skills");
  return Promise.all(
    (await readdir(root))
      .filter((name) => name.startsWith("confluence-"))
      .map(async (name) => {
        const location = path.join(root, name, "SKILL.md");
        const content = await readFile(location, "utf8");
        return {
          name,
          description: content.match(/^description:\s*(.+)\s*$/m)?.[1] || name,
          content,
          path: location,
          source: "runtime",
          provider: "confluence-flow",
        };
      }),
  );
}
export async function installSkills(destination?: string) {
  const roots = destination
    ? [path.resolve(destination)]
    : [
        path.join(homedir(), ".agents", "skills"),
        path.join(homedir(), ".codex", "skills"),
        path.join(homedir(), ".claude", "skills"),
      ];
  const installed: string[] = [];
  const existing: string[] = [];
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    for (const skill of await bundledSkills()) {
      const target = path.join(root, skill.name);
      try {
        await mkdir(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          existing.push(target);
          continue;
        }
        throw error;
      }
      await cp(path.dirname(skill.path), target, { recursive: true });
      installed.push(target);
    }
  }
  await jsonWrite(path.join(dataHome(), "installation.json"), {
    cli: path.join(installationRoot, "dist", "cli.js"),
    version: "0.3.0",
  });
  return {
    installed,
    existing,
    cli: path.join(installationRoot, "dist", "cli.js"),
  };
}
