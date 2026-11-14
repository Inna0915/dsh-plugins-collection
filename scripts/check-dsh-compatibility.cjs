// Run with the installed Desktop executable and ELECTRON_RUN_AS_NODE=1.
// Reads the real ASAR runtime; never loads plugins or changes exemptions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const appRoot = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/app.asar/dsh');
const hostRequire = createRequire(path.join(appRoot, 'package.json'));
const { evaluatePluginCompatibility, getDshRuntimeVersion } = hostRequire('@deepseek-ai/dsh-app-boot');
const runtime = getDshRuntimeVersion();
const root = path.resolve(__dirname, '..');
const rows = [];
for (const directory of fs.readdirSync(path.join(root, 'plugins'))) {
  const packageRoot = path.join(root, 'plugins', directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const issue = evaluatePluginCompatibility(manifest, {}, runtime);
  const entry = manifest.exports['.'];
  const client = manifest.exports['./client'];
  const patch = manifest.dsh.bundle.patch;
  for (const file of [entry, client, patch]) assert.ok(fs.existsSync(path.join(packageRoot, file)), `${manifest.name}: missing ${file}`);
  rows.push({ name: manifest.name, version: manifest.version, compatible: issue === undefined, requirements: issue?.requirements });
  if (issue) process.exitCode = 1;
  if (['dsh-project-package', 'dsh-sidebar-recents'].includes(manifest.name)) {
    // Guard the actual upgrade failure, plus retention of previously supported hosts.
    const old = { ...manifest, engines: { ...manifest.engines, dsh: '0.2.1-rc.3 || 0.2.1-rc.5' } };
    assert.ok(evaluatePluginCompatibility(old, {}, '0.2.2-rc.1'));
    for (const version of ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.3']) {
      assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `${manifest.name}: ${version} rejected`);
    }
    // rc.2 never ran on this machine (its installer failed on 2026-11-12), so it stays unaudited.
    for (const version of ['0.2.2-rc.2', '0.3.0']) {
      assert.ok(evaluatePluginCompatibility(manifest, {}, version), `${manifest.name}: unaudited ${version} admitted`);
    }
  }
}

// Contract tripwires complement, rather than replace, UI and behavior tests.
// From 0.2.2-rc.3 the official packages ship minified; compare without whitespace
// and with one quote style so formatting changes alone do not trip the checks.
const normalize = (text) => text.replace(/\s+/g, '').replace(/[`']/g, '"');
const readContractSource = (name, file) => normalize(fs.readFileSync(path.join(appRoot, 'node_modules/@deepseek-ai', name, 'lib', file), 'utf8'));
const contracts = {
  'dsh-client-ui-sidebar': ['"sidebar.footer.action"', '"sidebar.workspaces"', '{ wide }'],
  'dsh-client-ui-layout': ['selectPanel(panelId)', 'hasMainPanel(panelId)'],
  'dsh-client-ui-workspace': ['openSession(target)', 'pinSession(sessionId)', 'unpinSession(sessionId)', 'setGroupExpanded:', '"data-row-key": `workspace:${group.key}`', 'role: "tree"', 'HoverCard', 'createSnapshotStore'],
  'dsh-client-ui-session': ['sessionStatus = {', 'current: this.current', 'getSnapshot:'],
  'dsh-client-ui-conversation': ['captureInsertion:', 'insertText:', 'addAttachments:', 'persistDraft:', 'createDrafts(sessionId, files', 'releaseDraftAttachments(attachments)', 'props: { inputActions: shell.actions }'],
  'dsh-client-ui-sidebar-right': ['openTab(kind, options', 'isExpanded()', 'toggleExpanded()', 'this.openTabs =', 'this.mounted =', 'bindCommands:', '"sidebar.right.pane.tab"'],
};
for (const [name, fragments] of Object.entries(contracts)) {
  const code = readContractSource(name, 'client.js');
  for (const fragment of fragments) assert.ok(code.includes(normalize(fragment)), `${name}: changed contract ${fragment}`);
}
const hostContracts = {
  'dsh-host-webserver': ['register(route)', 'route.kind === "exact"'],
  'dsh-workspace': ['list()', '"workspaceRegistry"'],
  'dsh-host-directory-picker-native': ['capability()', 'pick:'],
  'dsh-api-session-controller': ['async list(_request, signal)', 'async prompt(request, signal)', '"sessionController"'],
  'dsh-session-query': ['observeSession(sessionId, options', 'async readSession(sessionId)'],
  'dsh-user-approval': ['async request(', '"allowed-once"', 'overrideOf(session)'],
};
for (const [name, fragments] of Object.entries(hostContracts)) {
  const code = readContractSource(name, 'index.js');
  for (const fragment of fragments) assert.ok(code.includes(normalize(fragment)), `${name}: changed contract ${fragment}`);
}
console.log(JSON.stringify({ runtime, exemptionsUsed: false, plugins: rows, clientContractChecks: Object.keys(contracts).length, hostContractChecks: Object.keys(hostContracts).length }, null, 2));
