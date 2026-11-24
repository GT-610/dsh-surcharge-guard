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
const efforts = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High', description: 'Deeper reasoning' },
]
const groups = { ok: true, value: { groups: [{ id: 'p', models: [
  { id: rule.model }, { id: 'gpt-6-luna', reasoning: { efforts, defaultEffort: 'high' } }, { id: 'gptish-model' },
] }], failures: [] } }

function formStore(value, { writable = true, status = 'ready', refusal = false, error, beforeWrite } = {}) {
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
      if (beforeWrite) await beforeWrite(writes.length)
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
  // Every rule now owns a switch next to its status badge, so switches are
  // addressed by label instead of "the only one on the page".
  const switchFor = label => root.root.findAllByProps({ role: 'switch' })
    .find(node => node.props['aria-label'] === label)
  const flip = label => act(async () => { switchFor(label).props.onClick() })
  // A row switch is named by the action it performs, which flips with the rule.
  const rowSwitch = entry => `${entry.enabled === false ? en.enableRule : en.disableRule} ${entry.provider}/${entry.model}`
  // Rendered text only: a test instance JSON-stringifies into fiber cycles.
  const cellText = node => (node.children ?? [])
    .map(child => typeof child === 'string' ? child : cellText(child)).join('')
  const rowStatus = index => cellText(root.root.findAllByType('tr')[index].findAllByType('td')[4])
  return { root, input, button, switchFor, flip, rowSwitch, rowStatus, text, click, form }
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
  const toggle = () => ui.switchFor(en.enabled)
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

test('explains a blocked Enable while the blurred threshold saves, then allows retry', async t => {
  for (const refusal of [false, true]) {
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const off = { ...rule, enabled: false }
    const form = formStore({ ...normal, rules: [off] }, { refusal, beforeWrite: count => count === 1 ? pending : undefined })
    const ui = await mount(t, { form })
    await editNumber(ui, fieldLabel, '300K')
    const status = () => ui.root.root.findByProps({ role: 'status' }).children.join('')
    assert.equal(ui.switchFor(ui.rowSwitch(off)).props.disabled, true)
    assert.equal(status(), en.saving)
    const updated = { ...off, surchargeAtTokens: 300000 }
    assert.deepEqual(form.writes, [mutation('rules', [updated])])

    await act(async () => { finish() })
    assert.equal(ui.switchFor(ui.rowSwitch(off)).props.disabled, false)
    if (refusal) {
      assert.equal(status(), '')
      assert.equal(ui.root.root.findByProps({ role: 'alert' }).children.join(''), en.saveFailed)
      assert.deepEqual(form.getSnapshot().value.rules, [off])
    } else {
      assert.equal(status(), en.thresholdSaved)
      assert.deepEqual(form.getSnapshot().value.rules, [updated])
      await ui.flip(ui.rowSwitch(updated))
      assert.deepEqual(form.writes[1], mutation('rules', [{ ...updated, enabled: true }], 11))
      assert.equal(status(), '')
      // The switch renames itself once the rule is on.
      assert.equal(ui.switchFor(ui.rowSwitch({ ...updated, enabled: true })).props['aria-checked'], 'true')
    }
  }
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
  assert.ok(ui.rowStatus(2).includes(en.off))
  assert.equal(ui.switchFor(ui.rowSwitch(added)).props['aria-checked'], 'false')
  assert.equal(ui.button(familyLabel(0)).props.disabled, true)
})

test('turns every rule on or off from one switch and reports the enabled count', async t => {
  const off = { ...rule, model: 'gpt-6-luna', enabled: false }
  const form = formStore({ ...normal, rules: [rule, off] })
  const ui = await mount(t, { form })
  assert.ok(ui.text().includes(en.rulesSummary.replace('{on}', '1').replace('{total}', '2')))
  // Not every rule is on, so the button offers to enable the rest.
  await ui.click(en.enableAll)
  assert.deepEqual(form.writes, [mutation('rules', [rule, { ...off, enabled: true }])])
  assert.ok(ui.text().includes(en.rulesSummary.replace('{on}', '2').replace('{total}', '2')))
  await ui.click(en.disableAll)
  // The second click reads the store's accepted value, so both rules turn off.
  assert.deepEqual(form.writes[1], mutation('rules', [{ ...rule, enabled: false }, { ...off, enabled: false }], 11))
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
  await ui.flip(ui.rowSwitch(newRule))
  assert.deepEqual(ui.form.writes[1], mutation('rules', [{ ...newRule, enabled: true }], 11))
  assert.ok(ui.rowStatus(1).includes(en.on))
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
  assert.match(ui.root.root.findAllByType('tr')[3].findAllByType('td')[1].children[0].children[0], /gpt-dormant/)
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
  await ui.flip(ui.rowSwitch(rule))
  assert.deepEqual(bare.writes, [mutation('rules', [{ ...rule, enabled: false }], 20)])
  const unavailable = await mount(t, { unavailable: true })
  assert.ok(unavailable.text().includes(en.notWritable))
})

test('surfaces refused and thrown writes without painting an unaccepted change', async t => {
  for (const args of [{ refusal: true }, { error: Error('transport offline') }]) {
    const ui = await mount(t, { form: formStore(normal, args) })
    await ui.flip(ui.rowSwitch(rule))
    assert.match(ui.text(), args.error ? /Save failed: transport offline/ : /Save failed/)
    // The rejected write left the rule on, so its switch still reads checked.
    assert.equal(ui.switchFor(ui.rowSwitch(rule)).props['aria-checked'], 'true')
  }
})

// ---- per-rule summary model ------------------------------------------------

const summaryLabel = `${en.summaryModel} ${rule.provider}/${rule.model}`
const select = ui => ui.root.root.findByProps({ 'aria-label': summaryLabel })
const choose = (ui, value) => firing(() => select(ui), 'onChange', { target: { value } })
const optionValues = ui => select(ui).findAllByType('option').map(node => node.props.value)

test('offers the live catalog with the default selected, and drops the override when cleared', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  assert.equal(select(ui).props.value, JSON.stringify([summaryTarget.provider, summaryTarget.model]))
  assert.deepEqual(optionValues(ui)[0], '')
  assert.ok(optionValues(ui).includes(JSON.stringify(['p', 'gpt-6-luna'])))

  await choose(ui, '')
  // Clearing removes the field instead of writing a placeholder route.
  assert.deepEqual(ui.form.writes, [mutation('rules', [rule])])
  assert.equal(select(ui).props.value, '')
})

test('writes exactly the chosen route and names a cross-provider destination', async t => {
  const ui = await mount(t)
  const value = JSON.stringify(['p', 'gpt-6-luna'])
  await choose(ui, value)
  assert.deepEqual(ui.form.writes, [mutation('rules', [{
    ...rule, summaryTarget: { provider: 'p', model: 'gpt-6-luna' },
  }])])
  assert.equal(select(ui).props.value, value)
  assert.equal(ui.text().includes('Summary model'), true)
  // Same provider: no data-destination warning.
  assert.equal(ui.text().includes(en.summaryProviderNotice.slice(0, 20)), false)

  const foreign = await mount(t)
  await choose(foreign, JSON.stringify(['q', 'other']))
  assert.equal(foreign.text().includes('are sent to q'), true)
})

test('keeps a saved route that left the catalog visible, flagged, and replaceable', async t => {
  const summaryTarget = { provider: 'gone', model: 'retired' }
  const ui = await mount(t, {
    form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }),
    modelCatalog: async () => emptyGroups,
  })
  const saved = select(ui).props.value
  assert.equal(saved, JSON.stringify(['gone', 'retired']), 'the saved value stays selected')
  const orphan = select(ui).findAllByType('option').find(node => node.props.value === saved)
  assert.match(orphan.children.join(''), /retired · gone/)
  // Still replaceable by any live model, or clearable back to the default.
  await choose(ui, JSON.stringify(['p', 'gpt-6-luna']))
  assert.deepEqual(ui.form.writes[0].ops[0].value[0].summaryTarget, { provider: 'p', model: 'gpt-6-luna' })
})

test('a refused summary write keeps the previously saved route on screen', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna' }
  const ui = await mount(t, {
    form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }, { refusal: true }),
  })
  await choose(ui, '')
  assert.equal(select(ui).props.value, JSON.stringify(['p', 'gpt-6-luna']))
  assert.match(ui.text(), /Save failed/)
})

// ---- per-rule summary reasoning effort --------------------------------------

const effortLabel = (provider = 'p', model = 'gpt-6-luna') => `${en.summaryEffort} ${provider}/${model}`
const effortSelect = (ui, provider, model) => ui.root.root.findByProps({ 'aria-label': effortLabel(provider, model) })
const chooseEffort = (ui, value) => firing(() => effortSelect(ui), 'onChange', { target: { value } })
const effortOptionValues = ui => effortSelect(ui).findAllByType('option').map(node => node.props.value)

test('offers the efforts of the chosen summary route with the model default first', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  assert.equal(effortSelect(ui).props.value, '')
  assert.deepEqual(effortOptionValues(ui), ['', 'off', 'low', 'high'])
  // Names come from the catalog; descriptions stay on the option title.
  const high = effortSelect(ui).findAllByType('option').find(node => node.props.value === 'high')
  assert.equal(high.children.join(''), 'High')
  assert.equal(high.props.title, 'Deeper reasoning')
})

test('the effort choice appears only once a summary route is chosen', async t => {
  const ui = await mount(t)
  assert.equal(ui.root.root.findAllByProps({ 'aria-label': effortLabel() }).length, 0)
  await choose(ui, JSON.stringify(['p', 'gpt-6-luna']))
  assert.equal(effortSelect(ui).props.value, '', 'a new route starts from its own default')
  // Clearing the route clears the effort with it.
  await choose(ui, '')
  assert.equal(ui.root.root.findAllByProps({ 'aria-label': effortLabel() }).length, 0)
})

test('writes exactly the chosen effort and clears it back to the default', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  await chooseEffort(ui, 'low')
  assert.deepEqual(ui.form.writes, [mutation('rules', [{
    ...rule, summaryTarget: { ...summaryTarget, reasoningEffort: 'low' },
  }])])
  assert.equal(effortSelect(ui).props.value, 'low')
  await chooseEffort(ui, '')
  assert.deepEqual(ui.form.writes[1].ops[0].value, [{ ...rule, summaryTarget }])
})

test('switching the summary model drops an effort that belonged to the old route', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna', reasoningEffort: 'low' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  await choose(ui, JSON.stringify(['q', 'other']))
  assert.deepEqual(ui.form.writes[0].ops[0].value[0].summaryTarget, { provider: 'q', model: 'other' })
  // Re-picking the same route keeps its effort.
  const same = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  await choose(same, JSON.stringify(['p', 'gpt-6-luna']))
  assert.deepEqual(same.form.writes[0].ops[0].value[0].summaryTarget, summaryTarget)
})

test('re-picking a route whose stored effort is blank writes no empty effort', async t => {
  // "Default" has one spelling in the document: an absent field. A stored
  // empty string must not be perpetuated just because the route was re-picked.
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna', reasoningEffort: '' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  await choose(ui, JSON.stringify(['p', 'gpt-6-luna']))
  assert.deepEqual(ui.form.writes[0].ops[0].value[0].summaryTarget, { provider: 'p', model: 'gpt-6-luna' })
})

test('keeps a saved effort the catalog no longer offers visible and flagged', async t => {
  const summaryTarget = { provider: 'p', model: 'gpt-6-luna', reasoningEffort: 'ultra' }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  assert.equal(effortSelect(ui).props.value, 'ultra')
  const saved = effortSelect(ui).findAllByType('option').find(node => node.props.value === 'ultra')
  assert.match(saved.children.join(''), /ultra/)
  assert.match(saved.children.join(''), new RegExp(en.summaryUnconfirmed))
})

test('explains a route whose live catalog advertises no reasoning effort', async t => {
  const summaryTarget = { provider: 'p', model: rule.model }
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  assert.deepEqual(effortSelect(ui, 'p', rule.model).findAllByType('option').map(node => node.props.value), [''])
  assert.ok(ui.text().includes(en.summaryEffortUnknown))
})

test('does not claim a route has no levels when the catalog never described it', async t => {
  const summaryTarget = { provider: 'gone', model: 'retired' }
  const effortOptions = ui => effortSelect(ui, 'gone', 'retired').findAllByType('option').map(node => node.props.value)

  // The route is absent from the catalog entirely: the summary-model select
  // already flags that, so the effort hint must stay silent rather than
  // assert a capability nothing observed.
  const absent = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }) })
  assert.deepEqual(effortOptions(absent), [''])
  assert.equal(absent.text().includes(en.summaryEffortUnknown), false)

  // Nor when the catalog itself could not be read.
  const offline = await mount(t, {
    form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }),
    modelCatalog: async () => ({ ok: false, error: { message: 'offline' } }),
  })
  assert.equal(offline.text().includes(en.summaryEffortUnknown), false)

  // A model declared in the provider settings but never described by a live
  // catalog is the same unknown: the row exists, the capability does not.
  const declared = formStore({ providers: { gone: { models: [{ id: 'retired' }] } } })
  const undeclaredLive = await mount(t, {
    form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }),
    declared,
    modelCatalog: async () => ({ ok: false, error: { message: 'offline' } }),
  })
  assert.equal(undeclaredLive.text().includes(en.summaryEffortUnknown), false)

  // The catalog answering with a provider failure is also not an answer.
  const failedProvider = await mount(t, {
    form: formStore({ ...normal, rules: [{ ...rule, summaryTarget }] }),
    declared,
    modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [{ id: 'gone', message: 'unreachable' }] } }),
  })
  assert.equal(failedProvider.text().includes(en.summaryEffortUnknown), false)
})

test('survives a stored null summary target instead of crashing the panel', async t => {
  // The Config schema permits `summaryTarget: null`, so the panel must render.
  const ui = await mount(t, { form: formStore({ ...normal, rules: [{ ...rule, summaryTarget: null }] }) })
  assert.equal(select(ui).props.value, '')
  assert.equal(ui.root.root.findAllByProps({ 'aria-label': effortLabel() }).length, 0)
})
