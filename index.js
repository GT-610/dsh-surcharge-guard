/** Host-side, best-effort surcharge protection for model requests. */
import z from '@deepseek-ai/schemastery'
import { DEFAULTS, foldFloor, normalizeConfig, retentionBudget, ruleFor, selectRange } from './logic.js'

function compactionFor(ctx, agent) {
  // Web presets own an isolated backend; a standalone profile may own it at root.
  return ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
}

/**
 * Force one reasoning effort onto the auxiliary calls of an isolated backend.
 *
 * `GenerateOptions` carries the effort per call and Basic's summarizer builds
 * the request itself, so the selection rides on the `llm` service the engine
 * resolves. Basic's own config cannot carry it: its loader rejects keys it does
 * not know in `resolveConfig`, and `reasoningEffort` is not one of its summary
 * settings.
 *
 * The service a context hands out is itself a proxy that the framework wraps
 * again for every reader. Reporting no tracker keeps this view from being
 * wrapped a second time, and forwarding every other member keeps the rest of
 * the service intact for a summarizer that reaches for it.
 */
function withSummaryEffort(llm, reasoningEffort) {
  return new Proxy(llm, {
    get(target, property) {
      if (property === Symbol.for('cordis.tracker')) return undefined
      if (property === 'stream') return options => target.stream({ ...options, reasoningEffort })
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Reject a summary effort the chosen route cannot serve, before any work.
 *
 * Runs outside the compaction transaction so a mis-set level costs one warning
 * and nothing else: no marker pair, no attempt spent, no summary request. The
 * effort the caller passes on is what the route is asked for, so a route
 * default never silently replaces it.
 *
 * @returns the bound `llm` view to provide, or `undefined` when no effort is set.
 */
async function resolveSummaryEffort(ctx, rule, signal) {
  const { summaryTarget } = rule
  const effort = summaryTarget?.reasoningEffort
  if (effort === undefined) return undefined
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error(`a summary effort needs the llm service to route "${effort}"`)
  try {
    await llm.resolveCallConfig({
      provider: summaryTarget.provider,
      model: summaryTarget.model,
      reasoningEffort: effort,
    }, signal)
  } catch (error) {
    signal.throwIfAborted()
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`the summary route cannot use reasoning effort "${effort}": ${reason}`, { cause: error })
  }
  signal.throwIfAborted()
  return withSummaryEffort(llm, effort)
}

/**
 * Compact one range through a Basic backend configured with a summary route.
 *
 * `compactRegion` takes only a range, an agent and a signal, and Basic keeps
 * its summary route in instance state, so a per-rule model cannot be passed
 * through that call. Instead this mounts a second Basic instance inside its
 * own `compaction` realm for the duration of one transaction and disposes it
 * afterwards: two sessions compacting at once never share or overwrite each
 * other's route, and the session's own backend is never rebound.
 *
 * A rule that also picks a reasoning effort isolates `llm` in that same realm
 * and provides an effort-bound view of it, so the override reaches this
 * transaction's summary call and no other.
 *
 * The class comes from the backend the preset already mounted, so no second
 * copy of the runtime is imported. Basic configures a summary route through
 * `summarizationProvider`/`summarizationModel`, which is also how a subclass
 * of it can be recognised: a backend without that contract is reported rather
 * than mounted with settings it does not understand.
 */
async function compactWithSummaryTarget(ctx, backend, rule, range, agent, signal, bound) {
  const { summaryTarget } = rule
  const route = `${summaryTarget.provider}/${summaryTarget.model}`
  try {
    const config = backend.config
    const supportsRoute = typeof config?.summarizationProvider === 'string'
      && typeof config?.summarizationModel === 'string'
    const Engine = backend.constructor
    if (!supportsRoute || typeof Engine !== 'function') {
      throw new Error('a per-rule summary model needs a Basic-style compaction backend')
    }
    // Keep the budget the existing policy already priced summaries with, so the
    // replacement is not truncated at a different cap.
    const policy = config.modelPolicies?.find(({ provider, model }) => (
      provider === rule.provider && model === rule.model
    ))
    const maxTokens = policy?.maxTokens ?? config.maxTokens
    signal.throwIfAborted()

    const realm = bound === undefined ? ctx.isolate('compaction') : ctx.isolate('compaction').isolate('llm')
    let release
    try {
      // Registered before the backend so its first dependency check already
      // sees the bound view; the realm is fresh per transaction, so no other
      // summary call can resolve it.
      release = bound === undefined ? undefined : realm.provide('llm', bound)
      const fiber = realm.plugin(Engine, {
        auto: false,
        summarizationProvider: summaryTarget.provider,
        summarizationModel: summaryTarget.model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      })
      try {
        const active = await fiber
        signal.throwIfAborted()
        const engine = active.ctx.get('compaction')
        if (engine === undefined) throw new Error('the isolated compaction backend did not start')
        return await engine.compactRegion(range.start, range.end, agent, signal)
      } finally {
        await fiber.dispose()
      }
    } finally {
      await release?.()
    }
  } catch (error) {
    // Cancellation keeps its own identity; only a summary failure is renamed.
    signal.throwIfAborted()
    throw new Error(`summary via ${route} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
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

async function enforce(ctx, config, { agent, signal, modelSelection }, messages, budget, generation) {
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
  // Native compaction and any other pre-step middleware have already run by
  // the time this executes. A surface they replaced in this same step is a
  // compaction the guard must not repeat: a second summary in one step is the
  // double fold this plugin exists to avoid, and it can only rewrite the
  // checkpoint the first one wrote.
  const surface = session.surface
  if (generation !== undefined && surface?.replaceGeneration !== undefined
    && surface.replaceGeneration !== generation) {
    ctx.logger.info(`${scope}: skipped; this step already folded history elsewhere`)
    return
  }
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
  // A summary effort the route cannot serve is settled before the first
  // attempt is spent: a mis-set level must not disable the rule's protection
  // for the rest of the turn. It is reported once per step and the guard
  // stops trying, because no later attempt could succeed either.
  let bound
  try {
    bound = await resolveSummaryEffort(ctx, rule, signal)
  } catch (error) {
    if (signal.aborted) return
    warn(error instanceof Error ? error.message : String(error))
    return
  }
  if (signal.aborted) return

  // Depth follows the gap: a tail that keeps the configured ratio cannot close
  // a large gap, and chasing the remainder in a second fold only rewrites the
  // checkpoint the first one wrote.
  const floor = foldFloor(cap)
  const surfaceTokens = measurement.surfaceTokens
    ?? measurement.nodes.reduce((total, node) => total + node.tokens, 0)
  const retain = retentionBudget({
    cap,
    projected,
    surfaceTokens,
    retainTokens: Math.floor(cap * config.retainRatio),
    summaryTokens: floor.summaryTokens,
  })
  const range = selectRange(session, measurement.nodes, retain, floor)
  if (range === undefined) {
    warn('no safe history range worth folding')
    return
  }
  const before = projected
  budget.used += 1
  const result = rule.summaryTarget === undefined
    ? await compaction.compactRegion(range.start, range.end, agent, signal)
    : await compactWithSummaryTarget(ctx, compaction, rule, range, agent, signal, bound)
  if (signal.aborted) return
  measurement = measure()
  projected = measurement.totalTokens + pendingTokens
  ctx.logger.info(`${scope}: folded ${result.shadowedSeqs.length} nodes; estimated ${before} → ${projected} prompt tokens`)
  if (projected >= before) {
    warn('compaction did not lower the estimated pressure')
    return
  }
  if (projected >= cap) {
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
    /** Absent means the session's own summary route. */
    summaryTarget: z.union([z.const(null), z.object({
      provider: z.string().required(),
      model: z.string().required(),
      /** Absent means the route's own default effort. */
      reasoningEffort: z.string(),
    })]).default(null),
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
    // Their surface replacement is recorded so this step is not compacted twice.
    const generation = event.agent.session.surface?.replaceGeneration
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
      await enforce(ctx, config, event, decision.messages, budget, generation)
    } catch (error) {
      if (!signal.aborted) {
        ctx.logger.warn(`surcharge guard: ${error instanceof Error ? error.message : String(error)}; continuing the step`)
      }
    }
    return decision
  }, { prepend: true })
}

