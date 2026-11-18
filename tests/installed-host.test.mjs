import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as guard from '../index.js'

const install = process.env.DSH_INSTALL_DIR
const useInstalled = Boolean(install) && (process.versions.electron !== undefined || !install.includes('.asar'))

test('installed DSH: real waterfall, token meter and summary transaction', { skip: !useInstalled }, async () => {
  const require = createRequire(`${install}/package.json`)
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)))
  const { Context } = await load('cordis')
  const { Session, SessionId } = await load('dsh-session')
  const { agentEvents } = await load('dsh-agent')
  const { createUserMessage } = await load('dsh-llm')
  const { BasicCompactionEngine } = await load('dsh-compaction-basic')
  const { TokenMeter } = await load('dsh-token-meter')
  const ctx = new Context()
  const session = Session.create(SessionId('surcharge-guard-offline'))
  const route = { provider: 'offline', model: 'guarded' }
  const agent = { id: session.id, ctx, session, options: route }
  const signal = new AbortController().signal
  let summaries = 0
  let streams = 0
  class OfflineCompaction extends BasicCompactionEngine {
    async summarize() {
      summaries += 1
      return { ...route, summary: [{ type: 'text', text: 'short checkpoint' }] }
    }
  }
  ctx.provide('llm', {
    imageRequestPricing() {},
    stream() { streams += 1; throw Error('This test must never call a model') },
  })
  ctx.provide('sessions', {})
  const meter = new TokenMeter(ctx)
  const engine = new OfflineCompaction(ctx.isolate('compaction'), { auto: false })
  assert.equal(ctx.get('compaction'), undefined)
  ctx.provide('agentPresets', { serviceFor: (owner, key) => owner === agent && key === 'compaction' ? engine : undefined })
  const fiber = ctx.plugin({ apply: guard.apply, Config: guard.Config, inject: guard.inject }, {
    rules: [{ ...route, surchargeAtTokens: 1000 }], safetyMarginTokens: 100, maxAttempts: 1,
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    session.append('turn/start', { turn: 1 })
    // Seed visible history but deliberately omit the first request/header.
    session.append('user/message', user('history content '.repeat(2500)), { surfaceOp: 'append' })
    session.append('user/message', user('keep recent '.repeat(100)), { surfaceOp: 'append' })
    const before = meter.measure(session, { config: route }).totalTokens
    const admitted = [user('new step input')]
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      turn: 1, step: 1, signal, modelSelection: route, messages: admitted,
    }, async () => ({ kind: 'enter', messages: admitted }))
    assert.deepEqual(decision, { kind: 'enter', messages: admitted })
    assert.equal(streams, 0)
    assert.equal(summaries, 1)
    const after = meter.measure(session, { config: route }).totalTokens
    assert.ok(before >= 1000 && after < 900, `expected history to shrink below trigger; ${before} → ${after}`)
    assert.deepEqual(session.snapshotEvents().slice(-4).map(event => event.type), [
      'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
    ])
  } finally {
    await fiber.dispose()
  }
})
