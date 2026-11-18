import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const React = require('react')
const { act, create } = require('react-test-renderer')
const h = React.createElement
const NS = 'dsh-surcharge-guard'
const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
let moduleFactory
const oldWindow = globalThis.window
try {
  globalThis.window = { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, NS); moduleFactory = factory } } }
  await import('../client.js')
} finally {
  if (oldWindow === undefined) delete globalThis.window
  else globalThis.window = oldWindow
}

const rule = { provider: 'p', model: 'gpt-6-sol', surchargeAtTokens: 272400, enabled: true }
const normal = { enabled: true, safetyMarginTokens: 20000, retainRatio: 0.16, maxAttempts: 2, rules: [rule] }
const absent = { status: 'unavailable', writable: false }
const emptyGroups = { ok: true, value: { groups: [], failures: [] } }
const groups = { ok: true, value: { groups: [{ id: 'p', models: [
  { id: rule.model }, { id: 'gpt-6-luna' }, { id: 'gptish-model' },
] }], failures: [] } }

function formStore(value, { writable = true, status = 'ready', refusal = false, error } = {}) {
  let snapshot = { writable, status, value, revision: 10 }
  const writes = []
  const listeners = new Set()
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    async mutate(ops, revision) {
      writes.push({ ops, revision })
      if (error) throw error
      if (refusal || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const { path, value: updated } of ops) value[path[0]] = updated
      this.publish({ value, revision: revision + 1 })
      return true
    },
  }
}

async function mount(t, { form = formStore(normal), page = false, bare, declared, unavailable = false,
  modelCatalog = async () => groups, catalogMissing = false } = {}) {
  const unserved = { getSnapshot: () => absent, subscribe: () => () => {} }
  let component
  let translations
  let namespace
  const module = moduleFactory(name => { assert.equal(name, 'react'); return React })
  module.apply({
    effect(run) { run() },
    locale: {
      register(ns, dictionaries) { namespace = ns; translations = dictionaries.en },
      bind(ns) { assert.equal(ns, namespace); return key => translations[key] ?? `[${key}]` },
    },
    slots: {
      inject(slot, run) { assert.equal(slot, 'plugins.bundle.config'); run() },
      register(slot, renderer) {
        assert.deepEqual(slot, { name: 'plugins.bundle.config', key: NS, locale: NS })
        component = renderer
      },
    },
    get(key) {
      if (key === 'remote.session') return catalogMissing ? undefined : { modelCatalog }
      if (key === 'configForms') {
        return { get(id) {
          if (id === 'include:llm-pi-ai' && declared) return declared
          if (id === `include:${NS}` && !page && !unavailable && !bare) return form
          if (id === NS && bare) return bare
          return unserved
        } }
      }
    },
  })
  assert.equal(typeof component, 'function', 'apply registers a real bundle settings renderer')
  function Owner() {
    const state = React.useSyncExternalStore(form.subscribe, form.getSnapshot)
    return h(component, { view: 'page', form: { state, mutate: form.mutate.bind(form) } })
  }
  let root
  await act(async () => { root = create(h(page ? Owner : component, { view: 'page' })) })
  t.after(() => act(async () => { root.unmount() }))
  const input = label => root.root.findAllByType('input').find(node => node.props['aria-label'] === label)
  const button = label => root.root.findAllByType('button').find(node => node.children.join('') === label)
  const text = () => JSON.stringify(root.toJSON())
  const click = label => act(async () => { await button(label).props.onClick() })
  return { root, input, button, text, click, form }
}

const fieldLabel = `${en.colLine} ${rule.provider}/${rule.model}`
const familyLabel = count => `${en.addFamily.replace('{family}', 'GPT')} (${count})`
const mutation = (field, value, revision = 10) => ({ ops: [{ op: 'set', path: [field], value }], revision })
const firing = (node, action, argument) => act(async () => { node().props[action](argument) })
async function editNumber(ui, label, text) {
  const field = () => ui.input(label)
  await firing(field, 'onFocus')
  await firing(field, 'onChange', { target: { value: text } })
  await firing(field, 'onBlur')
}

test('mounts the registered page with the owner form and writes using its revision', async t => {
  const ui = await mount(t, { page: true })
  assert.equal(ui.input(fieldLabel).props.value, '272K')
  assert.ok(ui.text().includes('252K'))
  const toggle = () => ui.root.root.findByProps({ role: 'switch' })
  await firing(toggle, 'onClick')
  assert.deepEqual(ui.form.writes, [mutation('enabled', false)])
  assert.equal(toggle().props['aria-checked'], 'false')
})

test('rounded display never saves on focus or blur, and edits only save after commit', async t => {
  const ui = await mount(t)
  const field = () => ui.input(fieldLabel)
  await firing(field, 'onFocus')
  assert.equal(field().props.value, '272400')
  await firing(field, 'onBlur')
  assert.deepEqual(ui.form.writes, [])
  await firing(field, 'onFocus')
  await firing(field, 'onChange', { target: { value: '1.000001M' } })
  assert.deepEqual(ui.form.writes, [])
  await firing(field, 'onBlur')
  assert.deepEqual(ui.form.writes, [mutation('rules', [{ ...rule, surchargeAtTokens: 1000001 }])])
  await firing(field, 'onFocus')
  assert.equal(field().props.value, '1000001')
  await firing(field, 'onBlur')
})

test('accepts zero only for nonnegative fields and enforces inclusive retention bounds', async t => {
  const ui = await mount(t)
  await editNumber(ui, en.margin, '0')
  await editNumber(ui, en.maxAttempts, '0')
  await editNumber(ui, en.retain, '.01')
  await editNumber(ui, en.retain, '.9')
  await editNumber(ui, fieldLabel, '0')
  assert.deepEqual(ui.form.writes, [mutation('safetyMarginTokens', 0), mutation('maxAttempts', 0, 11),
    mutation('retainRatio', 0.01, 12), mutation('retainRatio', 0.9, 13)])
  assert.ok(ui.text().includes(en.invalidNumber))
  await editNumber(ui, fieldLabel, '1.1')
  assert.equal(ui.form.writes.length, 4)
})

test('prefills only the missing family matches and leaves every new rule off', async t => {
  const ui = await mount(t)
  await ui.click(familyLabel(1))
  const added = { provider: 'p', model: 'gpt-6-luna', surchargeAtTokens: 272000, enabled: false }
  assert.deepEqual(ui.form.writes, [mutation('rules', [rule, added])])
  const rows = ui.root.root.findAllByType('tr')
  assert.equal(rows.length, 3)
  assert.equal(rows[2].findAllByType('td')[4].children.join(''), en.off)
  assert.equal(ui.button(familyLabel(0)).props.disabled, true)
})

test('allows a hand-entered rule without a catalog, rejects duplicates, and renders later toggles', async t => {
  const ui = await mount(t, { catalogMissing: true, form: formStore({ ...normal, rules: [] }) })
  const enter = async () => {
    for (const [label, value] of [[en.manualProvider, ' custom '], [en.manualModel, ' other-model '], [en.manualLine, '300K']]) {
      await firing(() => ui.input(label), 'onChange', { target: { value } })
    }
    await ui.click(en.addManual)
  }
  await enter()
  const newRule = { provider: 'custom', model: 'other-model', surchargeAtTokens: 300000, enabled: false }
  assert.deepEqual(ui.form.writes, [mutation('rules', [newRule])])
  assert.equal(ui.input(en.manualProvider).props.value, '')
  await enter()
  assert.ok(ui.text().includes(en.duplicateRule))
  assert.equal(ui.form.writes.length, 1)
  await ui.click(en.enableRule)
  assert.deepEqual(ui.form.writes[1], mutation('rules', [{ ...newRule, enabled: true }], 11))
  assert.equal(ui.root.root.findAllByType('tr')[1].findAllByType('td')[4].children.join(''), en.on)
  await ui.click(en.remove)
  assert.deepEqual(ui.form.writes[2], mutation('rules', [], 12))
  assert.ok(ui.text().includes(en.rulesEmpty))
})

test('separates empty catalog from API errors, and does not discard declared models', async t => {
  const declared = formStore({ providers: { q: { models: [{ id: 'gpt-x' }] } } })
  const ui = await mount(t, { declared, modelCatalog: async () => ({ ok: false, error: { message: 'offline' } }) })
  assert.match(ui.text(), /Could not read the model catalog: offline/)
  assert.equal(ui.text().includes(en.noModels), false)
  assert.equal(ui.button(familyLabel(1)).props.disabled, false)
  const empty = await mount(t, { modelCatalog: async () => emptyGroups })
  assert.ok(empty.text().includes(en.noModels))
})

test('merges live and late-loaded declarations without duplicate rules or false dormant labels', async t => {
  const declared = formStore(undefined, { status: 'loading' })
  const ui = await mount(t, { declared })
  await act(async () => declared.publish({ status: 'ready', value: { providers: {
    p: { models: [{ id: rule.model, contextWindow: 450000 }, { id: 'gpt-6-luna' }, { id: 'gpt-dormant' }] },
  } } }))
  assert.equal(ui.button(familyLabel(2)).props.disabled, false)
  assert.ok(ui.text().includes('450K'))
  assert.equal(ui.text().includes(en.dormant), false)
  await ui.click(familyLabel(2))
  const rows = ui.root.root.findAllByType('tr')
  assert.equal(rows.length, 4)
  assert.match(JSON.stringify(rows[3].findAllByType('td')[1].children[0]), /gpt-dormant/)
  assert.ok(ui.text().includes(en.dormant))
})

test('a stale catalog response cannot overwrite a newer scan', async t => {
  let firstResolve
  let requests = 0
  const ui = await mount(t, { modelCatalog: () => requests++ === 0 ? new Promise(resolve => { firstResolve = resolve }) : Promise.resolve(groups) })
  await ui.click(en.scan)
  assert.ok(ui.button(familyLabel(1)))
  await act(async () => firstResolve(emptyGroups))
  assert.ok(ui.button(familyLabel(1)))
  assert.equal(ui.text().includes(en.noModels), false)
})

test('falls back to a directly inserted row and follows live store publications', async t => {
  const bare = formStore({ ...normal, rules: [] })
  const ui = await mount(t, { bare })
  assert.ok(ui.text().includes(en.rulesEmpty))
  await act(async () => bare.publish({ value: normal, revision: 20 }))
  await ui.click(en.disableRule)
  assert.deepEqual(bare.writes, [mutation('rules', [{ ...rule, enabled: false }], 20)])
  const unavailable = await mount(t, { unavailable: true })
  assert.ok(unavailable.text().includes(en.notWritable))
})

test('surfaces refused and thrown writes without painting an unaccepted change', async t => {
  for (const args of [{ refusal: true }, { error: Error('transport offline') }]) {
    const ui = await mount(t, { form: formStore(normal, args) })
    await ui.click(en.disableRule)
    assert.match(ui.text(), args.error ? /Save failed: transport offline/ : /Save failed/)
    assert.ok(ui.button(en.disableRule))
  }
})
