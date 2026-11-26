/** Pure configuration normalization and tool-pair-safe range selection. */
/** Values used when the row's config omits a field. */
export const DEFAULTS = Object.freeze({
  safetyMarginTokens: 20000,
  retainRatio: 0.16,
  maxAttempts: 2,
  /** Treat the surcharge line as a hard boundary: prune, force a fold, then block. */
  enforceLine: true,
})

/** Verbatim tail kept even when the gap would allow folding deeper. */
const MIN_TAIL_TOKENS = 8000

/** Fixed text density the meter prices unmeasured content with. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead the meter adds to a payload. */
const BLOCK_OVERHEAD = 4

/** Bounds of the observed provider/heuristic ratio. */
export const CALIBRATION = Object.freeze({
  min: 1,
  max: 8,
  release: 0.9,
  /** Smallest growth above the surcharge line that justifies another attempt. */
  minGrowthTokens: 1024,
  growthRatio: 0.01,
})

/** Unwrap one live (volatile) config reference. */
function liveValue(field, fallback) {
  if (field === undefined) return fallback
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/** Read a non-negative integer, falling back when the value is unusable. */
function nonNegativeInteger(value, fallback) {
  const parsed = Math.trunc(Number(value))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/** Read a retention ratio within the same inclusive bounds as Config. */
function ratioOf(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0.01 && parsed <= 0.9 ? parsed : fallback
}

/**
 * Validate one raw rule.
 * @param entry - candidate from configuration.
 * @returns a complete rule, or `undefined` when it is unusable.
 */
export function normalizeRule(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  const surchargeAtTokens = Math.trunc(Number(entry.surchargeAtTokens))
  if (provider.length === 0 || model.length === 0) return undefined
  if (!Number.isSafeInteger(surchargeAtTokens) || surchargeAtTokens <= 0) return undefined
  // A half-written route is ignored rather than sent somewhere unintended; the
  // rule itself still guards, because losing protection costs more than the
  // default summary route would.
  const summary = entry.summaryTarget
  const summaryProvider = typeof summary?.provider === 'string' ? summary.provider.trim() : ''
  const summaryModel = typeof summary?.model === 'string' ? summary.model.trim() : ''
  // The effort belongs to the chosen summary route, so it is dropped with it:
  // the session's own summary settings keep their own effort. Zero-width
  // characters are not `WhiteSpace`, so they are stripped explicitly — an
  // invisible id could never match a catalog entry and would fail every step.
  const rawEffort = typeof summary?.reasoningEffort === 'string'
    ? summary.reasoningEffort.replace(/[\u200b-\u200d\ufeff]/g, '').trim()
    : ''
  const summaryEffort = rawEffort.length > 0 && rawEffort.length <= 64 ? rawEffort : ''
  return {
    provider, model, surchargeAtTokens, enabled: entry.enabled !== false,
    ...(summaryProvider && summaryModel ? {
      summaryTarget: {
        provider: summaryProvider,
        model: summaryModel,
        ...(summaryEffort ? { reasoningEffort: summaryEffort } : {}),
      },
    } : {}),
  }
}

/**
 * Normalize a raw config (or a saved document) into the shape this plugin runs on.
 * @param raw - the Loader row's config, or a JSON body from the settings page.
 * @returns complete configuration with unusable and duplicate entries dropped.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rules = []
  const seen = new Set()
  const candidates = liveValue(source.rules, [])
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const rule = normalizeRule(candidate)
    if (rule === undefined) continue
    const key = `${rule.provider}\u0000${rule.model}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push(rule)
  }
  return {
    enabled: liveValue(source.enabled, true) !== false,
    rules,
    safetyMarginTokens: nonNegativeInteger(
      liveValue(source.safetyMarginTokens, DEFAULTS.safetyMarginTokens),
      DEFAULTS.safetyMarginTokens,
    ),
    retainRatio: ratioOf(liveValue(source.retainRatio, DEFAULTS.retainRatio), DEFAULTS.retainRatio),
    maxAttempts: nonNegativeInteger(liveValue(source.maxAttempts, DEFAULTS.maxAttempts), DEFAULTS.maxAttempts),
    enforceLine: liveValue(source.enforceLine, DEFAULTS.enforceLine) !== false,
  }
}

/**
 * Find the enabled rule guarding one routed target.
 * @param config - normalized configuration.
 * @param target - the routed provider and model.
 * @returns the matching rule, or `undefined`.
 */
export function ruleFor(config, target) {
  if (!config.enabled) return undefined
  return config.rules.find(rule => (
    rule.enabled && rule.provider === target.provider && rule.model === target.model
  ))
}

/**
 * Price the tool-schema part of a request envelope the way the meter does.
 *
 * The meter compares a provider count against exactly this price before it
 * reuses that count, so the guard reconstructs the same number when it turns
 * the count into an observed ratio.
 *
 * @param header - canonical request envelope, or nothing.
 * @returns heuristic tokens for its tool schemas; 0 when absent or unpriceable.
 */
export function estimateToolsTokens(header) {
  const tools = header?.tools
  if (!Array.isArray(tools) || tools.length === 0) return 0
  let serialized
  try {
    serialized = JSON.stringify(tools)
  } catch {
    return 0
  }
  return Math.ceil(serialized.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Sum every provider-counted bucket the meter prices one prompt with.
 * @param usage - provider usage record from a measurement baseline.
 * @returns the summed tokens, or `undefined` when the record is unusable.
 */
export function usageTokens(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  let total = 0
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    const value = usage[key]
    if (Number.isFinite(value)) total += value
  }
  return total
}

/**
 * Learn how much larger the provider's own count is than the fixed heuristic.
 *
 * A `usage` baseline means the meter reused the last successful call's
 * provider count for the committed history. `surfaceTokens - surfaceDeltaTokens`
 * reconstructs the heuristic price of that same history, so the two are
 * directly comparable: the quotient is the route's expansion factor, and it is
 * available immediately instead of being inferred from a previous prediction.
 *
 * @param measurement - latest `tokenMeter.measure` result.
 * @param header - the request envelope the measurement was priced against.
 * @returns tokens-provider / tokens-heuristic, or `undefined` without usage.
 */
export function observedRatio(measurement, header) {
  if (measurement?.baseline?.kind !== 'usage') return undefined
  if (!Number.isFinite(measurement.surfaceTokens) || !Number.isFinite(measurement.surfaceDeltaTokens)) return undefined
  const anchorSurface = Math.max(0, measurement.surfaceTokens - measurement.surfaceDeltaTokens)
  const heuristic = estimateToolsTokens(header) + anchorSurface
  const actual = usageTokens(measurement.baseline.usage)
  if (actual === undefined || heuristic <= 0 || actual <= 0) return undefined
  return actual / heuristic
}

/**
 * Blend one observed ratio into the one used for pricing.
 *
 * An undercount is the dangerous direction, so a larger observation applies at
 * once; a smaller one is released gradually, which keeps one noisy call from
 * relaxing protection by a step. Neither direction leaves the bounds.
 *
 * @param ratio - ratio currently in force.
 * @param sample - latest observation, or `undefined` when none is available.
 * @returns the ratio to use for this step.
 */
export function blendRatio(ratio, sample) {
  const current = Number.isFinite(ratio) && ratio > 0 ? ratio : CALIBRATION.min
  if (!Number.isFinite(sample) || sample <= 0) return current
  const next = sample > current
    ? sample
    : current * CALIBRATION.release + sample * (1 - CALIBRATION.release)
  return Math.min(CALIBRATION.max, Math.max(CALIBRATION.min, next))
}

/**
 * Price a measurement plus the messages a step will admit.
 *
 * The provider count is already in provider tokens, so only the
 * heuristic-priced part — the surface delta since the anchored request and the
 * admitted messages — is scaled. An estimate with no provider count behind it
 * is wholly heuristic and is scaled as a whole.
 *
 * @param measurement - latest `tokenMeter.measure` result.
 * @param pendingTokens - heuristic price of the admitted messages.
 * @param ratio - calibration ratio for the route.
 * @returns the projected prompt size in provider-scale tokens.
 */
export function calibratedPressure(measurement, pendingTokens, ratio) {
  const scale = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
  const delta = Number.isFinite(measurement.surfaceDeltaTokens) ? measurement.surfaceDeltaTokens : 0
  const base = Math.max(0, measurement.totalTokens - delta)
  const heuristic = Math.round((delta + Math.max(0, pendingTokens)) * scale)
  return (measurement.baseline?.kind === 'usage' ? base : Math.round(base * scale)) + heuristic
}

/**
 * Decide whether this step may spend a summary call.
 *
 * The attempt limit counts attempts that did not help; a fold that lowered the
 * pressure re-arms it. Above the surcharge line another attempt is allowed even
 * when the budget is spent, provided the pressure has grown since the last one:
 * sending that request pays the surcharge, so retrying is the cheaper side.
 *
 * @param options.attempts - attempts spent since the last successful fold.
 * @param options.maxAttempts - configured attempt limit.
 * @param options.projected - prompt size this step would send.
 * @param options.line - the rule's surcharge threshold.
 * @param options.lastAttemptTokens - projection when the last attempt started.
 * @param options.emergencyGrowth - growth that justifies an over-budget retry.
 * @returns `attempt`, `emergency` or `exhausted`.
 */
export function attemptPolicy({
  attempts, maxAttempts, projected, line, lastAttemptTokens, emergencyGrowth,
}) {
  if (attempts < maxAttempts) return 'attempt'
  if (projected < line) return 'exhausted'
  if (lastAttemptTokens === undefined || projected >= lastAttemptTokens + emergencyGrowth) return 'emergency'
  return 'exhausted'
}

/**
 * Growth above the surcharge line that makes an over-budget retry worthwhile.
 * @param cap - trigger line minus the safety margin.
 * @returns the floor in tokens.
 */
export function emergencyGrowth(cap) {
  const scale = Number.isFinite(cap) && cap > 0 ? cap : 0
  return Math.max(CALIBRATION.minGrowthTokens, Math.round(scale * CALIBRATION.growthRatio))
}

/**
 * Cut balance for every position of a surface, so a compaction range never
 * splits an assistant tool call from its result.
 * @param session - session whose current surface is checked.
 * @param nodes - priced surface nodes in surface order.
 * @returns `cuts[i]` for the cut before `nodes[i]`, plus the trailing cut; or
 *   `undefined` when the surface is internally inconsistent.
 */
export function balanceCuts(session, nodes) {
  const cuts = [true]
  let open = 0
  for (const node of nodes) {
    const event = session.eventAt(node.seq)
    if (event === undefined || event.seq !== node.seq) return undefined
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return undefined
      for (const block of content) if (block?.type === 'tool-call') open += 1
    } else if (event.type === 'tool/result') {
      open -= 1
    }
    if (open < 0) return undefined
    cuts.push(open === 0)
  }
  return cuts
}

/** True when a surface node is the replacement a previous fold wrote. */
function isCheckpoint(session, seq) {
  const event = session.eventAt(seq)
  return event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint'
}

/**
 * Recent-tail budget that leaves room to close the gap in one fold.
 *
 * A fold removes the nodes it shadows and adds the checkpoint that replaces
 * them, so the reclaimable amount is the surface price minus the retained tail
 * minus that checkpoint. A small gap keeps the configured ratio; a large one
 * shrinks the tail down to the floor, because a tail that eats the gap is what
 * makes a compaction "succeed" while the next request is still over the line.
 *
 * @param options.cap - the trigger line minus the safety margin.
 * @param options.projected - priced prompt for the step being admitted.
 * @param options.surfaceTokens - route-priced total of the current surface.
 * @param options.retainTokens - configured ceiling for the verbatim tail.
 * @param options.summaryTokens - price reserved for the replacement checkpoint.
 * @param [options.minTailTokens] - floor for the verbatim tail.
 * @returns the tail budget to select the range with.
 */
export function retentionBudget({
  cap, projected, surfaceTokens, retainTokens, summaryTokens = 0, minTailTokens = MIN_TAIL_TOKENS,
}) {
  const needed = Math.max(0, projected - cap) + Math.max(0, summaryTokens)
  const ceiling = Math.max(0, retainTokens)
  // Never keep more than the surface itself, and never less than the floor
  // unless the configured ceiling is below it.
  const keepAtLeast = Math.min(ceiling, Math.max(0, minTailTokens))
  const affordable = Math.max(0, surfaceTokens - needed)
  return Math.min(ceiling, Math.max(keepAtLeast, affordable))
}

/**
 * Prices that decide whether a fold is worth a model call at all.
 *
 * Both scale with the trigger so a small model is not held to a long-context
 * floor. `summaryTokens` reserves what the replacement checkpoint will cost;
 * `minReclaimTokens` is the smallest gain that justifies rewriting history.
 *
 * @param cap - the trigger line minus the safety margin.
 * @returns the checkpoint allowance and the minimum net reclaim.
 */
export function foldFloor(cap) {
  const scale = Number.isFinite(cap) && cap > 0 ? cap : 0
  return {
    summaryTokens: Math.min(8192, Math.max(1024, Math.round(scale * 0.02))),
    minReclaimTokens: Math.max(1024, Math.round(scale * 0.01)),
  }
}

/**
 * Choose the span to fold into one summary.
 *
 * Keeps a recent tail verbatim, then rewinds the cut to a tool-pairing
 * balanced position. A leading `system/message` is never inside the span.
 *
 * A span made only of checkpoints is refused: it would rewrite the summary a
 * previous fold just wrote, which costs a model call and cannot reclaim enough
 * to matter. `floor` additionally refuses a span whose reclaim would not cover
 * that rewrite.
 *
 * @param session - session supplying the surface.
 * @param nodes - priced surface nodes in surface order.
 * @param retainTokens - minimum recent-tail budget retained verbatim.
 * @param [floor] - `foldFloor(cap)` result; omitted means no minimum reclaim.
 * @returns the inclusive span, or `undefined` when nothing is worth compacting.
 */
export function selectRange(session, nodes, retainTokens, floor = {}) {
  const surface = session.surface.nodes
  if (nodes.length === 0 || nodes.length !== surface.length
    || nodes.some((node, index) => node.seq !== surface[index])) return undefined
  const cuts = balanceCuts(session, nodes)
  if (cuts === undefined) return undefined
  const head = session.eventAt(nodes[0].seq)
  const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0

  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  if (keepFrom <= firstIdx || cuts[firstIdx] !== true) return undefined

  while (keepFrom > firstIdx && cuts[keepFrom] !== true) keepFrom -= 1
  if (keepFrom <= firstIdx) return undefined

  const span = nodes.slice(firstIdx, keepFrom)
  // Only the checkpoints a previous fold wrote: rewriting them buys nothing.
  if (span.every(node => isCheckpoint(session, node.seq))) return undefined
  const reclaimable = span.reduce((total, node) => total + node.tokens, 0)
    - Math.max(0, floor.summaryTokens ?? 0)
  if (reclaimable < Math.max(0, floor.minReclaimTokens ?? 0)) return undefined

  return { start: span[0].seq, end: span[span.length - 1].seq }
}
