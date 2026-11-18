import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { normalizeConfig } from '../logic.js'

const route = { provider: 'p', model: 'guarded' }
const other = { provider: 'p', model: 'other' }
const options = {
  rules: [{ ...route, surchargeAtTokens: 1000 }],
  safetyMarginTokens: 100,
  retainRatio: 0.15,
  maxAttempts: 2,
}
const user = tokens => ({ role: 'user', tokens })

function fixture({ config = options, total = 900, previous, available = true, shrink = [400], error, root = false } = {}) {
  let hook
  let pressure = total
  const calls = { estimates: [], measures: [], compacts: [], warnings: [], logs: [], services: [], next: 0 }
  const session = {
    surface: { nodes: [0, 1, 2] },
    requestHeader: () => previous,
    eventAt: seq => ({ seq, type: seq === 0 ? 'system/message' : 'user/message' }),
  }
  const agent = { session }
  const compaction = {
    compactRegion(start, end, owner, signal) {
      calls.compacts.push({ start, end, owner, signal })
      if (error) throw error
      pressure = shrink[calls.compacts.length - 1] ?? pressure
      return { shadowedSeqs: [start] }
    },
  }
  const ctx = {
    get(key) {
      if (!available) return undefined
      if (root) return key === 'compaction' ? compaction : undefined
      return key === 'agentPresets' ? { serviceFor(owner, name) {
        calls.services.push({ owner, name })
        return compaction
      } } : undefined
    },
    on(name, handler, opts) {
      assert.equal(hook, undefined)
      assert.equal(name, 'agent/pre-step')
      assert.deepEqual(opts, { prepend: true })
      hook = handler
    },
    tokenMeter: {
      estimateMessage(msg) { calls.estimates.push(msg); return msg.tokens },
      measure(owner, header) {
        calls.measures.push({ owner, header })
        return { totalTokens: pressure, nodes: owner.surface.nodes.map(seq => ({ seq, tokens: 160 })) }
      },
    },
    logger: { info: text => calls.logs.push(text), warn: text => calls.warnings.push(text) },
  }
  apply(ctx, config)
  async function step({ turn = 1, signal = new AbortController().signal, modelSelection = route, claimed = [],
    decision = { kind: 'enter', messages: claimed }, beforeDecision } = {}) {
    const result = await hook({ agent, messages: claimed, modelSelection, turn, step: calls.next + 1, signal }, async () => {
      calls.next += 1
      beforeDecision?.(value => { pressure = value })
      return decision
    })
    assert.equal(result, decision)
  }
  return { step, session, agent, calls }
}

test('first-step pressure includes the admitted messages and resolves the isolated backend', async () => {
  const { step, calls, agent, session } = fixture({ total: 800 })
  const admitted = [user(60), user(40)]
  const signal = new AbortController().signal
  await step({ claimed: [user(1)], decision: { kind: 'enter', messages: admitted }, signal })
  assert.deepEqual(calls.estimates, admitted)
  assert.deepEqual(calls.measures, Array.from({ length: 2 }, () => ({ owner: session, header: { config: route } })))
  assert.deepEqual(calls.services, [{ owner: agent, name: 'compaction' }])
  assert.deepEqual(calls.compacts, [{ start: 1, end: 1, owner: agent, signal }])
  assert.equal(calls.next, 1)
  assert.deepEqual(calls.warnings, [])
})

test('switches into the selected guarded route and ignores the old rule when switching away', async () => {
  const tools = [{ name: 'test-tool' }]
  const providerSwitch = fixture({ previous: { config: { ...other, reasoningEffort: 'low' }, tools }, root: true })
  await providerSwitch.step({ modelSelection: { ...route, reasoningEffort: 'high' } })
  assert.equal(providerSwitch.calls.compacts.length, 1)
  assert.deepEqual(providerSwitch.calls.measures[0].header, { config: { ...route, reasoningEffort: 'high' }, tools })
  const leave = fixture({ previous: { config: route } })
  await leave.step({ modelSelection: other })
  assert.equal(leave.calls.measures.length, 0)
  assert.equal(leave.calls.compacts.length, 0)
})

test('uses the post-middleware surface and does not compact just below the trigger', async () => {
  const { step, calls } = fixture({ total: 1800 })
  await step({ beforeDecision: setPressure => setPressure(899) })
  assert.equal(calls.measures.length, 1)
  assert.equal(calls.compacts.length, 0)
  assert.equal(calls.services.length, 0)
})

test('rechecks after each summary, warns on residual surcharge, and preserves step admission', async () => {
  const { step, calls } = fixture({ total: 1800, shrink: [1400, 1200] })
  await step({ claimed: [user(10)] })
  assert.equal(calls.compacts.length, 2)
  assert.equal(calls.measures.length, 3)
  assert.match(calls.warnings[0], /at or above the surcharge line.*1210.*surcharge line 1000/)
})

test('a no-progress summary is not repeated in the same step', async () => {
  const { step, calls } = fixture({ total: 1200, shrink: [1200] })
  await step()
  assert.equal(calls.compacts.length, 1)
  assert.match(calls.warnings[0], /did not lower/)
})

test('failed summary consumes the turn budget; surface growth does not reset it', async () => {
  const { step, calls, session } = fixture({ config: { ...options, maxAttempts: 1 }, total: 1200, error: Error('offline summary failure') })
  await step()
  session.surface.nodes.push(3)
  await step()
  assert.equal(calls.compacts.length, 1)
  await step({ turn: 2 })
  assert.equal(calls.compacts.length, 2)
  assert.equal(calls.next, 3)
  assert.match(calls.warnings[0], /offline summary failure/)
  assert.match(calls.warnings[1], /budget exhausted/)
})

test('no safe range does not spend the turn budget; absent compaction warns and passes through', async () => {
  const noRange = fixture({ config: { ...options, maxAttempts: 1 } })
  noRange.session.surface.nodes = [0, 1]
  await noRange.step()
  assert.match(noRange.calls.warnings[0], /no safe history/)
  noRange.session.surface.nodes.push(2)
  await noRange.step()
  assert.equal(noRange.calls.compacts.length, 1)
  const missing = fixture({ available: false })
  await missing.step()
  assert.match(missing.calls.warnings[0], /no compaction service/)
})

test('disabled, zero-budget, rejected and aborted steps never measure or summarize', async () => {
  const abort = new AbortController()
  abort.abort()
  for (const [opts, event] of [
    [{ config: { ...options, enabled: false } }, {}],
    [{ config: { ...options, maxAttempts: 0 } }, {}],
    [{}, { decision: { kind: 'reject' } }],
    [{}, { signal: abort.signal }],
  ]) {
    const { step, calls } = fixture(opts)
    await step(event)
    assert.deepEqual([calls.next, calls.measures.length, calls.compacts.length], [1, 0, 0])
  }
})

test('reads the real schema defaults and inclusive retention boundaries', () => {
  for (const retainRatio of [0.01, 0.9]) {
    const config = normalizeConfig(Config({ retainRatio, maxAttempts: 0, safetyMarginTokens: 0, rules: null }))
    assert.deepEqual(config, { enabled: true, retainRatio, maxAttempts: 0, safetyMarginTokens: 0, rules: [] })
  }
  const defaults = normalizeConfig(Config({}))
  assert.deepEqual(defaults, { enabled: true, rules: [], retainRatio: 0.16, maxAttempts: 2, safetyMarginTokens: 20000 })
})

test('live updates take effect without reapplying the plugin', async () => {
  let enabled = false
  const { step, calls } = fixture({ config: { ...options, enabled: { get: () => enabled } } })
  await step()
  assert.equal(calls.measures.length, 0)
  enabled = true
  await step()
  assert.equal(calls.compacts.length, 1)
})
