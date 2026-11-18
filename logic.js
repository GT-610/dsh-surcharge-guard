/**
 * dsh-surcharge-guard — decision logic, free of any runtime import.
 *
 * Kept separate from `index.js` for one reason: everything here is a pure
 * function of values the caller already has, so it can be unit-tested against a
 * plain fake session instead of a live Cordis context.
 *
 * The two decisions this module owns:
 *
 * 1. WHICH models are guarded. A double-billing threshold is a number the
 *    provider publishes, not a fraction of the context window, so it cannot be
 *    derived — it is recorded per model, and classified into a family only to
 *    prefill that number.
 * 2. WHERE a compaction may cut. A range that splits an assistant tool call
 *    from its result is rejected by the compaction backend, so the cut is
 *    rewinded to the nearest balanced position before any summary is attempted.
 *
 * @module dsh-surcharge-guard/logic
 */

/** Bundle row id, which is also the settings namespace the Client page edits. */
export const PLUGIN_ID = 'dsh-surcharge-guard'

/** Values used when the row's config omits a field. */
export const DEFAULTS = Object.freeze({
  safetyMarginTokens: 20000,
  retainRatio: 0.16,
  maxAttempts: 2,
})

/**
 * Model families whose double-billing threshold the operator documented, with
 * the provider's published number rather than a fraction of the window.
 */
export const FAMILIES = Object.freeze([
  Object.freeze({ id: 'gpt', surchargeAtTokens: 272000 }),
  Object.freeze({ id: 'gemini', surchargeAtTokens: 200000 }),
  Object.freeze({ id: 'grok', surchargeAtTokens: 200000 }),
])

/**
 * Classify one model id into a documented family.
 * @param model - provider-owned model id.
 * @returns the family id, or `undefined` when no threshold is documented.
 */
export function familyOf(model) {
  const id = String(model).toLowerCase()
  if (/(^|[-_/:])gpt/.test(id)) return 'gpt'
  if (id.includes('gemini')) return 'gemini'
  if (id.includes('grok')) return 'grok'
  return undefined
}

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
  return { provider, model, surchargeAtTokens, enabled: entry.enabled !== false }
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

/**
 * Choose the span to fold into one summary.
 *
 * Keeps a recent tail verbatim, then rewinds the cut to a tool-pairing
 * balanced position. A leading `system/message` is never inside the span.
 *
 * @param session - session supplying the surface.
 * @param nodes - priced surface nodes in surface order.
 * @param retainTokens - minimum recent-tail budget retained verbatim.
 * @returns the inclusive span, or `undefined` when nothing safe is compactable.
 */
export function selectRange(session, nodes, retainTokens) {
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

  return { start: nodes[firstIdx].seq, end: nodes[keepFrom - 1].seq }
}
