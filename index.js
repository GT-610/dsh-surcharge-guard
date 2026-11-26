/** Host-side surcharge protection: compact early, enforce the line as a hard boundary. */
import z from '@deepseek-ai/schemastery'
import {
  DEFAULTS, attemptPolicy, blendRatio, calibratedPressure, emergencyGrowth, estimateToolsTokens,
  foldFloor, normalizeConfig, observedRatio, retentionBudget, ruleFor, selectRange,
} from './logic.js'

function compactionFor(ctx, agent) {
  // Web presets own an isolated backend; a standalone profile may own it at root.
  return ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
}

function prunerFor(ctx, agent) {
  // The standard preset isolates the pruner beside compaction, so the root
  // context cannot see it; resolve it through the preset first, then at root.
  // A preset without that service must not break the hard line.
  try {
    return ctx.get('agentPresets')?.serviceFor(agent, 'toolResultPruner') ?? ctx.get('toolResultPruner')
  } catch {
    return undefined
  }
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

/** A step the guard refused to dispatch because it prices at or above the line. */
class SurchargeLineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SurchargeLineError'
  }
}

/**
 * Whole-prompt heuristic price of the request that is about to be dispatched.
 *
 * The pre-step estimate anchors on the provider's own count and only prices the
 * delta. At the dispatch boundary there is no count to anchor on, so this
 * prices every message and the tool schemas at the route's observed ratio.
 */
function boundaryTokens(meter, options, ratio) {
  const scale = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
  let total = estimateToolsTokens(options)
  for (const message of options.messages) total += meter.estimateMessage(message)
  return Math.round(total * scale)
}

/** Attempt state for one turn of one session, route included. */
function budgetFor(attempts, session, turn, selection) {
  let budget = attempts.get(session)
  if (budget === undefined || budget.turn !== turn
    || budget.provider !== selection.provider || budget.model !== selection.model) {
    budget = {
      turn,
      provider: selection.provider,
      model: selection.model,
      attempts: 0,
      lastAttemptTokens: undefined,
      reported: new Set(),
    }
    attempts.set(session, budget)
  }
  return budget
}

/**
 * Calibration ratio for one session and route.
 *
 * Kept per route so switching models mid-session does not carry one
 * tokenizer's expansion factor onto another, and per session so a long-lived
 * conversation does not leak its ratio into a fresh one.
 */
function ratioFor(calibrations, dispatchRatios, session, selection, measurement, header) {
  let routes = calibrations.get(session)
  if (routes === undefined) {
    routes = new Map()
    calibrations.set(session, routes)
  }
  const key = `${selection.provider}\u0000${selection.model}`
  const ratio = blendRatio(routes.get(key), observedRatio(measurement, header))
  routes.set(key, ratio)
  // The dispatch-time backstop has no session object, only its id.
  dispatchRatios.set(`${String(session.id)}\u0000${key}`, ratio)
  return ratio
}

async function enforce(ctx, config, event, messages, attempts, calibrations, dispatchRatios, generation) {
  const { agent, signal, modelSelection, turn } = event
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
  // compaction the guard must not repeat: it would rewrite the checkpoint that
  // step just wrote for no additional reclaim. The line's emergency fold below
  // is different: it folds deeper because the request is still over.
  const surface = session.surface
  if (generation !== undefined && surface?.replaceGeneration !== undefined
    && surface.replaceGeneration !== generation) {
    ctx.logger.info(`${scope}: skipped; this step already folded history elsewhere`)
    return
  }
  const measure = () => meter.measure(session, header)
  let measurement = measure()
  // The provider's own count for the committed history plus a heuristic delta
  // is not the size of the next request. Price the delta and the admitted
  // messages at the route's observed expansion factor, or a fixed 4-chars
  // denominator quietly spends the whole safety margin.
  let ratio = ratioFor(calibrations, dispatchRatios, session, selection, measurement, header)
  let projected = calibratedPressure(measurement, pendingTokens, ratio)
  if (projected < cap || signal.aborted) return

  const reread = () => {
    measurement = measure()
    ratio = ratioFor(calibrations, dispatchRatios, session, selection, measurement, header)
    projected = calibratedPressure(measurement, pendingTokens, ratio)
  }
  const budget = budgetFor(attempts, session, turn, selection)
  const warn = reason => ctx.logger.warn(
    `${scope}: ${reason}; continuing with an estimated ${projected} prompt tokens `
    + `(trigger ${cap}, surcharge line ${line})`,
  )
  // One report per reason between attempts: a state that persists across the
  // steps of a turn should not write the same line at every one of them.
  const warnOnce = (key, reason) => {
    if (budget.reported.has(key)) return
    budget.reported.add(key)
    warn(reason)
  }

  /**
   * Hold the surcharge line as a hard boundary.
   *
   * Native compaction treats the model's context window the same way, except
   * the provider is what rejects an over-window request. Nothing rejects a
   * surcharge line: the provider accepts it and bills the higher rate. So the
   * guard reproduces native recovery locally: prune tool results without a
   * model call, force one depth-zero fold, and if the request is still priced
   * at or above the line, refuse to dispatch it.
   */
  async function enforceLine({ foldable = true } = {}) {
    if (!config.enforceLine || signal.aborted || projected < line) return
    const pruner = prunerFor(ctx, agent)
    if (pruner !== undefined) {
      try {
        const pruned = pruner.pruneSession(session)
        if (pruned.pruned.length > 0) {
          ctx.logger.info(`${scope}: pruned ${pruned.pruned.length} tool results `
            + `(${pruned.charsRemoved} chars) to stay under the ${line}-token line`)
          reread()
        }
      } catch (error) {
        if (signal.aborted) return
        ctx.logger.warn(`${scope}: tool-result pruning failed: ${error instanceof Error ? error.message : String(error)}`
          + '; trying a fold')
      }
    }
    if (projected < line || signal.aborted) return
    const compaction = foldable ? compactionFor(ctx, agent) : undefined
    if (compaction !== undefined) {
      try {
        const bound = await resolveSummaryEffort(ctx, rule, signal)
        if (signal.aborted) return
        const floor = foldFloor(cap)
        const range = selectRange(session, measure().nodes, 0, floor)
        if (range !== undefined) {
          const before = projected
          const result = rule.summaryTarget === undefined
            ? await compaction.compactRegion(range.start, range.end, agent, signal)
            : await compactWithSummaryTarget(ctx, compaction, rule, range, agent, signal, bound)
          if (signal.aborted) return
          reread()
          budget.attempts = 0
          ctx.logger.info(`${scope}: emergency fold for the line; estimated ${before} → ${projected} prompt tokens`)
        }
      } catch (error) {
        if (signal.aborted) return
        ctx.logger.warn(`${scope}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (projected < line || signal.aborted) return
    throw new SurchargeLineError(
      `${scope}: the next request is estimated at ${projected} prompt tokens, at or above the `
      + `${line}-token surcharge line; pruning and compaction could not lower it, so the step `
      + 'was blocked instead of sent',
    )
  }

  const policy = attemptPolicy({
    attempts: budget.attempts,
    maxAttempts: config.maxAttempts,
    projected,
    line,
    lastAttemptTokens: budget.lastAttemptTokens,
    emergencyGrowth: emergencyGrowth(cap),
  })
  if (policy === 'exhausted') {
    if (projected >= line) warnOnce('exhausted', 'summary budget exhausted, surcharge possible')
    return enforceLine()
  }
  if (policy === 'emergency') {
    ctx.logger.info(`${scope}: above the surcharge line after an unhelpful summary; trying once more`)
  }
  const compaction = compactionFor(ctx, agent)
  if (compaction === undefined) {
    warn('no compaction service')
    return enforceLine()
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
    // A mis-set level cannot succeed on a retry, but pruning and the hard
    // line still apply.
    return enforceLine({ foldable: false })
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
    // A refusal costs no attempt, so a phantom pressure would otherwise repeat
    // this line on every step of the turn. The surface it judged is unchanged
    // between them, so one report per turn is enough; the next turn re-checks.
    warnOnce('refused', 'no safe history range worth folding')
    return enforceLine()
  }
  const before = projected
  budget.attempts += 1
  budget.lastAttemptTokens = projected
  budget.reported.clear()
  let result
  try {
    result = rule.summaryTarget === undefined
      ? await compaction.compactRegion(range.start, range.end, agent, signal)
      : await compactWithSummaryTarget(ctx, compaction, rule, range, agent, signal, bound)
  } catch (error) {
    if (signal.aborted) return
    // A failed summary is one spent attempt, not a reason to stop protecting
    // the turn: the next step may still succeed, and the line still applies.
    warn(error instanceof Error ? error.message : String(error))
    return enforceLine()
  }
  if (signal.aborted) return
  reread()
  ctx.logger.info(`${scope}: folded ${result.shadowedSeqs.length} nodes; estimated ${before} → ${projected} prompt tokens`)
  if (projected >= before) {
    warn('compaction did not lower the estimated pressure')
    return enforceLine()
  }
  // A fold that helped re-arms the budget: protection that is working must not
  // be what disables protection for the rest of a long turn.
  budget.attempts = 0
  budget.lastAttemptTokens = undefined
  if (projected >= cap) {
    warn(projected >= line ? 'still at or above the surcharge line' : 'still within the safety margin')
  }
  return enforceLine()
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
  /** Unhelpful attempts allowed between folds; a helpful fold re-arms it. */
  maxAttempts: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxAttempts).volatile(),
  /** Refuse to dispatch a request priced at or above the line. */
  enforceLine: z.boolean().default(DEFAULTS.enforceLine).volatile(),
})

export const inject = ['tokenMeter']

export function apply(ctx, rawConfig) {
  // Per-session attempt state and per-route token calibration; both are keyed
  // weakly so a finished session is collected with its guard state. The
  // dispatch-time gate has no session object, only its id.
  const attempts = new WeakMap()
  const calibrations = new WeakMap()
  const dispatchRatios = new Map()

  ctx.on('agent/pre-step', async (event, next) => {
    // Let native compaction and other downstream middleware run first, then
    // price the messages the step will admit (not just the original inbox).
    // Their surface replacement is recorded so this step is not compacted twice.
    const generation = event.agent.session.surface?.replaceGeneration
    const decision = await next()
    const { signal } = event
    if (decision.kind !== 'enter' || signal.aborted) return decision
    try {
      const config = normalizeConfig(rawConfig)
      if (!config.enabled || config.rules.length === 0 || config.maxAttempts === 0) return decision
      await enforce(ctx, config, event, decision.messages, attempts, calibrations, dispatchRatios, generation)
    } catch (error) {
      // A refused dispatch is the one failure this middleware must propagate:
      // swallowing it would send the over-line request it exists to prevent.
      if (error instanceof SurchargeLineError) throw error
      if (!signal.aborted) {
        ctx.logger.warn(`surcharge guard: ${error instanceof Error ? error.message : String(error)}; continuing the step`)
      }
    }
    return decision
  }, { prepend: true })

  /**
   * Last line of defence at the dispatch boundary.
   *
   * The pre-step estimate anchors on the previous provider count and can drift
   * once the loop refreshes the system prompt or admits late context. This
   * prices the exact outgoing request instead, with the same route ratio. A
   * compaction summary is exempt: it is the recovery mechanism, and its own
   * route may be a different, unguarded model.
   */
  ctx.on('llm/stream', (options, next) => {
    const config = normalizeConfig(rawConfig)
    if (!config.enabled || config.maxAttempts === 0 || !config.enforceLine) return next()
    if (options.purpose !== undefined || options.sessionId === undefined) return next()
    const rule = ruleFor(config, options)
    if (rule === undefined) return next()
    const ratio = dispatchRatios.get(`${String(options.sessionId)}\u0000${options.provider}\u0000${options.model}`)
    const estimated = boundaryTokens(ctx.tokenMeter, options, ratio)
    if (estimated < rule.surchargeAtTokens) return next()
    throw new SurchargeLineError(
      `surcharge guard (${rule.provider}/${rule.model}): the request is priced at ${estimated} prompt tokens, `
      + `at or above the ${rule.surchargeAtTokens}-token surcharge line; blocked before dispatch`,
    )
  }, { global: true, prepend: true })

  // A disposed session's ratios cannot be read again; drop them so a long-lived
  // process does not accumulate one entry per session ever opened.
  ctx.on('session/disposed', session => {
    const prefix = `${String(session.id)}\u0000`
    for (const key of dispatchRatios.keys()) if (key.startsWith(prefix)) dispatchRatios.delete(key)
  })
}

