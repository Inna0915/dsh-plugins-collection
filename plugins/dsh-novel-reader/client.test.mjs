import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('DSH loads and registers the reading tab with factory(require)', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let plugin
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-novel-reader')
          plugin = factory(name => {
            assert.equal(name, 'react')
            return {}
          })
        }
      }
    }
  })
  assert.ok(plugin.inject.includes('sidebarRightTabs'))
  let reader
  plugin.apply({
    effect: action => action(),
    sidebarRightTabs: { register: tab => { reader = tab } },
    slots: { inject: (_slot, register) => register(), register: () => {} }
  })
  assert.equal(reader.kind, 'novel-reader')
  assert.equal(reader.keepMounted, true)
})
