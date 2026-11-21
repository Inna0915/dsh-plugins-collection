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
  if (!manifest.dsh) continue; // not a DSH plugin (confluence-flow keeps only its CLI / MCP runtime and skills)
  const issue = evaluatePluginCompatibility(manifest, {}, runtime);
  const entry = manifest.exports['.'];
  const client = manifest.exports['./client'];
  const patch = manifest.dsh.bundle.patch;
  for (const file of [entry, client, patch]) assert.ok(fs.existsSync(path.join(packageRoot, file)), `${manifest.name}: missing ${file}`);
  rows.push({ name: manifest.name, version: manifest.version, compatible: issue === undefined, requirements: issue?.requirements });
  if (issue) process.exitCode = 1;
  if (['dsh-project-package', 'dsh-sidebar-recents'].includes(manifest.name)) {
    // Guard the actual rc.5 upgrade failure under old exact-pin declarations.
    const old = { ...manifest, engines: { ...manifest.engines, dsh: '0.2.1-rc.3 || 0.2.1-rc.5 || 0.2.2-rc.1 || 0.2.2-rc.3' } };
    assert.ok(evaluatePluginCompatibility(old, {}, '0.2.2-rc.5'));
    // Lower-bound range (>=0.2.1-rc.3) keeps historical hosts and admits future upgrades (includePrerelease: true).
    for (const version of ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.2-rc.5', '0.2.2', '0.2.3-rc.1', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
      assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `${manifest.name}: ${version} rejected`);
    }
    for (const version of ['0.2.0', '0.2.1-rc.2']) {
      assert.ok(evaluatePluginCompatibility(manifest, {}, version), `${manifest.name}: below-floor ${version} admitted`);
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
// shared/sidebar.css aligns the plugins' left-sidebar rows to dsh-modern-ui, which replaces the
// official sidebar in the Desktop profile. Its tokens and spacing are private, so check the ones
// the shared values were measured from; class hashes change per build, so match by class suffix.
const modernUi = path.join(process.env.USERPROFILE || '', '.dsh/profiles/desktop/node_modules/@iroha1145/dsh-modern-ui');
let modernUiChecks = 'not installed';
if (fs.existsSync(path.join(modernUi, 'lib/client.js'))) {
  const code = fs.readFileSync(path.join(modernUi, 'lib/client.js'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(modernUi, 'package.json'), 'utf8')).version;
  const rule = (suffix) => new RegExp(`\\.[A-Za-z0-9_]+_${suffix}\\{([^}]*)\\}`, 'g');
  const declares = (suffix, declaration) => [...code.matchAll(rule(suffix))].some((match) => match[1].includes(declaration));
  const body = code.match(/body\{([^}]*--ink-2:[^}]*)\}/)?.[1] || '';
  const expected = {
    tokens: ['--ink:', '--ink-2:', '--ink-3:', '--hover:', '--hover-2:', '--accent-tint:', '--primary:', '--line-soft:'].filter((token) => !body.includes(token)),
    'footArea padding 6px 2px 0 (--dshx-footer-inset: 2px)': declares('footArea', 'padding:6px 2px 0'),
    'panelRow min-height 38px, padding 0 12px, gap 10px (--dshx-row-height, --dshx-row-inset, --dshx-icon-gap)': declares('panelRow', 'min-height:38px') && declares('panelRow', 'padding:0 12px'),
    'panelGlyph 18px (--dshx-icon-box)': declares('panelGlyph', 'width:18px'),
    'navSectionLabel margin 12px 10px 6px (--dshx-label-inset: 10px)': declares('navSectionLabel', 'margin:12px 10px 6px'),
    'workspace sectionHeader padding-left 10px (--dshx-label-inset)': declares('sectionHeader', 'padding-left:10px'),
    'workspace rows padding 0 12px (--dshx-row-inset)': declares('sessionRow', 'padding:0 12px')
  };
  const changed = Object.entries(expected).filter(([key, ok]) => (key === 'tokens' ? ok.length > 0 : !ok)).map(([key, ok]) => (key === 'tokens' ? `missing tokens ${ok.join(' ')}` : key));
  if (changed.length) {
    console.error(`dsh-modern-ui ${version} changed what shared/sidebar.css is aligned to:\n  ` + changed.join('\n  ') + '\nUpdate shared/sidebar.css, then run node scripts/sync-sidebar-style.mjs.');
    process.exitCode = 1;
  }
  modernUiChecks = { version, checks: Object.keys(expected).length, changed };
}
console.log(JSON.stringify({ runtime, exemptionsUsed: false, plugins: rows, clientContractChecks: Object.keys(contracts).length, hostContractChecks: Object.keys(hostContracts).length, modernUi: modernUiChecks }, null, 2));
