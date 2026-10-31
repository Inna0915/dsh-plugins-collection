import assert from 'node:assert/strict';

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

await import('../dist/client.js');
assert.ok(loaded, 'client bundle did not register with __ModuleLoader__');
assert.equal(loaded.id, 'dsh-sidebar-recents');

const ReactStub = {
  createElement() {
    return { type: 'stub' };
  },
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useMemo() {},
  useRef() {},
  useState() {},
  useSyncExternalStore() {},
};

const ReactDomStub = {
  createPortal() {
    return { type: 'stub' };
  },
};

const exportsObject = loaded.factory((name) => {
  if (name === 'react') return ReactStub;
  if (name === 'react-dom') return ReactDomStub;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { StateDot() {} };
  if (name === '@deepseek-ai/dsh-client-store') return {
    createSnapshotStore(initial) {
      return { getSnapshot: () => initial, subscribe: () => () => {}, set() {} };
    },
  };
  throw new Error(`unexpected external module: ${name}`);
});
assert.equal(typeof exportsObject.apply, 'function', 'client bundle has no apply()');
assert.ok(Array.isArray(exportsObject.inject), 'client bundle has no inject array');
for (const service of ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession']) {
  assert.ok(exportsObject.inject.includes(service), `missing injected service ${service}`);
}

function makeContext() {
  const registrations = [];
  const cleanups = [];
  const context = {
    effect(factory) {
      const cleanup = factory();
      cleanups.push(cleanup);
      return cleanup;
    },
    slots: {
      inject(_name, factory) {
        factory();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    get() {
      return undefined;
    },
    cleanups,
  };
  return { context, registrations };
}

for (let attempt = 0; attempt < 2; attempt += 1) {
  const { context, registrations } = makeContext();
  assert.doesNotThrow(() => exportsObject.apply(context));
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'sidebar.footer.action');
  assert.equal(registrations[0].options.id, 'sidebar-recents');
  assert.equal(typeof registrations[0].component, 'function');
  for (const cleanup of context.cleanups.reverse()) {
    if (typeof cleanup === 'function') cleanup();
  }
}

console.log('dist/client.js loads, exposes apply/inject, and registers once per apply.');
