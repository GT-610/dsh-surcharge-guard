/** Host-side, best-effort surcharge protection for model requests. */
import z from '@deepseek-ai/schemastery'
import { DEFAULTS, normalizeConfig, ruleFor, selectRange } from './logic.js'

function compactionFor(ctx, agent) {
  // Web presets own an isolated backend; a standalone profile may own it at root.
  return ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
}

/** The next request has not been built yet. Reprice the committed history for
 * the selected route, using the previous tool envelope only as a proxy. */
function projectedHeader(session, selection) {
  const { provider, model, reasoningEffort } = selection
  const previous = session.requestHeader()
  const sameRoute = previous?.config.provider === provider && previous.config.model === model
  const config = { ...(sameRoute ? previous.config : {}), provider, model }
  if (reasoningEffort !== undefined) config.reasoningEffort = reasoningEffort
  else if (sameRoute && previous.adapterDefaults?.reasoningEffort !== true) delete config.reasoningEffort
  const adapterDefaults = sameRoute ? { ...previous.adapterDefaults } : {}
  if (reasoningEffort !== undefined) delete adapterDefaults.reasoningEffort
  return {
    config,
    ...(Object.keys(adapterDefaults).length > 0 ? { adapterDefaults } : {}),
    ...(previous?.tools === undefined ? {} : { tools: previous.tools }),
  }
}

async function enforce(ctx, config, { agent, signal, modelSelection }, messages, budget) {
  const selection = modelSelection ?? agent.model?.current()
  if (selection === undefined) return
  const rule = ruleFor(config, selection)
  if (rule === undefined) return

  const { session } = agent
  const meter = ctx.tokenMeter
  const header = projectedHeader(session, selection)
  const pendingTokens = messages.reduce((total, message) => total + meter.estimateMessage(message), 0)
  const line = rule.surchargeAtTokens
  const cap = Math.max(1, line - config.safetyMarginTokens)
  const scope = `surcharge guard (${rule.provider}/${rule.model})`
  const measure = () => meter.measure(session, header)
  let measurement = measure()
  let projected = measurement.totalTokens + pendingTokens
  if (projected < cap || signal.aborted) return

  const warn = reason => ctx.logger.warn(
    `${scope}: ${reason}; continuing with an estimated ${projected} prompt tokens `
    + `(trigger ${cap}, surcharge line ${line})`,
  )
  if (budget.used >= config.maxAttempts) {
    if (projected >= line) warn('summary budget exhausted, surcharge possible')
    return
  }
  const compaction = compactionFor(ctx, agent)
  if (compaction === undefined) {
    warn('no compaction service')
    return
  }

  while (projected >= cap && budget.used < config.maxAttempts && !signal.aborted) {
    const range = selectRange(session, measurement.nodes, Math.floor(cap * config.retainRatio))
    if (range === undefined) {
      warn('no safe history range to compact')
      return
    }
    const before = projected
    budget.used += 1
    const result = await compaction.compactRegion(range.start, range.end, agent, signal)
    if (signal.aborted) return
    measurement = measure()
    projected = measurement.totalTokens + pendingTokens
    ctx.logger.info(`${scope}: folded ${result.shadowedSeqs.length} nodes; estimated ${before} → ${projected} prompt tokens`)
    if (projected >= before) {
      warn('compaction did not lower the estimated pressure')
      return
    }
  }
  if (!signal.aborted && projected >= cap) {
    warn(projected >= line ? 'still at or above the surcharge line' : 'still within the safety margin')
  }
}

/** All fields are volatile so edits apply without restarting a running agent. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  rules: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    surchargeAtTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    enabled: z.boolean().default(true),
  })).default([]).volatile(),
  safetyMarginTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.safetyMarginTokens).volatile(),
  retainRatio: z.number().min(0.01).max(0.9).default(DEFAULTS.retainRatio).volatile(),
  maxAttempts: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxAttempts).volatile(),
})

export const inject = ['tokenMeter']

export function apply(ctx, rawConfig) {
  const attempts = new WeakMap()

  ctx.on('agent/pre-step', async (event, next) => {
    // Let native compaction and other downstream middleware run first, then
    // price the messages the step will admit (not just the original inbox).
    const decision = await next()
    const { agent, signal, turn } = event
    if (decision.kind !== 'enter' || signal.aborted) return decision
    try {
      const config = normalizeConfig(rawConfig)
      if (!config.enabled || config.rules.length === 0 || config.maxAttempts === 0) return decision
      let budget = attempts.get(agent.session)
      if (budget === undefined || budget.turn !== turn) {
        budget = { turn, used: 0 }
        attempts.set(agent.session, budget)
      }
      await enforce(ctx, config, event, decision.messages, budget)
    } catch (error) {
      if (!signal.aborted) {
        ctx.logger.warn(`surcharge guard: ${error instanceof Error ? error.message : String(error)}; continuing the step`)
      }
    }
    return decision
  }, { prepend: true })
}

