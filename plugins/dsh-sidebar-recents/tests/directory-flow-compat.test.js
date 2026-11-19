import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HERO_FLOW_SLOT,
  PICKER_FACTORY_NAME,
  PICKER_FLOW_SLOT,
  SIDEBAR_FLOW_SLOT,
  installDirectoryFlowCompat,
} from '../src/client/directory-flow-compat.js';

function createMockSlots() {
  const specs = new Map();
  const factories = new Map();
  const listeners = new Map();
  const registrations = [];

  const notify = (key) => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };

  const declare = (key, spec) => {
    specs.set(key, spec);
    notify(key);
  };

  const undeclare = (key) => {
    specs.delete(key);
    notify(key);
  };

  const slots = {
    spec(key) {
      return specs.get(key);
    },
    inject(key, callback) {
      let activeCleanup = null;
      let active = false;
      const reconcile = () => {
        const present = specs.has(key);
        if (present && !active) {
          active = true;
          const res = callback();
          activeCleanup = typeof res === 'function' ? res : null;
        } else if (!present && active) {
          active = false;
          const fn = activeCleanup;
          activeCleanup = null;
          fn?.();
        }
      };
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(reconcile);
      reconcile();
      return () => {
        listeners.get(key)?.delete(reconcile);
        if (active) {
          active = false;
          const fn = activeCleanup;
          activeCleanup = null;
          fn?.();
        }
      };
    },
    registerFactory(options, component) {
      if (factories.has(options.name)) {
        throw new Error(`slot factory "${options.name}" already has a definition`);
      }
      for (const child of Object.keys(options.children ?? {})) {
        if (specs.has(child)) throw new Error(`slot "${child}" is already declared`);
      }
      factories.set(options.name, { options, component });
      registrations.push(options.name);
      for (const [child, spec] of Object.entries(options.children ?? {})) {
        declare(child, spec);
      }
      return () => {
        if (!factories.has(options.name)) return;
        factories.delete(options.name);
        for (const child of Object.keys(options.children ?? {})) {
          undeclare(child);
        }
      };
    },
  };

  return { slots, declare, undeclare, factories, registrations };
}

const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

test('declares missing workspace.picker.directoryFlow to unblock 3-slot directory pickers and cleans up on dispose', async () => {
  const { slots, declare, factories } = createMockSlots();
  declare(SIDEBAR_FLOW_SLOT, { kind: 'single', scope: 'root' });
  declare(HERO_FLOW_SLOT, { kind: 'single', scope: 'root' });

  let pickerRegistered = false;
  const disposePicker = slots.inject(HERO_FLOW_SLOT, () =>
    slots.inject(SIDEBAR_FLOW_SLOT, () =>
      slots.inject(PICKER_FLOW_SLOT, () => {
        pickerRegistered = true;
        return () => {
          pickerRegistered = false;
        };
      }),
    ),
  );
  assert.equal(pickerRegistered, false, 'directory picker stays blocked while third slot is missing');

  const disposeCompat = installDirectoryFlowCompat({ slots });
  await flushMicrotasks();

  assert.equal(factories.has(PICKER_FACTORY_NAME), true);
  assert.ok(slots.spec(PICKER_FLOW_SLOT));
  assert.equal(pickerRegistered, true, 'directory picker unblocks once shim declares workspace.picker.directoryFlow');

  disposeCompat();
  assert.equal(factories.has(PICKER_FACTORY_NAME), false);
  assert.equal(slots.spec(PICKER_FLOW_SLOT), undefined);
  assert.equal(pickerRegistered, false);
  disposePicker();
});

test('stays inert when official ui-workspace declares workspace.picker.directoryFlow in the same tick', async () => {
  const { slots, declare, registrations } = createMockSlots();
  declare(SIDEBAR_FLOW_SLOT, { kind: 'single', scope: 'root' });
  declare(HERO_FLOW_SLOT, { kind: 'single', scope: 'root' });

  const disposeCompat = installDirectoryFlowCompat({ slots });
  // Simulate official ui-workspace registering workspace.picker right after sidebar.workspaces
  declare(PICKER_FLOW_SLOT, { kind: 'single', scope: 'root' });
  await flushMicrotasks();

  assert.deepEqual(registrations, [], 'shim must not register factory when slot is already declared');
  disposeCompat();
  assert.ok(slots.spec(PICKER_FLOW_SLOT), 'disposing inert shim must not disturb existing slot');
});

test('fails safely when host slots service omits spec or registerFactory', () => {
  assert.doesNotThrow(() => {
    const dispose = installDirectoryFlowCompat({ slots: { inject() {} } });
    dispose();
  });
});
