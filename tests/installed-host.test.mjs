import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as guard from '../index.js'

const install = process.env.DSH_INSTALL_DIR
const useInstalled = Boolean(install) && (process.versions.electron !== undefined || !install.includes('.asar'))

/**
 * One real `agent/pre-step` waterfall over the installed packages.
 *
 * The summarizer is a subclass of the shipped backend, so the isolated
 * instance the guard mounts is exercised for real: it must start inside its
 * own realm, receive the configured route, and record it in `compaction/summary`.
 * Nothing here contacts a provider.
 *
 * With `stubSummarizer` the subclass is dropped entirely, so the shipped
 * `summarize()` runs and the recorded `llm.stream` options are the real
 * auxiliary request the guard produced.
 */
async function run({ maxAttempts = 1, stubSummarizer = true, anchor } = {}) {
  const require = createRequire(`${install}/package.json`)
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)))
  const { Context, Service } = await load('cordis')
  const { Session, SessionId } = await load('dsh-session')
  const { agentEvents } = await load('dsh-agent')
  const { createAssistantMessage, createUserMessage } = await load('dsh-llm')
  const { BasicCompactionEngine } = await load('dsh-compaction-basic')
  const { TokenMeter } = await load('dsh-token-meter')
  const ctx = new Context()
  const id = `surcharge-guard-offline-${maxAttempts}-${Math.random().toString(16).slice(2, 8)}`
  const session = Session.create(SessionId(id))
  const route = { provider: 'offline', model: 'guarded' }
  const agent = { id: session.id, ctx, session, options: route }
  const signal = new AbortController().signal
  const summaries = []
  const streams = []
  const resolutions = []
  class OfflineCompaction extends BasicCompactionEngine {
    /** Record the route this instance was configured with, not the session's. */
    async summarize() {
      summaries.push({ provider: this.config.summarizationProvider, model: this.config.summarizationModel })
      const target = this.config.summarizationProvider
        ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
        : route
      return { ...target, summary: [{ type: 'text', text: 'short checkpoint' }] }
    }
  }
  /** A model-free stream that still satisfies the shipped summarizer. */
  async function* reply(options) {
    streams.push(options)
    yield { type: 'text-delta', index: 0, text: 'offline checkpoint text' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  /**
   * A real service, not a plain object: the framework wraps every service read
   * in a traceable proxy, which is exactly the wrapping an effort override has
   * to survive to reach the summarizer.
   */
  class OfflineLlm extends Service {
    constructor(owner) { super(owner, 'llm') }
    imageRequestPricing() {}
    async resolveCallConfig(config) {
      resolutions.push(config)
      if (config.reasoningEffort === 'unsupported') {
        throw new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "unsupported"`)
      }
      return config
    }
    stream(options) { return reply(options) }
  }
  const llm = new OfflineLlm(ctx)
  assert.equal(typeof llm.stream, 'function', 'the effort override rides on a real service')
  ctx.provide('sessions', {})
  const meter = new TokenMeter(ctx)
  const Engine = stubSummarizer ? OfflineCompaction : BasicCompactionEngine
  const engine = new Engine(ctx.isolate('compaction'), { auto: false })
  assert.equal(ctx.get('compaction'), undefined)
  ctx.provide('agentPresets', { serviceFor: (owner, key) => owner === agent && key === 'compaction' ? engine : undefined })
  const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('turn/start', { turn: 1 })
  // Visible history, deliberately without a first `request/header`.
  session.append('user/message', user('history content '.repeat(2500)), { surfaceOp: 'append' })
  session.append('user/message', user('keep recent '.repeat(100)), { surfaceOp: 'append' })
  if (anchor !== undefined) {
    // One committed provider call: a request header, its usage, and the
    // assistant reply it produced. This is what makes `measure()` reuse a
    // provider count instead of repricing the whole history heuristically.
    for (const text of anchor.history ?? []) session.append('user/message', user(text), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: route, ...(anchor.tools === undefined ? {} : { tools: anchor.tools }) },
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'anchor reply' }],
        source: { provider: route.provider, model: route.model },
      }),
      ...(anchor.usage === undefined ? {} : { usage: anchor.usage }),
      stream: [{ type: 'text-chunks', index: 0, texts: ['anchor reply'] }],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
  }
  return { ctx, session, route, agent, signal, summaries, streams, resolutions, meter, user, engine, agentEvents }
}

test('installed DSH: real waterfall, token meter and summary transaction', { skip: !useInstalled }, async () => {
  const { ctx, session, route, agent, signal, summaries, meter, user, agentEvents } = await run()
  const before = meter.measure(session, { config: route }).totalTokens
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 1000 }], safetyMarginTokens: 100, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [user('new step input')]
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    assert.deepEqual(decision, { kind: 'enter', messages: admitted })
    assert.equal(summaries.length, 1)
    const after = meter.measure(session, { config: route }).totalTokens
    assert.ok(before >= 1000 && after < 900, `expected history to shrink below trigger; ${before} → ${after}`)
    assert.deepEqual(session.snapshotEvents().slice(-4).map(event => event.type), [
      'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
    ])
    // No override: the session's own backend summarized, on the session route.
    assert.deepEqual(summaries[0], { provider: '', model: '' })
    const summaryEvent = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.deepEqual([summaryEvent.data.provider, summaryEvent.data.model], [route.provider, route.model])
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: a per-rule route starts a separate backend and is recorded', { skip: !useInstalled }, async () => {
  const { ctx, session, route, agent, signal, summaries, meter, user, agentEvents } = await run()
  const target = { provider: 'offline-summary', model: 'cheap' }
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: target }], safetyMarginTokens: 100, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [user('new step input')]
    await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    // Exactly one summary came from an instance configured with the chosen route.
    assert.deepEqual(summaries, [target])
    const summaryEvent = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.deepEqual([summaryEvent.data.provider, summaryEvent.data.model], [target.provider, target.model])
    // The session still measures against its own route, and its backend is intact.
    assert.ok(meter.measure(session, { config: route }).totalTokens < 900)
    assert.equal(ctx.get('compaction'), undefined, 'no root service was left behind')
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: a per-rule effort reaches the real auxiliary request only', { skip: !useInstalled }, async () => {
  const { ctx, session, route, agent, signal, streams, resolutions, meter, user, agentEvents } = await run({ stubSummarizer: false })
  const target = { provider: 'offline-summary', model: 'cheap', reasoningEffort: 'low' }
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: target }], safetyMarginTokens: 100, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [user('new step input')]
    await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    // The effort was validated against the summary route before any work.
    assert.deepEqual(resolutions, [{ provider: target.provider, model: target.model, reasoningEffort: 'low' }])
    // The shipped summarizer really dispatched one call, carrying the effort —
    // through the framework's own service proxy, not the raw instance.
    assert.equal(streams.length, 1)
    assert.deepEqual([streams[0].provider, streams[0].model, streams[0].reasoningEffort],
      [target.provider, target.model, 'low'])
    assert.equal(streams[0].purpose, 'compaction')
    const summaryEvent = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.deepEqual([summaryEvent.data.provider, summaryEvent.data.model], [target.provider, target.model])
    // The realm was released: a call through the shared service now records
    // no effort at all, and nothing outside the transaction saw an override.
    await ctx.get('llm').stream({ provider: target.provider, model: target.model }).next()
    assert.equal(streams.length, 2)
    assert.equal(streams[1].reasoningEffort, undefined, 'the shared llm service was never replaced')
    assert.ok(meter.measure(session, { config: route }).totalTokens < 900)
    assert.equal(ctx.get('compaction'), undefined, 'no root service was left behind')
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: an unsupported effort skips the transaction and leaves no marker', { skip: !useInstalled }, async () => {
  const { ctx, session, route, agent, signal, streams, resolutions, meter, user, agentEvents } = await run({ stubSummarizer: false })
  const target = { provider: 'offline-summary', model: 'cheap', reasoningEffort: 'unsupported' }
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 1000, summaryTarget: target }], safetyMarginTokens: 100, maxAttempts: 1,
    // This test is about the effort pre-flight, not the hard line.
    enforceLine: false,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [user('new step input')]
    const before = meter.measure(session, { config: route }).totalTokens
    const step = () => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    const decision = await step()
    // The step is admitted unchanged, with no summary call and no marker pair.
    assert.deepEqual(decision, { kind: 'enter', messages: admitted })
    assert.equal(streams.length, 0)
    assert.equal(meter.measure(session, { config: route }).totalTokens, before)
    assert.equal(session.snapshotEvents().some(event => event.type === 'compaction/start'), false)
    // The rejected level never reached a transaction, and the turn's only
    // attempt was not spent on it: a later step still tries again rather than
    // reporting an exhausted budget.
    assert.deepEqual(resolutions, [{ provider: target.provider, model: target.model, reasoningEffort: 'unsupported' }])
    await step()
    assert.deepEqual(resolutions, [
      { provider: target.provider, model: target.model, reasoningEffort: 'unsupported' },
      { provider: target.provider, model: target.model, reasoningEffort: 'unsupported' },
    ])
    assert.equal(streams.length, 0)
    assert.equal(session.snapshotEvents().some(event => event.type === 'compaction/start'), false)
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: prices new content at the observed provider/heuristic ratio', { skip: !useInstalled }, async () => {
  // Three long user messages after the committed call price at roughly 30K
  // heuristic tokens; the provider counted 70,100 for the whole request, so
  // this route's expansion factor is about 1.7.
  const history = Array.from({ length: 3 }, () => 'history content '.repeat(2500))
  const usage = { inputTokens: 70_000, outputTokens: 100, totalTokens: 70_100 }
  const calibrated = await run({ anchor: { history, usage } })
  const measurement = calibrated.meter.measure(calibrated.session, { config: calibrated.route })
  assert.equal(measurement.baseline.kind, 'usage', 'the session must expose a provider count')
  const heuristic = measurement.surfaceTokens - measurement.surfaceDeltaTokens
  const ratio = 70_100 / heuristic
  assert.ok(ratio > 1.5 && ratio < 2, `expected a real expansion factor, got ${ratio}`)

  const fiber = calibrated.ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...calibrated.route, surchargeAtTokens: 100_000 }], safetyMarginTokens: 20_000, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [calibrated.user('admitted history '.repeat(2000))]
    await calibrated.agentEvents(calibrated.ctx, calibrated.agent).waterfall('agent/pre-step', {
      turn: 1, step: 2, signal: calibrated.signal, modelSelection: calibrated.route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    assert.equal(calibrated.summaries.length, 1, 'the calibrated estimate crossed the 80K cap')
  } finally {
    await fiber.dispose()
  }

  // The same history without a provider count stays entirely heuristic: the
  // 30K surface plus the same admitted message is well under the cap.
  const estimated = await run({ anchor: { history } })
  const plain = estimated.meter.measure(estimated.session, { config: estimated.route })
  assert.equal(plain.baseline.kind, 'estimated')
  const control = estimated.ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...estimated.route, surchargeAtTokens: 100_000 }], safetyMarginTokens: 20_000, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [estimated.user('admitted history '.repeat(2000))]
    await estimated.agentEvents(estimated.ctx, estimated.agent).waterfall('agent/pre-step', {
      turn: 1, step: 2, signal: estimated.signal, modelSelection: estimated.route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    assert.equal(estimated.summaries.length, 0, 'an uncalibrated heuristic stays below the cap')
  } finally {
    await control.dispose()
  }
})

test('installed DSH: the hard line rejects the step instead of dispatching', { skip: !useInstalled }, async () => {
  const { ctx, route, agent, signal, streams, summaries, user, agentEvents } = await run()
  // A summary route the pre-flight rejects leaves no way to lower the history,
  // so the hard line must fail the step before any provider request is built.
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{
      ...route,
      surchargeAtTokens: 1000,
      summaryTarget: { provider: 'offline-summary', model: 'cheap', reasoningEffort: 'unsupported' },
    }],
    safetyMarginTokens: 100,
    maxAttempts: 1,
    enforceLine: true,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admitted = [user('new step input')]
    await assert.rejects(
      agentEvents(ctx, agent).waterfall('agent/pre-step', {
        turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
      }, async () => ({ kind: 'enter', messages: admitted })),
      error => error.name === 'SurchargeLineError' && /blocked instead of sent/.test(error.message),
    )
    // No summary or main provider call was attempted.
    assert.equal(summaries.length, 0)
    assert.equal(streams.length, 0)
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: the dispatch gate blocks an over-line request on the real waterfall', { skip: !useInstalled }, async () => {
  const history = Array.from({ length: 3 }, () => 'history content '.repeat(2500))
  const usage = { inputTokens: 70_000, outputTokens: 100, totalTokens: 70_100 }
  const { ctx, session, route, agent, signal, streams, user, agentEvents } = await run({
    anchor: { history, usage },
  })
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 100_000 }],
    safetyMarginTokens: 20_000,
    maxAttempts: 1,
    enforceLine: true,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    // A step below the trigger still learns the route's provider/heuristic
    // ratio before the boundary is ever consulted.
    const admitted = [user('tiny step input')]
    await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 2, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    const huge = user('x'.repeat(300_000))
    const request = {
      provider: route.provider,
      model: route.model,
      sessionId: session.id,
      messages: [huge],
    }
    // The offline harness overrides `stream` itself, so dispatch through the
    // real waterfall the llm runtime uses.
    assert.throws(
      () => ctx.waterfall(ctx.get('llm'), 'llm/stream', request, () => 'stream'),
      error => error.name === 'SurchargeLineError' && /blocked before dispatch/.test(error.message),
    )
    // A request below the line still reaches the next listener.
    assert.equal(ctx.waterfall(ctx.get('llm'), 'llm/stream', {
      ...request, messages: [user('small request')],
    }, () => 'stream'), 'stream')
    // The adapter never saw the over-line request.
    assert.equal(streams.length, 0)
  } finally {
    await fiber.dispose()
  }
})
