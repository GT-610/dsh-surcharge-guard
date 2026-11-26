/** Browser settings for the surcharge guard bundle. */
window.__ModuleLoader__.load({
  id: 'dsh-surcharge-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-surcharge-guard'

    const zh = {
      "intro": "按服务商和模型设置长上下文加价阈值。插件会在请求前估算用量并压缩历史；到线时会拦住请求，但估算本身仍可能偏低。",
      "enabled": "启用计费保护",
      "enabledHint": "关闭后所有规则停止生效，已有配置保留。",
      "enforceLine": "硬红线",
      "enforceLineHint": "估算已到加价线时，先剪工具结果、再强制深折；仍然压不下去就拦住这一步，不再发出可能双倍计费的请求。",
      "margin": "安全余量",
      "marginHint": "在加价线以下多少 token 触发压缩。余量越大，触发越早。",
      "retain": "保留比例",
      "retainHint": "近期历史的保留上限，按触发线的比例计算（0.01–0.9）；缺口大时会压得更深。",
      "maxAttempts": "摘要次数上限",
      "maxAttemptsHint": "计的是失败或没有降低压力的尝试；成功压缩后重新计数。每个步骤最多一次，0 表示完全关闭保护和红线。",
      "rules": "规则",
      "rulesEmpty": "还没有规则。用下面的按钮按家族批量添加，或手动添加单条。",
      "colProvider": "服务商",
      "colModel": "模型",
      "colLine": "加价阈值",
      "colWindow": "上下文窗口",
      "colStatus": "状态",
      "colActions": "操作",
      "on": "已启用",
      "off": "已停用",
      "cap": "到线前触发于",
      "remove": "移除",
      "enableAll": "全部启用",
      "disableAll": "全部停用",
      "rulesSummary": "已启用 {on}/{total}",
      "addTitle": "一键添加",
      "addHint": "按模型家族预填建议阈值。新增规则默认启用；预填的阈值只是建议值，请按具体服务商的定价核对后调整。",
      "addFamily": "预填 {family} 规则",
      "addManual": "手动添加规则",
      "scan": "重新扫描模型",
      "scanning": "正在读取模型目录…",
      "noModels": "没有读到任何模型。请确认已在「模型」设置里配置服务商。",
      "saving": "正在保存。请等待保存完成后，再点击规则操作按钮。",
      "thresholdSaved": "阈值已保存。若要启用或停用规则，请另行点击对应按钮。",
      "saveFailed": "保存失败",
      "notWritable": "当前配置层不可写，请检查 profile 配置。",
      "loading": "正在加载…",
      "loadFailed": "模型目录读取失败",
      "familyGpt": "GPT",
      "familyGemini": "Gemini",
      "familyGrok": "Grok",
      "noCatalog": "实时模型目录不可用，仍可手动添加规则。",
      "dormant": "未出现在实时目录",
      "enableRule": "启用",
      "disableRule": "停用",
      "manualHint": "输入准确的服务商和模型 ID，以及该服务商的加价阈值。新增规则默认启用。",
      "manualProvider": "服务商 ID",
      "manualModel": "模型 ID",
      "manualLine": "加价阈值（token）",
      "duplicateRule": "这个服务商和模型已有规则。",
      "invalidManualRule": "请输入服务商 ID、模型 ID 和正整数阈值。",
      "invalidNumber": "数值无效，请检查该字段的取值范围。",
      "summaryModel": "摘要模型",
      "summaryDefault": "沿用现有摘要设置",
      "summaryUnconfirmed": "不在实时目录中",
      "summaryEffort": "摘要推理等级",
      "summaryEffortDefault": "沿用模型默认",
      "summaryEffortUnknown": "实时目录未列出这个摘要模型的推理等级，只能沿用模型默认。",
      "summaryProviderNotice": "待压缩的历史和本次摘要请求的提示、工具定义会发送至 {provider}。主对话模型不变。"
    }

    const en = {
      "intro": "Set a long-context surcharge threshold per provider and model. The guard estimates pressure, compacts history, and blocks a request at the line; the estimate itself can still undercount.",
      "enabled": "Enable surcharge guard",
      "enabledHint": "Turning this off stops every rule; saved rules are kept.",
      "enforceLine": "Hard surcharge line",
      "enforceLineHint": "At the surcharge line, prune tool results and force a deep fold; if the request is still over, block the step instead of sending it.",
      "margin": "Safety margin",
      "marginHint": "Trigger this many tokens below the surcharge line. A larger margin triggers compaction earlier.",
      "retain": "Retain ratio",
      "retainHint": "Ceiling for recent history kept verbatim, as a fraction of the trigger (0.01–0.9); a large gap folds deeper.",
      "maxAttempts": "Summary attempt limit",
      "maxAttemptsHint": "Counts attempts that failed or did not lower the pressure; a helpful fold re-arms it. One fold per step, and 0 disables the guard and its hard line.",
      "rules": "Rules",
      "rulesEmpty": "No rules yet. Add a model family in bulk below, or add one manually.",
      "colProvider": "Provider",
      "colModel": "Model",
      "colLine": "Surcharge threshold",
      "colWindow": "Context window",
      "colStatus": "Status",
      "colActions": "Actions",
      "on": "Enabled",
      "off": "Off",
      "cap": "Triggers at",
      "remove": "Remove",
      "enableAll": "Enable all",
      "disableAll": "Disable all",
      "rulesSummary": "{on}/{total} enabled",
      "addTitle": "Quick add",
      "addHint": "Prefill suggested family thresholds. New rules start enabled; the prefilled threshold is only a suggestion, so check the price for the specific provider.",
      "addFamily": "Prefill {family} rules",
      "addManual": "Add a rule manually",
      "scan": "Rescan models",
      "scanning": "Reading model catalog…",
      "noModels": "No models found. Make sure a provider is configured under Models.",
      "saving": "Saving settings. Wait for the save to finish, then click the rule action again.",
      "thresholdSaved": "Threshold saved. To enable or disable the rule, click its action button separately.",
      "saveFailed": "Save failed",
      "notWritable": "This configuration layer is not writable. Check the profile configuration.",
      "loading": "Loading…",
      "loadFailed": "Could not read the model catalog",
      "familyGpt": "GPT",
      "familyGemini": "Gemini",
      "familyGrok": "Grok",
      "noCatalog": "The live model catalog is unavailable. You can still add rules manually.",
      "dormant": "Not in the live catalog",
      "enableRule": "Enable",
      "disableRule": "Disable",
      "manualHint": "Enter the exact provider and model IDs and the provider’s surcharge threshold. New rules start enabled.",
      "manualProvider": "Provider ID",
      "manualModel": "Model ID",
      "manualLine": "Surcharge threshold (tokens)",
      "duplicateRule": "A rule already exists for this provider and model.",
      "invalidManualRule": "Enter a provider ID, a model ID, and a positive whole-token threshold.",
      "invalidNumber": "Invalid number. Check the allowed range for this field.",
      "summaryModel": "Summary model",
      "summaryDefault": "Use existing summary settings",
      "summaryUnconfirmed": "Not in the live catalog",
      "summaryEffort": "Summary reasoning effort",
      "summaryEffortDefault": "Use the model default",
      "summaryEffortUnknown": "The live catalog lists no reasoning effort for this summary model, so only its default is available.",
      "summaryProviderNotice": "The selected history and this summary request's prompts and tool definitions are sent to {provider}. The chat model stays the same."
    }

    const FAMILIES = [
      { id: 'gpt', surchargeAtTokens: 272000 },
      { id: 'gemini', surchargeAtTokens: 200000 },
      { id: 'grok', surchargeAtTokens: 200000 },
    ]
    const NAMESPACES = [`include:${NS}`, NS]
    const PROVIDER_NAMESPACES = ['include:llm-pi-ai', 'llm-pi-ai']
    const EMPTY_SNAPSHOT = { status: 'unavailable', writable: false }
    const NO_SUBSCRIBE = () => () => {}
    const ruleKey = ({ provider, model }) => JSON.stringify([provider, model])

    function formatTokens(value) {
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${Math.round(value / 1e3)}K`
      return String(value)
    }

    function parseTokens(text, min = 0) {
      const match = /^(\d+(?:\.\d+)?|\.\d+)([km]?)$/i.exec(text.trim().replace(/[,_]/g, ''))
      if (!match) return undefined
      const suffix = match[2].toLowerCase()
      const places = suffix === 'm' ? 6 : suffix === 'k' ? 3 : 0
      const [whole, fraction = ''] = match[1].split('.')
      if (/[1-9]/.test(fraction.slice(places))) return undefined
      const value = Number(whole + fraction.slice(0, places).padEnd(places, '0'))
      return Number.isSafeInteger(value) && value >= min ? value : undefined
    }

    function parseRatio(text) {
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text.trim())) return undefined
      const value = Number(text)
      return value >= 0.01 && value <= 0.9 ? value : undefined
    }

    function getOptional(ctx, key) {
      try { return ctx.get(key) } catch { return undefined }
    }

    function lookupForm(service, namespace) {
      try { return service?.get(namespace) } catch { return undefined }
    }

    function useNamespaceForm(service, [first, second]) {
      const a = lookupForm(service, first)
      const b = lookupForm(service, second)
      const aSnapshot = useStore(a)
      const bSnapshot = useStore(b)
      if (aSnapshot.status === 'ready' || (aSnapshot.status === 'loading' && bSnapshot.status !== 'ready')) {
        return [a, aSnapshot]
      }
      return [b, bSnapshot]
    }

    function useStore(store) {
      const subscribe = React.useCallback(listener => store === undefined ? NO_SUBSCRIBE() : store.subscribe(listener), [store])
      const snapshot = React.useCallback(() => store?.getSnapshot() ?? EMPTY_SNAPSHOT, [store])
      return React.useSyncExternalStore(subscribe, snapshot)
    }

    /** The styles; only `--dsw-alias-*` tokens, so light/dark follows the host. */
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.5,
      },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)', maxWidth: '760px' },
      group: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
      },
      groupTitle: { fontSize: '13px', fontWeight: 600, margin: 0 },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: '12px',
        rowGap: '4px',
      },
      label: { color: 'var(--dsw-alias-label-secondary)' },
      control: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
      field: {
        minWidth: '140px',
        maxWidth: '220px',
        flex: '1 1 140px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        padding: '5px 8px',
        font: 'inherit',
        fontVariantNumeric: 'tabular-nums',
      },
      hint: { color: 'var(--dsw-alias-label-secondary)', margin: 0, gridColumn: '2 / -1' },
      error: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
      button: {
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        padding: '5px 10px',
        font: 'inherit',
        cursor: 'pointer',
      },
      danger: {
        borderColor: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: {
        textAlign: 'left',
        padding: '5px 8px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'middle',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
      empty: {
        margin: 0,
        padding: '14px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: '8px',
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
      off: { opacity: 0.5 },
    }

    /** A colored dot so the rule's state reads before the label does. */
    function statusDot(on) {
      return {
        flex: '0 0 auto',
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
      }
    }

    /** One labeled field row. */
    function Row({ label, hint, children }) {
      return h('div', { style: styles.row },
        h('span', { style: styles.label }, label),
        h('div', { style: styles.control }, children),
        hint === undefined ? null : h('p', { style: styles.hint }, hint),
      )
    }

    /** A switch that behaves like the host's. */
    function Toggle({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => onChange(!checked),
        style: {
          position: 'relative',
          flex: '0 0 auto',
          width: '36px',
          height: '20px',
          padding: 0,
          borderRadius: '999px',
          border: `1px solid ${checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-base)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          top: '2px',
          left: checked ? '18px' : '2px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: checked ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
        },
      }))
    }

    /** Keep display rounding out of the draft; no edit means no profile write. */
    function NumericInput({ label, value, onCommit, disabled, parse = parseTokens, format = formatTokens, invalid }) {
      const [editing, setEditing] = React.useState(null)
      const dirty = React.useRef(false)
      return h('input', {
        type: 'text', inputMode: 'decimal', value: editing ?? format(value), disabled,
        'aria-label': label, style: styles.field,
        onFocus: () => { dirty.current = false; setEditing(String(value)) },
        onChange: event => { dirty.current = true; setEditing(event.target.value) },
        onBlur: () => {
          setEditing(null)
          if (!dirty.current) return
          dirty.current = false
          const parsed = parse(editing ?? String(value))
          if (parsed === undefined) invalid()
          else if (parsed !== value) void onCommit(parsed)
        },
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      })
    }

    /** The catalog offers only models that can actually be routed now. */
    function liveModels(rows) {
      return [...rows.values()].filter(row => row.dormant !== true)
    }

    /**
     * Pick the reasoning effort for the model that writes summaries.
     *
     * The choice belongs to a chosen summary route, so it is offered only
     * while one is set: the session's own summary settings keep their effort.
     * A saved effort the catalog no longer advertises stays visible and
     * selectable rather than being silently rewritten.
     *
     * An empty list has several causes — the catalog is still loading, it
     * failed, or the route is not listed at all — and only the last one is
     * about the model, so the hint is reserved for a route the live catalog
     * actually described.
     */
    function SummaryEffortSelect({ t, rule, rows, disabled, onChange }) {
      const id = React.useId()
      // The schema allows a stored `null`; only an absent route means "no override".
      const target = rule.summaryTarget ?? undefined
      if (target === undefined) return null
      const row = rows.get(ruleKey(target))
      const efforts = Array.isArray(row?.efforts) ? row.efforts : []
      const value = target.reasoningEffort ?? ''
      const known = value === '' || efforts.some(effort => effort.id === value)
      // Only claim the model offers no levels when the live catalog answered
      // for this exact route; a loading, failed or undiscovered route says
      // nothing about its capabilities.
      const described = row?.described === true
      return h('div', { style: { marginTop: '6px', maxWidth: '240px' } },
        h('label', { htmlFor: id, style: styles.label }, t('summaryEffort')),
        h('select', {
          id,
          'aria-label': `${t('summaryEffort')} ${target.provider}/${target.model}`,
          value,
          disabled,
          style: { ...styles.field, minWidth: 0, width: '100%', maxWidth: '100%' },
          onChange: event => onChange(event.target.value),
        },
        h('option', { value: '' }, t('summaryEffortDefault')),
        known ? null : h('option', { value }, `${value} (${t('summaryUnconfirmed')})`),
        ...efforts.map(effort => h('option', {
          key: effort.id, value: effort.id, title: effort.description,
        }, effort.name)),
        ),
        described && efforts.length === 0 ? h('p', { style: styles.hint }, t('summaryEffortUnknown')) : null,
      )
    }

    /**
     * Pick the model that writes summaries for one rule.
     *
     * A saved route that has left the catalog stays visible and selectable so
     * the setting is never silently rewritten; choosing the first option drops
     * the override and returns to the session's own summary settings.
     */
    function SummaryModelSelect({ t, rule, candidates, disabled, onChange }) {
      const id = React.useId()
      // The schema allows a stored `null`; only an absent route means "no override".
      const target = rule.summaryTarget ?? undefined
      const value = target === undefined ? '' : ruleKey(target)
      const known = target === undefined
        || candidates.some(row => row.provider === target.provider && row.model === target.model)
      const crossProvider = target !== undefined && target.provider !== rule.provider
      return h('div', { style: { marginTop: '6px', maxWidth: '240px' } },
        h('label', { htmlFor: id, style: styles.label }, t('summaryModel')),
        h('select', {
          id,
          'aria-label': `${t('summaryModel')} ${rule.provider}/${rule.model}`,
          'aria-describedby': crossProvider ? `${id}-notice` : undefined,
          value,
          disabled,
          style: { ...styles.field, minWidth: 0, width: '100%', maxWidth: '100%' },
          onChange: event => onChange(event.target.value),
        },
        h('option', { value: '' }, t('summaryDefault')),
        known ? null : h('option', { value }, `${target.model} · ${target.provider} (${t('summaryUnconfirmed')})`),
        ...candidates.map(row => h('option', {
          key: ruleKey(row), value: ruleKey(row), title: `${row.provider}/${row.model}`,
        }, `${row.model} · ${row.provider}`)),
        ),
        crossProvider ? h('p', { id: `${id}-notice`, style: styles.hint },
          t('summaryProviderNotice').replace('{provider}', () => target.provider)) : null,
      )
    }

    function modelFamily(model) {
      if (/(^|[-_/:])gpt(?=$|[-_/:0-9])/i.test(model)) return 'gpt'
      if (/(^|[-_/:])gemini(?=$|[-_/:0-9])/i.test(model)) return 'gemini'
      if (/(^|[-_/:])grok(?=$|[-_/:0-9])/i.test(model)) return 'grok'
      return undefined
    }

    function remoteOf(ctx) {
      for (const key of ['remote.session', 'remote']) {
        const candidate = getOptional(ctx, key)
        const session = candidate?.session ?? candidate
        if (typeof session?.modelCatalog === 'function') return session
      }
      return undefined
    }

    async function loadCatalog(ctx) {
      const remote = remoteOf(ctx)
      if (typeof remote?.modelCatalog !== 'function') return { unavailable: true, groups: [], failures: [] }
      try {
        const result = await remote.modelCatalog()
        if (result?.ok !== true) {
          return { failed: true, reason: result?.error?.message, groups: [], failures: [] }
        }
        const { groups = [], failures = [] } = result.value ?? {}
        return { groups, failures }
      } catch (error) {
        return { failed: true, reason: String(error?.message ?? error), groups: [], failures: [] }
      }
    }

    function mergeCatalog(providers, live) {
      const rows = new Map()
      const unknownProviders = new Set(live.failures.map(failure => failure.id))
      for (const [provider, profile] of Object.entries(providers ?? {})) {
        for (const { id: model, contextWindow } of profile?.models ?? []) {
          if (typeof model !== 'string') continue
          const row = { provider, model, contextWindow,
            dormant: live.status === 'ready' && !live.failed && !live.unavailable && !unknownProviders.has(provider) }
          rows.set(ruleKey(row), row)
        }
      }
      for (const { id: provider, models } of live.groups) {
        if (typeof provider !== 'string') continue
        for (const { id: model, reasoning } of models ?? []) {
          if (typeof model !== 'string') continue
          const key = ruleKey({ provider, model })
          // Only the live catalog reports efforts; a configured model keeps
          // whatever the host generation advertised, or none. `described`
          // records that the catalog really spoke about this route, so an
          // absent effort list can be reported as "this model offers none"
          // rather than guessed from a catalog that never answered.
          const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : undefined
          rows.set(key, {
            ...rows.get(key), provider, model, dormant: false, described: true,
            ...(efforts === undefined ? {} : { efforts }),
          })
        }
      }
      return rows
    }

    function useCatalog(ctx) {
      const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], failures: [] })
      const version = React.useRef(0)
      const reload = React.useCallback(async () => {
        const current = ++version.current
        setCatalog(value => ({ ...value, status: 'loading' }))
        const result = await loadCatalog(ctx)
        if (current === version.current) setCatalog({ status: 'ready', ...result })
      }, [ctx])
      React.useEffect(() => {
        void reload()
        return () => { version.current += 1 }
      }, [reload])
      return [catalog, reload]
    }

    function Panel({ t, ctx, form }) {
      const forms = getOptional(ctx, 'configForms')
      const [store, storedSnapshot] = useNamespaceForm(form === undefined ? forms : undefined, NAMESPACES)
      const [, declared] = useNamespaceForm(forms, PROVIDER_NAMESPACES)
      const snapshot = form?.state ?? storedSnapshot
      const [catalog, reloadCatalog] = useCatalog(ctx)
      const [notice, setNotice] = React.useState(null)
      const [writeStatus, setWriteStatus] = React.useState(null)
      const writeInFlight = React.useRef(false)
      const [draft, setDraft] = React.useState({ provider: '', model: '', threshold: '' })
      const rows = React.useMemo(() => mergeCatalog(declared.value?.providers, catalog), [declared.value, catalog])
      const rules = snapshot.value?.rules ?? []
      const onCount = rules.filter(entry => entry.enabled !== false).length
      const allOn = rules.length > 0 && onCount === rules.length
      const enabled = snapshot.value?.enabled !== false
      const enforceLine = snapshot.value?.enforceLine !== false
      const margin = snapshot.value?.safetyMarginTokens ?? 20000
      const retain = snapshot.value?.retainRatio ?? 0.16
      const maxAttempts = snapshot.value?.maxAttempts ?? 2
      const writable = snapshot.writable === true
      const disabled = !writable || writeStatus === 'saving'
      const invalid = () => {
        setWriteStatus(current => current === 'thresholdSaved' ? null : current)
        setNotice(t('invalidNumber'))
      }

      if (snapshot.status === 'loading') return h('p', { style: styles.intro }, t('loading'))
      if (snapshot.status !== 'ready') return h('p', { style: styles.error }, t('notWritable'))

      async function write(field, value, successStatus = null) {
        const target = form ?? store
        if (!writable || writeInFlight.current) return false
        writeInFlight.current = true
        setWriteStatus('saving')
        setNotice(null)
        let status = null
        try {
          const accepted = await target.mutate([{ op: 'set', path: [field], value }], snapshot.revision)
          if (accepted) status = successStatus
          else setNotice(t('saveFailed'))
          return accepted
        } catch (error) {
          setNotice(`${t('saveFailed')}: ${String(error?.message ?? error)}`)
          return false
        } finally {
          writeInFlight.current = false
          setWriteStatus(status)
        }
      }

      const existing = new Set(rules.map(ruleKey))
      const missingByFamily = new Map(FAMILIES.map(family => [family.id, []]))
      for (const [key, row] of rows) {
        if (!existing.has(key)) missingByFamily.get(modelFamily(row.model))?.push(row)
      }
      const draftInput = (key, label) => h('input', {
        type: 'text', style: styles.field, disabled, value: draft[key],
        'aria-label': t(label), placeholder: t(label),
        onChange: event => { const { value } = event.target; setDraft(current => ({ ...current, [key]: value })) },
      })

      async function addManual() {
        const provider = draft.provider.trim()
        const model = draft.model.trim()
        const surchargeAtTokens = parseTokens(draft.threshold, 1)
        if (!provider || !model || surchargeAtTokens === undefined) {
          setNotice(t('invalidManualRule'))
          return
        }
        const rule = { provider, model, surchargeAtTokens, enabled: true }
        if (existing.has(ruleKey(rule))) {
          setNotice(t('duplicateRule'))
          return
        }
        if (await write('rules', [...rules, rule])) setDraft({ provider: '', model: '', threshold: '' })
      }

      const editRule = (key, update, successStatus) => write('rules',
        rules.map(rule => ruleKey(rule) === key ? { ...rule, ...update } : rule), successStatus)

      /** Replace or drop one rule's summary route without touching its guard. */
      const setSummaryTarget = (key, next) => write('rules', rules.map(rule => {
        if (ruleKey(rule) !== key) return rule
        const { summaryTarget: _, ...rest } = rule
        if (next === undefined) return rest
        // Efforts are route-owned, so a different route starts from its own
        // default rather than inheriting one the previous model happened to offer.
        const previous = rule.summaryTarget
        const sameRoute = previous?.provider === next.provider && previous?.model === next.model
        const kept = sameRoute && typeof previous.reasoningEffort === 'string' && previous.reasoningEffort !== ''
          ? previous.reasoningEffort
          : undefined
        return { ...rest, summaryTarget: kept === undefined ? next : { ...next, reasoningEffort: kept } }
      }))
      /** Set or clear one rule's summary effort without touching its route. */
      const setSummaryEffort = (key, reasoningEffort) => write('rules', rules.map(rule => {
        if (ruleKey(rule) !== key || rule.summaryTarget === undefined || rule.summaryTarget === null) return rule
        const { reasoningEffort: _, ...target } = rule.summaryTarget
        return { ...rule, summaryTarget: reasoningEffort === '' ? target : { ...target, reasoningEffort } }
      }))
      const scalarRow = (label, hint, value, field, parse, format) => h(Row, { label: t(label), hint: t(hint) },
        h(NumericInput, { label: t(label), disabled, value, parse, format, invalid, onCommit: next => write(field, next) }),
      )
      const providerFailures = catalog.failures.map(failure => `${failure.name ?? failure.id}: ${failure.message}`).join('; ')
      const issue = catalog.failed || providerFailures ? [t('loadFailed'), catalog.reason ?? providerFailures].filter(Boolean).join(': ') : null
      const summaryCandidates = liveModels(rows)

      return h('div', { style: styles.root },
        h('p', { style: styles.intro }, t('intro')),
        notice === null ? null : h('p', { role: 'alert', style: styles.error }, notice),
        writable ? null : h('p', { style: styles.error }, t('notWritable')),
        h('div', { style: styles.group },
          h(Row, { label: t('enabled'), hint: t('enabledHint') },
            h(Toggle, { label: t('enabled'), checked: enabled, disabled, onChange: next => write('enabled', next) })),
          h(Row, { label: t('enforceLine'), hint: t('enforceLineHint') },
            h(Toggle, { label: t('enforceLine'), checked: enforceLine, disabled, onChange: next => write('enforceLine', next) })),
          scalarRow('margin', 'marginHint', margin, 'safetyMarginTokens'),
          scalarRow('retain', 'retainHint', retain, 'retainRatio', parseRatio, String),
          scalarRow('maxAttempts', 'maxAttemptsHint', maxAttempts, 'maxAttempts', parseTokens, String),
        ),
        h('div', { style: styles.group },
          h('div', { style: styles.actions },
            h('h4', { style: styles.groupTitle }, t('rules')),
            rules.length === 0 ? null : h('span', { style: styles.intro },
              t('rulesSummary').replace('{on}', String(onCount)).replace('{total}', String(rules.length))),
            h('span', { role: 'status', style: styles.intro }, writeStatus === null ? null : t(writeStatus)),
            // One switch for the whole list: the common case is enabling the
            // rules just prefilled, or silencing all of them at once.
            rules.length === 0 ? null : h('button', {
              type: 'button', disabled, style: styles.button,
              onClick: () => write('rules', rules.map(entry => ({ ...entry, enabled: !allOn }))),
            }, t(allOn ? 'disableAll' : 'enableAll')),
          ),
          rules.length === 0 ? h('p', { style: styles.empty }, t('rulesEmpty')) :
            h('table', { style: styles.table },
              h('thead', null, h('tr', null, ...['colProvider', 'colModel', 'colLine', 'cap', 'colStatus', 'colActions']
                .map(key => h('th', { key, scope: 'col', style: styles.th }, t(key))))),
              h('tbody', null, ...rules.map(rule => {
                const key = ruleKey(rule)
                const row = rows.get(key)
                const state = rule.enabled !== false
                const details = [
                  row?.contextWindow === undefined ? null : `${t('colWindow')} ${formatTokens(row.contextWindow)}`,
                  row?.dormant ? t('dormant') : null,
                ].filter(Boolean)
                return h('tr', { key },
                  h('td', { style: { ...styles.td, ...styles.mono } }, h('span', { style: state ? null : styles.off }, rule.provider)),
                  h('td', { style: styles.td },
                    h('span', { style: state ? null : styles.off }, rule.model),
                    details.length ? h('div', { style: styles.hint }, details.join(' · ')) : null,
                    h(SummaryModelSelect, {
                      t, rule, candidates: summaryCandidates, disabled,
                      onChange: selection => {
                        // The option value is the catalog key; the config stores an object.
                        const [provider, model] = selection === '' ? [] : JSON.parse(selection)
                        setSummaryTarget(key, provider === undefined ? undefined : { provider, model })
                      },
                    }),
                    h(SummaryEffortSelect, {
                      t, rule, rows, disabled,
                      onChange: reasoningEffort => setSummaryEffort(key, reasoningEffort),
                    }),
                  ),
                  h('td', { style: styles.td }, h(NumericInput, {
                    label: `${t('colLine')} ${rule.provider}/${rule.model}`,
                    value: rule.surchargeAtTokens, disabled, invalid, parse: text => parseTokens(text, 1),
                    onCommit: surchargeAtTokens => editRule(key, { surchargeAtTokens }, 'thresholdSaved'),
                  })),
                  h('td', { style: styles.td }, formatTokens(Math.max(1, rule.surchargeAtTokens - margin))),
                  // State lives with the switch that changes it: a label in one
                  // column and a button in another made "on" and "off" easy to mix up.
                  h('td', { style: styles.td }, h('div', { style: styles.actions },
                    h('span', { style: styles.badge },
                      h('span', { 'aria-hidden': true, style: statusDot(state) }),
                      t(state ? 'on' : 'off')),
                    h(Toggle, {
                      // The name states the action this switch performs, so the
                      // state is never ambiguous to a reader that cannot see it.
                      label: `${t(state ? 'disableRule' : 'enableRule')} ${rule.provider}/${rule.model}`,
                      checked: state, disabled,
                      onChange: next => editRule(key, { enabled: next }),
                    }),
                  )),
                  h('td', { style: styles.td }, h('button', { type: 'button', disabled,
                    style: { ...styles.button, ...styles.danger },
                    onClick: () => write('rules', rules.filter(entry => ruleKey(entry) !== key)) }, t('remove'))),
                )
              })),
            ),
        ),
        h('div', { style: styles.group },
          h('h4', { style: styles.groupTitle }, t('addTitle')),
          h('p', { style: styles.intro }, t('addHint')),
          catalog.status === 'loading' ? h('p', { style: styles.intro }, t('scanning')) : null,
          issue === null ? null : h('p', { role: 'alert', style: styles.error }, issue),
          catalog.status === 'ready' && issue === null && (catalog.unavailable || rows.size === 0)
            ? h('p', { style: styles.intro }, t(catalog.unavailable ? 'noCatalog' : 'noModels')) : null,
          h('div', { style: styles.actions },
            ...FAMILIES.map(({ id, surchargeAtTokens }) => {
              const found = missingByFamily.get(id)
              const label = t(`family${id[0].toUpperCase()}${id.slice(1)}`)
              return h('button', {
                key: id, type: 'button', style: styles.button,
                disabled: disabled || found.length === 0,
                onClick: () => write('rules', [...rules, ...found.map(({ provider, model }) => ({
                  provider, model, surchargeAtTokens, enabled: true,
                }))]),
              }, `${t('addFamily').replace('{family}', label)} (${found.length})`)
            }),
            h('button', { type: 'button', style: styles.button, onClick: reloadCatalog }, t('scan')),
          ),
          h('h4', { style: styles.groupTitle }, t('addManual')),
          h('p', { style: styles.intro }, t('manualHint')),
          h('div', { style: styles.actions },
            draftInput('provider', 'manualProvider'), draftInput('model', 'manualModel'), draftInput('threshold', 'manualLine'),
            h('button', { type: 'button', disabled, style: styles.button, onClick: addManual }, t('addManual')),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'surcharge-guard: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: NS, locale: NS,
        }, props => h(Panel, { t: props.t ?? t, ctx, form: props.form })))
      },
    }
  },
})
