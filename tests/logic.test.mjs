/**
 * Unit tests for the guard's decision logic.
 *
 * These run against `logic.js`, which imports nothing, so `node --test` needs
 * no dependency installation beyond the Node runtime itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRule, normalizeConfig, ruleFor, balanceCuts, selectRange, retentionBudget, foldFloor,
  estimateToolsTokens, usageTokens, observedRatio, blendRatio, calibratedPressure, attemptPolicy, emergencyGrowth,
  CALIBRATION,
} from '../logic.js'

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

test('normalizeRule keeps a complete summary route and ignores a partial one', () => {
  const rule = { provider: 'p', model: 'm', surchargeAtTokens: 100 }
  assert.deepEqual(
    normalizeRule({ ...rule, summaryTarget: { provider: ' q ', model: ' small ' } }).summaryTarget,
    { provider: 'q', model: 'small' },
  )
  assert.equal(normalizeRule({ ...rule, summaryTarget: null }).summaryTarget, undefined)
  // The rule still guards; only the unusable route falls back to the default.
  assert.equal(normalizeRule({ ...rule, summaryTarget: { model: 'small' } }).model, 'm')
  assert.equal(normalizeRule({ ...rule, summaryTarget: { model: 'small' } }).summaryTarget, undefined)
  assert.equal(normalizeRule({ ...rule, summaryTarget: { provider: 'q' } }).summaryTarget, undefined)
})

test('normalizeRule keeps a summary effort with its route and drops it with the route', () => {
  const rule = { provider: 'p', model: 'm', surchargeAtTokens: 100 }
  const target = { provider: 'q', model: 'small' }
  assert.deepEqual(
    normalizeRule({ ...rule, summaryTarget: { ...target, reasoningEffort: ' low ' } }).summaryTarget,
    { ...target, reasoningEffort: 'low' },
  )
  // A blank effort means the route default, not an empty effort id.
  assert.deepEqual(
    normalizeRule({ ...rule, summaryTarget: { ...target, reasoningEffort: '  ' } }).summaryTarget,
    target,
  )
  // The effort is route-owned: no route means no effort either.
  assert.equal(normalizeRule({ ...rule, summaryTarget: { reasoningEffort: 'low' } }).summaryTarget, undefined)
})

test('normalizeRule repairs or drops an effort an editor could have mangled', () => {
  const rule = { provider: 'p', model: 'm', surchargeAtTokens: 100 }
  const target = { provider: 'q', model: 'small' }
  const effortOf = reasoningEffort => normalizeRule({ ...rule, summaryTarget: { ...target, reasoningEffort } }).summaryTarget
  // Zero-width characters are not `WhiteSpace`, so a plain trim would keep them
  // and produce an id no catalog can match; they are stripped instead.
  assert.deepEqual(effortOf('\u200blow'), { ...target, reasoningEffort: 'low' })
  assert.deepEqual(effortOf('\ufefflow\u200d'), { ...target, reasoningEffort: 'low' })
  // An effort made only of invisible characters is the default, not an id.
  assert.deepEqual(effortOf('\u200b\u200b'), target)
  // An over-long value is dropped rather than truncated into a different id.
  assert.deepEqual(effortOf('x'.repeat(65)), target)
  assert.deepEqual(effortOf('x'.repeat(64)), { ...target, reasoningEffort: 'x'.repeat(64) })
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

// ---- fold-worthiness -------------------------------------------------------

/** A user message that is the replacement checkpoint of a previous fold. */
const checkpoint = seq => ({
  seq,
  type: 'user/message',
  data: { source: { kind: 'compact-checkpoint' } },
})

/** Priced nodes from plain token counts, one per surface position. */
const priced = tokens => tokens.map((count, index) => ({ seq: index + 1, tokens: count }))

test('selectRange refuses a span made only of checkpoints', () => {
  const session = fakeSession([system(1), checkpoint(2), checkpoint(3)])
  assert.equal(selectRange(session, priced([100, 600, 600]), 500), undefined)
})

test('selectRange still folds a checkpoint together with real history', () => {
  const session = fakeSession([system(1), checkpoint(2), user(3), user(4)])
  assert.deepEqual(selectRange(session, priced([100, 600, 600, 600]), 600), { start: 2, end: 3 })
})

test('selectRange refuses a fold that cannot cover its replacement', () => {
  const session = fakeSession([system(1), user(2), user(3)])
  const nodes = priced([100, 600, 600])
  // A 600-token span against a 500-token checkpoint leaves nothing worth doing.
  assert.equal(selectRange(session, nodes, 500, { summaryTokens: 500, minReclaimTokens: 500 }), undefined)
  assert.deepEqual(selectRange(session, nodes, 500, { summaryTokens: 50, minReclaimTokens: 500 }), { start: 2, end: 2 })
})

test('retentionBudget keeps the configured tail until the gap needs more', () => {
  const cap = 100_000
  const retainTokens = 16_000
  const surfaceTokens = 36_000
  // The gap fits under the ceiling: the configured tail is kept.
  assert.equal(retentionBudget({ cap, projected: cap, surfaceTokens, retainTokens }), retainTokens)
  // The recorded pressure exceeds the whole surface, so nothing is protected
  // beyond the floor.
  assert.equal(retentionBudget({ cap, projected: 160_000, surfaceTokens, retainTokens }), 8000)
  // In between, exactly the removable remainder is kept.
  assert.equal(
    retentionBudget({ cap, projected: 120_000, surfaceTokens, retainTokens, summaryTokens: 2000 }),
    14_000,
  )
  // A ceiling below the floor still wins: the configured ratio is a real limit.
  assert.equal(retentionBudget({ cap, projected: cap, surfaceTokens, retainTokens: 4000 }), 4000)
})

test('foldFloor scales with the trigger and never collapses to zero', () => {
  assert.deepEqual(foldFloor(252_000), { summaryTokens: 5040, minReclaimTokens: 2520 })
  assert.deepEqual(foldFloor(4000), { summaryTokens: 1024, minReclaimTokens: 1024 })
  assert.deepEqual(foldFloor(0), { summaryTokens: 1024, minReclaimTokens: 1024 })
})

// ---- provider/heuristic calibration ----------------------------------------

test('estimateToolsTokens prices a tool schema the way the meter does', () => {
  assert.equal(estimateToolsTokens(undefined), 0)
  assert.equal(estimateToolsTokens({}), 0)
  assert.equal(estimateToolsTokens({ tools: [] }), 0)
  const tools = [{ name: 'read', description: 'Read a file.' }]
  const expected = Math.ceil(JSON.stringify(tools).length / 4) + 4
  assert.equal(estimateToolsTokens({ tools }), expected)
  // A value that cannot be serialized must not throw out of the guard.
  const circular = []
  circular.push(circular)
  assert.equal(estimateToolsTokens({ tools: circular }), 0)
})

test('usageTokens sums every provider bucket and refuses an unusable record', () => {
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 5 }), 15)
  assert.equal(usageTokens({ inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 5 }), 20)
  assert.equal(usageTokens({}), 0)
  assert.equal(usageTokens(undefined), undefined)
  assert.equal(usageTokens('usage'), undefined)
})

test('observedRatio compares the provider count with the heuristic of the same envelope', () => {
  const header = { tools: [{ name: 't' }] }
  const tools = estimateToolsTokens(header)
  // surfaceTokens - surfaceDeltaTokens is the heuristic price of the committed
  // history the provider count covers.
  const measurement = {
    totalTokens: 90_000,
    surfaceTokens: 40_000,
    surfaceDeltaTokens: 10_000,
    baseline: { kind: 'usage', usage: { inputTokens: 80_000, outputTokens: 10_000 } },
  }
  assert.equal(observedRatio(measurement, header), 90_000 / (tools + 30_000))
  // An estimate has no provider count behind it to learn from.
  assert.equal(observedRatio({ ...measurement, baseline: { kind: 'estimated', tokens: 90_000 } }, header), undefined)
  // Usage without the surface fields cannot reconstruct the anchor.
  assert.equal(observedRatio({ totalTokens: 1, baseline: measurement.baseline }, header), undefined)
  assert.equal(observedRatio({ ...measurement, baseline: { kind: 'usage', usage: {} } }, header), undefined)
})

test('blendRatio applies an undercount at once and releases one slowly', () => {
  assert.equal(blendRatio(undefined, undefined), 1)
  assert.equal(blendRatio(1, 2.5), 2.5, 'a larger observation applies immediately')
  assert.equal(blendRatio(2, 1), 1.9, 'a smaller one moves only 10% of the way')
  // Neither direction leaves the bounds.
  assert.equal(blendRatio(1, 0.2), 1)
  assert.equal(blendRatio(CALIBRATION.max, 100), CALIBRATION.max)
  assert.equal(blendRatio(2, Number.NaN), 2)
})

test('calibratedPressure scales only the heuristic-priced part', () => {
  const usageBacked = {
    totalTokens: 70_000,
    surfaceTokens: 30_000,
    surfaceDeltaTokens: 5_000,
    baseline: { kind: 'usage', usage: { inputTokens: 65_000, outputTokens: 5_000 } },
  }
  // 65,000 provider tokens plus the scaled delta and admitted messages.
  assert.equal(calibratedPressure(usageBacked, 1_000, 2), 65_000 + 12_000)
  // A wholly heuristic estimate is scaled as a whole.
  const estimated = {
    totalTokens: 70_000,
    surfaceTokens: 70_000,
    surfaceDeltaTokens: 0,
    baseline: { kind: 'estimated', tokens: 70_000 },
  }
  assert.equal(calibratedPressure(estimated, 1_000, 2), 142_000)
  // Without a calibration the behaviour is the old total plus pending.
  assert.equal(calibratedPressure({ totalTokens: 1200 }, 300, 1), 1500)
  // A ratio below one is never applied: the heuristic is the floor.
  assert.equal(calibratedPressure(usageBacked, 1_000, 0.5), 65_000 + 6_000)
})

test('attemptPolicy re-arms only through a fold, and retries above the line on growth', () => {
  const base = { maxAttempts: 1, line: 272_000, emergencyGrowth: 1024 }
  assert.equal(attemptPolicy({ ...base, attempts: 0, projected: 260_000 }), 'attempt')
  // Spent and under the line: no retry, no alarm.
  assert.equal(attemptPolicy({ ...base, attempts: 1, projected: 260_000 }), 'exhausted')
  // Spent at the line with no growth since the last attempt: do not loop.
  assert.equal(attemptPolicy({ ...base, attempts: 1, projected: 272_000, lastAttemptTokens: 272_000 }), 'exhausted')
  // Spent above the line after growth: one more attempt is cheaper than paying.
  assert.equal(attemptPolicy({ ...base, attempts: 1, projected: 300_000, lastAttemptTokens: 272_000 }), 'emergency')
  // No previous attempt on record still counts as growth to protect against.
  assert.equal(attemptPolicy({ ...base, attempts: 1, projected: 272_000 }), 'emergency')
})

test('emergencyGrowth scales with the trigger but keeps a visible floor', () => {
  assert.equal(emergencyGrowth(252_000), 2520)
  assert.equal(emergencyGrowth(900), 1024)
  assert.equal(emergencyGrowth(0), 1024)
})
