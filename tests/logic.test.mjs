/**
 * Unit tests for the guard's decision logic.
 *
 * These run against `logic.js`, which imports nothing, so `node --test` needs
 * no dependency installation beyond the Node runtime itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeRule, normalizeConfig, ruleFor, balanceCuts, selectRange } from '../logic.js'

test('normalizeRule rejects unusable entries', () => {
  assert.equal(normalizeRule(null), undefined)
  assert.equal(normalizeRule({ provider: 'p', model: 'm' }), undefined)
  assert.equal(normalizeRule({ provider: '', model: 'm', surchargeAtTokens: 100 }), undefined)
  assert.equal(normalizeRule({ provider: 'p', model: 'm', surchargeAtTokens: 0 }), undefined)
  assert.equal(normalizeRule({ provider: 'p', model: 'm', surchargeAtTokens: -5 }), undefined)
  assert.deepEqual(
    normalizeRule({ provider: ' p ', model: ' m ', surchargeAtTokens: 100 }),
    { provider: 'p', model: 'm', surchargeAtTokens: 100, enabled: true },
  )
  assert.equal(normalizeRule({ provider: 'p', model: 'm', surchargeAtTokens: 100, enabled: false }).enabled, false)
})

test('normalizeConfig drops duplicates and fills defaults', () => {
  const config = normalizeConfig({
    rules: [
      { provider: 'p', model: 'm', surchargeAtTokens: 272000 },
      { provider: 'p', model: 'm', surchargeAtTokens: 200000 },
      { provider: 'q', model: 'n', surchargeAtTokens: 200000 },
    ],
  })
  assert.equal(config.rules.length, 2)
  assert.equal(config.rules[0].surchargeAtTokens, 272000, 'first duplicate wins')
  assert.equal(config.enabled, true)
  assert.equal(config.safetyMarginTokens, 20000)
  assert.ok(Math.abs(config.retainRatio - 0.16) < 1e-9)
})

test('normalizeConfig clamps unusable scalars instead of propagating them', () => {
  const config = normalizeConfig({ safetyMarginTokens: -1, retainRatio: 5, maxAttempts: -3 })
  assert.equal(config.safetyMarginTokens, 20000)
  assert.equal(config.retainRatio, 0.16)
  assert.equal(config.maxAttempts, 2)
})

test('normalizeConfig reads live (volatile) references', () => {
  const config = normalizeConfig({
    enabled: { get: () => false },
    rules: { get: () => [{ provider: 'p', model: 'm', surchargeAtTokens: 100 }] },
    safetyMarginTokens: { get: () => 5000 },
  })
  assert.equal(config.enabled, false)
  assert.equal(config.rules.length, 1)
  assert.equal(config.safetyMarginTokens, 5000)
})

test('ruleFor requires an exact provider and model match', () => {
  const config = normalizeConfig({ rules: [{ provider: 'p', model: 'm', surchargeAtTokens: 100 }] })
  assert.ok(ruleFor(config, { provider: 'p', model: 'm' }))
  assert.equal(ruleFor(config, { provider: 'p', model: 'n' }), undefined)
  assert.equal(ruleFor(config, { provider: 'q', model: 'm' }), undefined)
})

test('ruleFor ignores disabled rules and a disabled config', () => {
  const disabledRule = normalizeConfig({ rules: [{ provider: 'p', model: 'm', surchargeAtTokens: 100, enabled: false }] })
  assert.equal(ruleFor(disabledRule, { provider: 'p', model: 'm' }), undefined)

  const disabledConfig = normalizeConfig({ enabled: false, rules: [{ provider: 'p', model: 'm', surchargeAtTokens: 100 }] })
  assert.equal(ruleFor(disabledConfig, { provider: 'p', model: 'm' }), undefined)
})

// ---- range selection -------------------------------------------------------

/** Build a fake session whose surface is the given seq list with event types. */
function fakeSession(events) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return {
    eventAt: seq => bySeq.get(seq),
    surface: { nodes: events.map(event => event.seq) },
  }
}

/** One assistant message carrying `calls` tool calls. */
const assistant = (seq, calls = 0) => ({
  seq,
  type: 'assistant/message',
  data: { message: { content: Array.from({ length: calls }, () => ({ type: 'tool-call' })) } },
})
const tool = seq => ({ seq, type: 'tool/result', data: {} })
const user = seq => ({ seq, type: 'user/message', data: {} })
const system = seq => ({ seq, type: 'system/message', data: {} })

/** Priced nodes matching a session's surface, one token each. */
const nodesOf = session => session.surface.nodes.map(seq => ({ seq, tokens: 1 }))

test('balanceCuts tracks open tool calls', () => {
  const session = fakeSession([user(1), assistant(2, 1), tool(3), user(4)])
  assert.deepEqual(balanceCuts(session, nodesOf(session)), [true, true, false, true, true])
})

test('balanceCuts rejects a surface with an unmatched result', () => {
  const session = fakeSession([user(1), tool(2)])
  assert.equal(balanceCuts(session, nodesOf(session)), undefined)
})

test('balanceCuts rejects a surface node with no matching event', () => {
  const session = fakeSession([user(1)])
  assert.equal(balanceCuts(session, [{ seq: 99, tokens: 1 }]), undefined)
})

test('selectRange always folds at a balanced cut', () => {
  // 1 user, then a call/result pair, then a trailing user.
  const session = fakeSession([user(1), assistant(2, 1), tool(3), user(4)])
  const range = selectRange(session, nodesOf(session), 1)
  // Retention of one token keeps seq 4; the cut before it is balanced.
  assert.deepEqual(range, { start: 1, end: 3 })
})

test('selectRange never cuts between a call and its result', () => {
  const session = fakeSession([user(1), assistant(2, 1), tool(3)])
  const range = selectRange(session, nodesOf(session), 0)
  // Retention 0 floors keepFrom to the last node (seq 3), whose leading cut is
  // unbalanced, so the cut rewinds to before the call.
  assert.deepEqual(range, { start: 1, end: 1 })
})

test('selectRange never includes a leading system message', () => {
  const session = fakeSession([system(1), user(2), user(3)])
  const range = selectRange(session, nodesOf(session), 1)
  assert.equal(range.start, 2)
})

test('selectRange returns undefined when the whole surface must be retained', () => {
  const session = fakeSession([system(1), user(2)])
  assert.equal(selectRange(session, nodesOf(session), 1000), undefined)
})

test('selectRange returns undefined for an empty surface', () => {
  const session = fakeSession([])
  assert.equal(selectRange(session, [], 10), undefined)
})

test('selectRange returns undefined when no balanced cut exists', () => {
  // Both nodes are unbalanced, leaving only the system head outside.
  const session = fakeSession([system(1), assistant(2, 1), user(3)])
  assert.equal(selectRange(session, nodesOf(session), 0), undefined)
})

test('selectRange refuses a measurement from an earlier surface', () => {
  const session = fakeSession([user(1), user(2), user(3)])
  assert.equal(selectRange(session, nodesOf(session).slice(1), 1), undefined)
})

test('balanceCuts refuses an assistant event with missing content', () => {
  const session = fakeSession([user(1), { seq: 2, type: 'assistant/message', data: { message: {} } }])
  assert.equal(balanceCuts(session, nodesOf(session)), undefined)
})
