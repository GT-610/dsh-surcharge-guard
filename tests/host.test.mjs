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
  // The legacy tests below exercise the soft budget; hard-line tests opt in.
  enforceLine: false,
}
const user = tokens => ({ role: 'user', tokens })
/** Default price of one surface node in the fake meter. */
const NODE_TOKENS = 40000

function fixture({ config = options, total = 900, previous, available = true, shrink = [400], error, root = false,
  backend, isolated, llm, prices = {}, checkpoints = [], measure, pruner } = {}) {
  let hook
  let streamHook
  let pressure = total
  const calls = { estimates: [], measures: [], compacts: [], warnings: [], logs: [], services: [], next: 0,
    isolated: [], provided: [], released: [] }
  const session = {
    id: 'session-test',
    // `replaceGeneration` advances whenever any middleware replaces the
    // surface, which is how the guard tells that this step was already folded.
    surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
    requestHeader: () => previous,
    eventAt: seq => (checkpoints.includes(seq)
      ? { seq, type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } }
      : { seq, type: seq === 0 ? 'system/message' : 'user/message' }),
  }
  const agent = { session }
  const compaction = backend ?? {
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
      if (key === 'toolResultPruner') return pruner
      if (key === 'llm') return llm === undefined ? undefined : traced(llm)
      if (root) return key === 'compaction' ? compaction : undefined
      return key === 'agentPresets' ? { serviceFor(owner, name) {
        calls.services.push({ owner, name })
        if (name === 'toolResultPruner') return pruner
        return name === 'compaction' ? compaction : undefined
      } } : undefined
    },
    isolate(name) {
      assert.equal(name, 'compaction')
      const realm = Symbol(name)
      // The guard isolates `llm` again inside the compaction realm when a rule
      // names a summary effort, so a scope knows how to make an inner one.
      // A provisioned value is what the backend actually resolves, exactly as
      // the real reflect store would hand it back.
      const scope = (own, provided) => ({
        isolate(inner) {
          assert.equal(inner, 'llm')
          return scope(Symbol(`${String(own)}/llm`), provided)
        },
        provide(name, value) {
          assert.equal(name, 'llm')
          calls.provided.push({ realm: own, value })
          // Provision before the backend, as the guard does; a later provide
          // must not be visible to a fiber that already started.
          if (provided.started) calls.lateProvides = [...(calls.lateProvides ?? []), own]
          provided.value = value
          return () => { calls.released.push(own) }
        },
        plugin(Engine, settings) {
          calls.isolated.push({ Engine, settings, realm: own })
          provided.started = true
          // What the backend fiber resolves through `ctx.get`: its own engine,
          // and whatever this realm provisioned for `llm`.
          const resolve = name => {
            if (name === 'llm') return provided.value === undefined ? undefined : traced(provided.value)
            return undefined
          }
          const engine = isolated?.(settings, own, resolve) ?? {
            compactRegion(start, end, owner, signal) {
              calls.compacts.push({ start, end, owner, signal, realm: own })
              if (error) throw error
              pressure = shrink[calls.compacts.length - 1] ?? pressure
              return { shadowedSeqs: [start] }
            },
          }
          const fiber = Promise.resolve({ ctx: { get: name => name === 'compaction' ? engine : resolve(name) } })
          fiber.dispose = async () => { calls.disposed = [...(calls.disposed ?? []), own] }
          return fiber
        },
      })
      return scope(realm, { value: undefined, started: false })
    },
    on(name, handler, opts) {
      if (name === 'session/disposed') {
        assert.equal(opts, undefined)
        return
      }
      if (name === 'agent/pre-step') {
        assert.deepEqual(opts, { prepend: true })
        assert.equal(hook, undefined)
        hook = handler
        return
      }
      assert.equal(name, 'llm/stream')
      assert.deepEqual(opts, { global: true, prepend: true })
      assert.equal(streamHook, undefined)
      streamHook = handler
    },
    tokenMeter: {
      estimateMessage(msg) { calls.estimates.push(msg); return msg.tokens },
      measure(owner, header) {
        calls.measures.push({ owner, header })
        // Node prices match a real long transcript: a fold floor of a couple
        // thousand tokens only makes sense against history this size.
        const nodes = owner.surface.nodes.map(seq => ({ seq, tokens: prices[seq] ?? NODE_TOKENS }))
        // Tests that exercise provider-usage calibration supply a full
        // measurement; the rest keep the plain pressure-only shape.
        return measure === undefined ? { totalTokens: pressure, nodes } : measure({ pressure, nodes })
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
  /** Fire the dispatch gate as if the llm service were about to stream. */
  function dispatch(options) {
    let dispatched = false
    const result = streamHook(options, () => {
      dispatched = true
      return 'stream'
    })
    return { result, dispatched }
  }
  return { step, session, agent, calls, dispatch, setPressure: value => { pressure = value } }
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

test('folds once per step and reports a residual gap instead of chasing it', async () => {
  // A second summary in the same step can only rewrite the checkpoint the
  // first one wrote, so the guard stops after one transaction and measures the
  // result: the step is admitted either way.
  const { step, calls } = fixture({ total: 1800, shrink: [1400] })
  await step({ claimed: [user(10)] })
  assert.equal(calls.compacts.length, 1)
  assert.equal(calls.measures.length, 2, 'measured once before and once after the fold')
  assert.match(calls.warnings[0], /at or above the surcharge line.*1410.*surcharge line 1000/)
})

test('a no-progress fold is not retried in the same step', async () => {
  const { step, calls } = fixture({ total: 1200, shrink: [1200] })
  await step()
  assert.equal(calls.compacts.length, 1)
  assert.match(calls.warnings[0], /did not lower/)
})

test('does not fold a step another middleware already compacted', async () => {
  const probe = fixture({ total: 1800 })
  await probe.step({
    // Native pressure compaction runs inside `next()` and replaces the
    // surface; the guard must not add a second fold on top of it.
    beforeDecision: setPressure => {
      setPressure(1800)
      probe.session.surface.replaceGeneration += 1
    },
  })
  assert.equal(probe.calls.compacts.length, 0)
  assert.equal(probe.calls.measures.length, 0)
  assert.match(probe.calls.logs.join('\n'), /already folded history elsewhere/)
})

test('folds deeper than the retention ratio when the recorded gap exceeds the surface', async () => {
  // Capped at 100,000 with a 16% tail ceiling of 16,000 over four 7,000-token
  // nodes plus a 2,000-token system head.
  const config = { ...options, rules: [{ ...route, surchargeAtTokens: 100100 }], safetyMarginTokens: 100, retainRatio: 0.16 }
  const prices = { 0: 2000, 1: 7000, 2: 7000, 3: 7000, 4: 7000 }
  const shallow = fixture({ config, prices, total: 101000 })
  shallow.session.surface.nodes = [0, 1, 2, 3, 4]
  await shallow.step()
  // The gap fits under the ceiling, so only the tail-crossing node is folded.
  assert.deepEqual(shallow.calls.compacts.map(call => [call.start, call.end]), [[1, 1]])

  const deep = fixture({ config, prices, total: 160000 })
  deep.session.surface.nodes = [0, 1, 2, 3, 4]
  await deep.step()
  // The recorded pressure is far above the surface price, so the tail is cut
  // down to its floor and the fold reaches two more nodes.
  assert.deepEqual(deep.calls.compacts.map(call => [call.start, call.end]), [[1, 2]])
})

test('refuses to fold the checkpoint a previous fold wrote', async () => {
  const probe = fixture({
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1100 }], safetyMarginTokens: 100, retainRatio: 0.15 },
    total: 1000,
    prices: { 0: 2000, 1: 30000, 2: 50000 },
    checkpoints: [1],
  })
  await probe.step()
  assert.equal(probe.calls.compacts.length, 0, 'a summary of a summary is not worth a model call')
  assert.match(probe.calls.warnings[0], /no safe history range worth folding/)
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

test('a fold that lowers the pressure re-arms the attempt budget within the turn', async () => {
  // One attempt between folds is still the limit; the fold itself restores it,
  // so a long turn that keeps growing back over the trigger stays protected.
  const probe = fixture({ config: { ...options, maxAttempts: 1 }, total: 1200, shrink: [400, 400] })
  await probe.step()
  assert.equal(probe.calls.compacts.length, 1)
  await probe.step({ beforeDecision: setPressure => setPressure(1200) })
  assert.equal(probe.calls.compacts.length, 2)
  assert.deepEqual(probe.calls.warnings, [])
})

test('a spent budget still retries above the line once the pressure has grown', async () => {
  const probe = fixture({ config: { ...options, maxAttempts: 1 }, total: 1200, error: Error('offline summary failure') })
  await probe.step()
  // Unchanged pressure is not worth another doomed summary.
  await probe.step()
  assert.equal(probe.calls.compacts.length, 1)
  // A larger request is a different, more expensive one: skipping it pays the
  // surcharge, so the emergency path spends one more attempt.
  await probe.step({ beforeDecision: setPressure => setPressure(2500) })
  assert.equal(probe.calls.compacts.length, 2)
  assert.match(probe.calls.logs.join('\n'), /above the surcharge line after an unhelpful summary/)
})

test('prices admitted messages at the ratio observed between usage and the heuristic', async () => {
  // Trigger 100,000 minus a 20,000 margin is 80,000. The provider counted
  // 70,000 for a surface the 4-chars heuristic prices at 30,000, so 5,000
  // admitted heuristic tokens are really about 11,700: 81,667, over the cap.
  const config = { ...options, rules: [{ ...route, surchargeAtTokens: 100000 }], safetyMarginTokens: 20000, retainRatio: 0.15 }
  const prices = { 0: 2000, 1: 14000, 2: 14000 }
  const measured = ({ pressure, nodes }) => ({
    totalTokens: pressure,
    surfaceTokens: 30000,
    surfaceDeltaTokens: 0,
    baseline: { kind: 'usage', usage: { inputTokens: pressure, outputTokens: 0 } },
    nodes,
  })
  const provider = fixture({ config, prices, total: 70000, shrink: [40000], measure: ({ pressure, nodes }) => measured({ pressure, nodes }) })
  await provider.step({ claimed: [user(5000)] })
  assert.equal(provider.calls.compacts.length, 1, 'the calibrated estimate crosses the cap')

  // Without a provider count behind the measurement there is no ratio to learn
  // from, and the plain heuristic stays in force: 75,000 is under the cap.
  const estimated = fixture({
    config, prices, total: 70000,
    measure: ({ pressure, nodes }) => ({
      totalTokens: pressure,
      surfaceTokens: 30000,
      surfaceDeltaTokens: 0,
      baseline: { kind: 'estimated', tokens: pressure },
      nodes,
    }),
  })
  await estimated.step({ claimed: [user(5000)] })
  assert.equal(estimated.calls.compacts.length, 0)
})

test('a failed summary that spent the budget reports it once per turn', async () => {
  const probe = fixture({ config: { ...options, maxAttempts: 1 }, total: 1200, error: Error('offline summary failure') })
  await probe.step()
  await probe.step()
  await probe.step()
  // The failure is reported once, the exhausted budget once, and the third
  // step repeats neither.
  assert.equal(probe.calls.warnings.filter(text => /budget exhausted/.test(text)).length, 1)
  assert.equal(probe.calls.warnings.filter(text => /offline summary failure/.test(text)).length, 1)
  assert.equal(probe.calls.compacts.length, 1)
})

test('the hard line prunes tool results before it spends a forced fold', async () => {
  let setPressure
  const pruner = {
    calls: 0,
    pruneSession() {
      this.calls += 1
      setPressure(900)
      return { pruned: [1], charsRemoved: 4000 }
    },
  }
  const probe = fixture({
    config: { ...options, enforceLine: true, maxAttempts: 1 },
    total: 1200,
    error: Error('summary backend down'),
    pruner,
  })
  setPressure = probe.setPressure
  await probe.step()
  // The soft attempt failed, but pruning alone brought the step back under the
  // line, so no second summary was spent and nothing was blocked.
  assert.equal(probe.calls.compacts.length, 1)
  assert.equal(pruner.calls, 1)
  assert.match(probe.calls.logs.join('\n'), /pruned 1 tool results \(4000 chars\)/)
  assert.doesNotMatch(probe.calls.logs.join('\n'), /emergency fold/)
})

test('the hard line forces one depth-zero fold when a normal fold is not enough', async () => {
  // The soft fold lands at 1,400, still above the 1,000-token line; the forced
  // fold (retain 0) reaches 400 and the step continues.
  const probe = fixture({
    config: { ...options, enforceLine: true, maxAttempts: 1 },
    total: 1800,
    shrink: [1400, 400],
  })
  await probe.step()
  assert.equal(probe.calls.compacts.length, 2)
  assert.match(probe.calls.logs.join('\n'), /emergency fold for the line/)
})

test('the hard line blocks a step that neither pruning nor a fold can lower', async () => {
  const probe = fixture({ config: { ...options, enforceLine: true, maxAttempts: 1 }, total: 1200, shrink: [1200] })
  await assert.rejects(
    probe.step(),
    error => error.name === 'SurchargeLineError' && /blocked instead of sent/.test(error.message),
  )
  // One soft attempt, one forced attempt, then a refusal to dispatch.
  assert.equal(probe.calls.compacts.length, 2)
})

test('the dispatch boundary blocks an over-line request and exempts summaries', async () => {
  // Learn a 2.2x ratio from one provider-backed measurement, then price the
  // exact outgoing request: 50,000 heuristic tokens are ~111,500 provider
  // tokens, above the 100,000-token line.
  const prices = { 0: 2000, 1: 14000, 2: 14000 }
  const probe = fixture({
    config: {
      ...options,
      enforceLine: true,
      rules: [{ ...route, surchargeAtTokens: 100000 }],
      safetyMarginTokens: 20000,
    },
    prices,
    total: 70000,
    shrink: [40000],
    measure: ({ pressure, nodes }) => ({
      totalTokens: pressure,
      surfaceTokens: 30000,
      surfaceDeltaTokens: 0,
      baseline: { kind: 'usage', usage: { inputTokens: pressure, outputTokens: 0 } },
      nodes,
    }),
  })
  await probe.step({ claimed: [user(5000)] })
  const request = messages => ({
    provider: route.provider, model: route.model, sessionId: 'session-test', messages,
  })
  assert.throws(
    () => probe.dispatch(request([user(50_000)])),
    error => error.name === 'SurchargeLineError' && /blocked before dispatch/.test(error.message),
  )
  assert.equal(probe.dispatch(request([user(40_000)])).dispatched, true)
  // The guard's own compaction call is the recovery mechanism, never a target.
  assert.equal(probe.dispatch({ ...request([user(500_000)]), purpose: 'compaction' }).dispatched, true)
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

test('a refusal warns once per turn instead of on every step', async () => {
  // Refusals deliberately do not spend the attempt budget, so a persistent
  // phantom pressure would otherwise log the same line for every step.
  const probe = fixture({ config: { ...options, maxAttempts: 1 } })
  probe.session.surface.nodes = [0, 1]
  await probe.step()
  await probe.step()
  assert.equal(probe.calls.warnings.length, 1)
  assert.match(probe.calls.warnings[0], /no safe history range worth folding/)
  // A new turn re-checks and reports again.
  await probe.step({ turn: 2 })
  assert.equal(probe.calls.warnings.length, 2)
  assert.equal(probe.calls.compacts.length, 0, 'a refusal never spends the attempt budget')
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
    assert.deepEqual(config, {
      enabled: true, retainRatio, maxAttempts: 0, safetyMarginTokens: 0, rules: [], enforceLine: true,
    })
  }
  const defaults = normalizeConfig(Config({}))
  assert.deepEqual(defaults, {
    enabled: true, rules: [], retainRatio: 0.16, maxAttempts: 2, safetyMarginTokens: 20000, enforceLine: true,
  })
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

// ---- per-rule summary model ------------------------------------------------

const summaryTarget = { provider: 'cheap', model: 'luna' }

/** A backend shaped like the shipped Basic engine, as the guard inspects it. */
function basicBackend(calls) {
  const engine = {
    config: {
      maxTokens: 8000,
      summarizationProvider: '',
      summarizationModel: '',
      modelPolicies: [{ provider: 'p', model: 'guarded', maxTokens: 4000 }],
    },
    compactRegion(start, end, owner, signal) {
      calls.compacts.push({ start, end, owner, signal, route: 'session' })
      return { shadowedSeqs: [start] }
    },
  }
  class BasicCompactionEngine {}
  BasicCompactionEngine.prototype.compactRegion = engine.compactRegion
  return { backend: Object.assign(engine, { constructor: BasicCompactionEngine }), Engine: BasicCompactionEngine }
}

test('a rule without a summary route keeps using the session backend', async () => {
  const { step, calls } = fixture()
  await step()
  assert.deepEqual(calls.isolated, [])
  assert.equal(calls.compacts.length, 1)
})

test('a routed rule compacts through its own isolated Basic backend', async () => {
  const calls = { compacts: [] }
  const { backend, Engine } = basicBackend(calls)
  const probe = fixture({
    backend,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget }] },
    isolated: () => ({
      compactRegion(start, end, owner, signal) {
        calls.compacts.push({ start, end, owner, signal, route: 'isolated' })
        return { shadowedSeqs: [start] }
      },
    }),
  })
  await probe.step()
  assert.equal(calls.compacts.length, 1)
  assert.equal(calls.compacts[0].route, 'isolated')
  assert.equal(probe.calls.compacts.length, 0, 'the session backend was not used')
  assert.deepEqual(probe.calls.isolated.map(entry => entry.Engine), [Engine])
  // The route and the inherited summary budget ride on the isolated instance.
  assert.deepEqual(probe.calls.isolated[0].settings, {
    auto: false, summarizationProvider: summaryTarget.provider, summarizationModel: summaryTarget.model, maxTokens: 4000,
  })
  assert.equal(probe.calls.disposed.length, 1, 'the temporary backend is always disposed')
})

test('one transaction per step opens and disposes exactly one realm', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const probe = fixture({
    backend,
    total: 1800,
    shrink: [1400],
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget }] },
  })
  await probe.step()
  assert.equal(probe.calls.isolated.length, 1)
  assert.equal(probe.calls.disposed.length, 1, 'the transaction owned one realm')
  assert.equal(probe.calls.compacts.length, 1, 'the isolated backend summarized once')
  assert.equal(calls.compacts.length, 0, 'the session backend was untouched')
})

test('a failed routed summary warns, disposes, and does not fall back', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const probe = fixture({
    backend,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget }] },
    isolated: () => ({ compactRegion: () => { throw new Error('model unavailable') } }),
  })
  await probe.step()
  assert.equal(calls.compacts.length, 0, 'no fallback to the session backend')
  assert.equal(probe.calls.disposed.length, 1)
  assert.match(probe.calls.warnings[0], /summary via cheap\/luna failed: model unavailable/)
})

test('a backend that is not Basic-like is reported instead of being replaced', async () => {
  const probe = fixture({
    backend: { config: {}, compactRegion: () => ({ shadowedSeqs: [1] }) },
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget }] },
  })
  await probe.step()
  assert.deepEqual(probe.calls.isolated, [])
  assert.match(probe.calls.warnings[0], /needs a Basic-style compaction backend/)
})

// ---- per-rule summary reasoning effort --------------------------------------

const TRACKER = Symbol.for('cordis.tracker')

/**
 * Mimic the framework's service hand-out.
 *
 * Real Cordis wraps every service read in a traceable proxy, and that proxy's
 * `get` trap resolves functions from the *prototype descriptor*, so an override
 * living only on the value's own `get` trap would be bypassed. A service with no
 * tracker symbol is handed out untouched. Modelling this is what makes the
 * tracker-hiding in `withSummaryEffort` testable outside a real DSH install.
 */
function traced(value) {
  if (value === null || typeof value !== 'object') return value
  if (value[TRACKER] === undefined) return value
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === TRACKER) return target[TRACKER]
      const descriptor = (() => {
        for (let node = target; node; node = Object.getPrototypeOf(node)) {
          const own = Reflect.getOwnPropertyDescriptor(node, property)
          if (own) return own
        }
        return undefined
      })()
      if (descriptor && 'value' in descriptor) return descriptor.value
      return Reflect.get(target, property, receiver)
    },
  })
}

/** An `llm` service that records every validation and every streamed request. */
function fakeLlm({ unsupported } = {}) {
  const calls = { resolutions: [], streams: [] }
  const service = {
    calls,
    resolveCallConfig(config) {
      calls.resolutions.push(config)
      if (unsupported !== undefined && config.reasoningEffort === unsupported) {
        return Promise.reject(new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${unsupported}"`))
      }
      return Promise.resolve(config)
    },
    stream(options) {
      calls.streams.push(options)
      return (async function* () {})()
    },
    modelCatalog() { throw new Error('the effort path must not read the catalog') },
  }
  // A real service carries a tracker, so every read is re-wrapped. The real
  // one is writable and non-configurable (defined by the Service constructor),
  // which is what lets a proxy answer `undefined` for it.
  Object.defineProperty(service, TRACKER, { value: { property: 'ctx' }, writable: true, enumerable: false })
  return service
}

const routed = (reasoningEffort) => ({ ...summaryTarget, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

test('a routed rule without an effort leaves the summary route alone', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const llm = fakeLlm()
  const probe = fixture({
    backend,
    llm,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed() }] },
  })
  await probe.step()
  assert.deepEqual(llm.calls.resolutions, [])
  assert.deepEqual(probe.calls.provided, [], 'no llm realm is opened without an effort')
  assert.equal(probe.calls.isolated.length, 1)
  assert.equal(probe.calls.compacts.length, 1, 'the isolated backend still summarizes')
  assert.equal(calls.compacts.length, 0, 'the session backend is untouched')
})

test('a routed rule with an effort validates it and binds it to this transaction only', async () => {
  const calls = { compacts: [] }
  const { backend, Engine } = basicBackend(calls)
  const llm = fakeLlm()
  const probe = fixture({
    backend,
    llm,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('low') }] },
  })
  await probe.step()
  // The effort is resolved against the exact summary route before any work.
  assert.deepEqual(llm.calls.resolutions, [{ ...summaryTarget, reasoningEffort: 'low' }])
  // The engine starts in the compaction realm, and its `llm` is a bound view.
  assert.deepEqual(probe.calls.isolated.map(entry => entry.Engine), [Engine])
  assert.equal(probe.calls.provided.length, 1)
  const bound = probe.calls.provided[0].value
  assert.notEqual(bound, llm, 'the shared llm service is never replaced')
  // A service view is re-wrapped per reader unless it reports no tracker, so
  // the bound view must hide it or the effort override would be lost.
  assert.equal(bound[TRACKER], undefined)
  // Only `stream` is overridden; every other member still reaches the service.
  assert.throws(() => bound.modelCatalog(), /must not read the catalog/)
  await bound.stream({ provider: summaryTarget.provider, model: summaryTarget.model }).next()
  assert.deepEqual(llm.calls.streams, [{
    provider: summaryTarget.provider, model: summaryTarget.model, reasoningEffort: 'low',
  }])
  // The isolated realm and its binding are always released.
  assert.equal(probe.calls.disposed.length, 1)
  assert.deepEqual(probe.calls.released, probe.calls.provided.map(entry => entry.realm))
})

test('the bound view is what the backend resolves, so the effort reaches its call', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const llm = fakeLlm()
  const seen = []
  const probe = fixture({
    backend,
    llm,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('low') }] },
    // Resolve `llm` the way the real summarizer does: through the realm's
    // context, after the backend started.
    isolated: (settings, realm, resolve) => ({
      async compactRegion(start, end) {
        calls.compacts.push({ start, end })
        const service = resolve('llm')
        assert.notEqual(service, undefined, 'the realm must expose the provisioned view')
        await service.stream({ provider: summaryTarget.provider, model: summaryTarget.model }).next()
        seen.push(service[TRACKER])
        return { shadowedSeqs: [start] }
      },
    }),
  })
  await probe.step()
  assert.equal(calls.compacts.length, 1)
  // The call carried the effort, through the framework's re-wrapping proxy.
  assert.deepEqual(llm.calls.streams, [{
    provider: summaryTarget.provider, model: summaryTarget.model, reasoningEffort: 'low',
  }])
  // Hiding the tracker is what survives the re-wrap; a tracked view would be
  // resolved from the prototype and lose the override.
  assert.deepEqual(seen, [undefined])
  // The provision preceded the backend, so the engine could resolve it at all.
  assert.equal(probe.calls.lateProvides, undefined)
})

test('a rejected effort warns, compacts nothing, and spends no attempt', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const llm = fakeLlm({ unsupported: 'low' })
  const probe = fixture({
    backend,
    llm,
    total: 1500,
    // One attempt for the whole turn: if the rejected level spent it, the
    // second step would report an exhausted budget instead of the level.
    config: { ...options, maxAttempts: 1, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('low') }] },
  })
  // One turn, two steps: a mis-set level must not disable the next step.
  await probe.step({ turn: 5 })
  await probe.step({ turn: 5 })
  assert.deepEqual(probe.calls.isolated, [], 'no transaction is opened for a rejected effort')
  assert.deepEqual(probe.calls.provided, [])
  assert.equal(calls.compacts.length, 0)
  assert.equal(probe.calls.compacts.length, 0)
  // Both steps report the level, and neither is told the budget ran out.
  assert.equal(probe.calls.warnings.length, 2)
  for (const warning of probe.calls.warnings) {
    assert.match(warning, /cannot use reasoning effort "low"/)
    assert.doesNotMatch(warning, /budget exhausted/)
  }
})

test('an effort without the llm service is reported rather than silently dropped', async () => {
  const calls = { compacts: [] }
  const { backend } = basicBackend(calls)
  const probe = fixture({
    backend,
    config: { ...options, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('low') }] },
  })
  await probe.step()
  assert.deepEqual(probe.calls.isolated, [])
  assert.equal(calls.compacts.length, 0)
  assert.match(probe.calls.warnings[0], /needs the llm service/)
})

test('the schema declares the effort and leaves it absent by default', () => {
  // Volatile fields are live references, so the run shape comes from normalizeConfig.
  const withEffort = normalizeConfig(Config({
    rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('high') }],
  }))
  assert.equal(withEffort.rules[0].summaryTarget.reasoningEffort, 'high')
  const without = normalizeConfig(Config({ rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed() }] }))
  assert.equal(without.rules[0].summaryTarget.reasoningEffort, undefined)
  // Declared, not merely tolerated: schemastery passes unknown keys through,
  // so only a type check proves the field is part of the contract. Length and
  // whitespace are the normalizer's job, so the schema stays out of them.
  assert.throws(() => Config({ rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed(42) }] }), /reasoningEffort/)
})

test('a truncated summary warns, keeps the history, and is not mistaken for a bad level', async () => {
  // Basic counts provider reasoning tokens against `maxTokens` and fails closed
  // on a `max-tokens` finish, so a high effort under a small cap truncates.
  // That is a summary failure, not an unsupported level: the documented shape
  // is a warning, an uncompacted step, and a spent attempt.
  //
  // The fixture records a compact call only in its *default* engine, and this
  // test supplies its own `compactRegion`, so that log is constant here and
  // asserting on it would pass no matter what happened. The session surface is
  // the real evidence, because Basic replaces that span in the log. Verified by
  // making the stub append a node before throwing: this test then fails.
  const backend = basicBackend({ compacts: [] }).backend
  const llm = fakeLlm()
  const probe = fixture({
    backend,
    llm,
    total: 1500,
    config: { ...options, maxAttempts: 1, rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: routed('max') }] },
    isolated: () => ({
      compactRegion: () => {
        throw new Error('summarization truncated at the token cap (incomplete checkpoint)')
      },
    }),
  })
  const surface = [...probe.session.surface.nodes]
  await probe.step({ turn: 3 })
  // The level itself was supported, so the pre-flight passed and a transaction
  // did open; the failure came from the summary request.
  assert.deepEqual(llm.calls.resolutions, [{ ...summaryTarget, reasoningEffort: 'max' }])
  assert.equal(probe.calls.isolated.length, 1)
  assert.equal(probe.calls.disposed.length, 1, 'the temporary backend is still disposed')
  // The warning names truncation, not the level.
  assert.match(probe.calls.warnings[0], /truncated at the token cap/)
  assert.doesNotMatch(probe.calls.warnings[0], /cannot use reasoning effort/)
  // The failed summary left the history exactly as it was.
  assert.deepEqual(probe.session.surface.nodes, surface)
  // The attempt was spent: the next step reports an exhausted budget instead of
  // retrying a summary that would truncate again. This second surface check
  // guards the second step, which the first one never reaches.
  await probe.step({ turn: 3 })
  assert.match(probe.calls.warnings[1], /budget exhausted/)
  assert.deepEqual(probe.session.surface.nodes, surface)
})
