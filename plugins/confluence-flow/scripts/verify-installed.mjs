import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConfluenceService } from "../dist/test-exports.js";

const exec = promisify(execFile);
const service = new ConfluenceService();
const summary = {};
try {
  const profiles = await service.execute({ operation: "profiles" });
  const profile =
    profiles.find((item) => item.id === "work-confluence") || profiles[0];
  assert.ok(profile, "至少需要一个已配置连接");
  const found = await service.execute({
    operation: "search",
    profile: profile.id,
    limit: 2,
  });
  summary.searchCount = found.results.length;
  const target = found.results[0]?.id || profile.rootPageIds[0];
  const page = await service.execute({
    operation: "read",
    profile: profile.id,
    page: target,
    format: "full",
  });
  summary.read = {
    pageId: page.id,
    version: page.version,
    wikiCharacters: page.wiki.length,
    sections: page.sections.length,
    regions: page.regions.length,
    warnings: page.warnings.length,
  };
  const preview = await service.execute({
    operation: "preview",
    profile: profile.id,
    wiki: "h1. 格式验证\n\nh2. 参数\n\n||字段||说明||\n|example|示例|",
    layout: "right-toc",
  });
  assert.ok(preview.html.includes("cf-right-toc"));
  summary.nativeLayoutPreview = true;
  const roots = [".agents", ".codex", ".claude"];
  summary.skillRunners = [];
  for (const root of roots) {
    const runner = path.join(
      homedir(),
      root,
      "skills",
      "confluence-query",
      "scripts",
      "run.mjs",
    );
    const { stdout } = await exec(process.execPath, [runner, "profiles"], {
      timeout: 30_000,
      windowsHide: true,
    });
    assert.ok(JSON.parse(stdout).some((item) => item.id === profile.id));
    summary.skillRunners.push(root);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "mcp"],
    stderr: "pipe",
  });
  const client = new Client({
    name: "confluence-installed-verification",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "confluence_flow",
      arguments: { operation: "read", profile: profile.id, page: target },
    });
    assert.notEqual(response.isError, true);
    const read = JSON.parse(response.content[0].text);
    assert.equal(read.id, page.id);
    summary.mcpRealRead = true;
  } finally {
    await client.close();
    await transport.close();
  }
  summary.realPageWrites = 0;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  service.dispose();
}
