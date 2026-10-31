import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
try {
  const home =
    process.env.CONFLUENCE_FLOW_HOME ||
    path.join(homedir(), ".confluence-flow");
  const { cli } = JSON.parse(
    await readFile(path.join(home, "installation.json"), "utf8"),
  );
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 9 * 60_000);
  process.once("SIGINT", () => child.kill());
  process.once("SIGTERM", () => child.kill());
  child.once("error", () => {
    clearTimeout(timer);
    process.stderr.write("无法运行 Confluence Flow，请重新安装运行层。\n");
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write(
    "Confluence Flow 未安装。请在运行层执行 skills install，再使用此 Skill；不要向聊天提供凭证。\n",
  );
  process.exitCode = 1;
}
