/** Browser settings for the surcharge guard bundle. */
window.__ModuleLoader__.load({
  id: 'dsh-surcharge-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-surcharge-guard'

    const zh = {
      "intro": "按服务商和模型设置长上下文加价阈值。插件会在请求前估算用量并尝试压缩历史，但不能保证不越线。",
      "enabled": "启用计费保护",
      "enabledHint": "关闭后所有规则停止生效，已有配置保留。",
      "margin": "安全余量",
      "marginHint": "在加价线以下多少 token 触发压缩。余量越大，触发越早。",
      "retain": "保留比例",
      "retainHint": "按触发线的比例计算近期历史保留量，范围为 0.01–0.9。",
      "maxAttempts": "摘要次数上限",
      "maxAttemptsHint": "每轮最多发起多少次压缩；0 表示不发起。",
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
      "addTitle": "一键添加",
      "addHint": "按模型家族预填建议阈值。新增规则默认停用，请按具体服务商的定价核对后再启用。",
      "addFamily": "预填 {family} 规则",
      "addManual": "手动添加规则",
      "scan": "重新扫描模型",
      "scanning": "正在读取模型目录…",
      "noModels": "没有读到任何模型。请确认已在「模型」设置里配置服务商。",
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
      "manualHint": "输入准确的服务商和模型 ID，以及该服务商的加价阈值。新增规则默认停用。",
      "manualProvider": "服务商 ID",
      "manualModel": "模型 ID",
      "manualLine": "加价阈值（token）",
      "duplicateRule": "这个服务商和模型已有规则。",
      "invalidManualRule": "请输入服务商 ID、模型 ID 和正整数阈值。",
      "invalidNumber": "数值无效，请检查该字段的取值范围。"
    }

    const en = {
      "intro": "Set a long-context surcharge threshold per provider and model. The guard estimates pressure and tries to compact history before a request, but cannot guarantee it stays below the line.",
      "enabled": "Enable surcharge guard",
      "enabledHint": "Turning this off stops every rule; saved rules are kept.",
      "margin": "Safety margin",
      "marginHint": "Trigger this many tokens below the surcharge line. A larger margin triggers compaction earlier.",
      "retain": "Retain ratio",
      "retainHint": "Fraction of the trigger budget to retain as recent history, from 0.01 to 0.9.",
      "maxAttempts": "Summary attempt limit",
      "maxAttemptsHint": "Maximum compaction attempts per turn. Set to 0 to disable guard compaction.",
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
      "addTitle": "Quick add",
      "addHint": "Prefill suggested family thresholds. New rules are off until you confirm the price for the specific provider and enable them.",
      "addFamily": "Prefill {family} rules",
      "addManual": "Add a rule manually",
      "scan": "Rescan models",
      "scanning": "Reading model catalog…",
      "noModels": "No models found. Make sure a provider is configured under Models.",
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
      "manualHint": "Enter the exact provider and model IDs and the provider’s surcharge threshold. New rules start off.",
      "manualProvider": "Provider ID",
      "manualModel": "Model ID",
      "manualLine": "Surcharge threshold (tokens)",
      "duplicateRule": "A rule already exists for this provider and model.",
      "invalidManualRule": "Enter a provider ID, a model ID, and a positive whole-token threshold.",
      "invalidNumber": "Invalid number. Check the allowed range for this field."
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
        for (const { id: model } of models ?? []) {
          if (typeof model !== 'string') continue
          const key = ruleKey({ provider, model })
          rows.set(key, { ...rows.get(key), provider, model, dormant: false })
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
      const [busy, setBusy] = React.useState(false)
      const writeInFlight = React.useRef(false)
      const [draft, setDraft] = React.useState({ provider: '', model: '', threshold: '' })
      const rows = React.useMemo(() => mergeCatalog(declared.value?.providers, catalog), [declared.value, catalog])
      const rules = snapshot.value?.rules ?? []
      const enabled = snapshot.value?.enabled !== false
      const margin = snapshot.value?.safetyMarginTokens ?? 20000
      const retain = snapshot.value?.retainRatio ?? 0.16
      const maxAttempts = snapshot.value?.maxAttempts ?? 2
      const writable = snapshot.writable === true
      const disabled = !writable || busy
      const invalid = () => setNotice(t('invalidNumber'))

      if (snapshot.status === 'loading') return h('p', { style: styles.intro }, t('loading'))
      if (snapshot.status !== 'ready') return h('p', { style: styles.error }, t('notWritable'))

      async function write(field, value) {
        const target = form ?? store
        if (!writable || writeInFlight.current) return false
        writeInFlight.current = true
        setBusy(true)
        setNotice(null)
        try {
          const accepted = await target.mutate([{ op: 'set', path: [field], value }], snapshot.revision)
          if (!accepted) setNotice(t('saveFailed'))
          return accepted
        } catch (error) {
          setNotice(`${t('saveFailed')}: ${String(error?.message ?? error)}`)
          return false
        } finally {
          writeInFlight.current = false
          setBusy(false)
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
        const rule = { provider, model, surchargeAtTokens, enabled: false }
        if (existing.has(ruleKey(rule))) {
          setNotice(t('duplicateRule'))
          return
        }
        if (await write('rules', [...rules, rule])) setDraft({ provider: '', model: '', threshold: '' })
      }

      const editRule = (key, update) => write('rules', rules.map(rule => ruleKey(rule) === key ? { ...rule, ...update } : rule))
      const scalarRow = (label, hint, value, field, parse, format) => h(Row, { label: t(label), hint: t(hint) },
        h(NumericInput, { label: t(label), disabled, value, parse, format, invalid, onCommit: next => write(field, next) }),
      )
      const providerFailures = catalog.failures.map(failure => `${failure.name ?? failure.id}: ${failure.message}`).join('; ')
      const issue = catalog.failed || providerFailures ? [t('loadFailed'), catalog.reason ?? providerFailures].filter(Boolean).join(': ') : null

      return h('div', { style: styles.root },
        h('p', { style: styles.intro }, t('intro')),
        notice === null ? null : h('p', { role: 'alert', style: styles.error }, notice),
        writable ? null : h('p', { style: styles.error }, t('notWritable')),
        h('div', { style: styles.group },
          h(Row, { label: t('enabled'), hint: t('enabledHint') },
            h(Toggle, { label: t('enabled'), checked: enabled, disabled, onChange: next => write('enabled', next) })),
          scalarRow('margin', 'marginHint', margin, 'safetyMarginTokens'),
          scalarRow('retain', 'retainHint', retain, 'retainRatio', parseRatio, String),
          scalarRow('maxAttempts', 'maxAttemptsHint', maxAttempts, 'maxAttempts', parseTokens, String),
        ),
        h('div', { style: styles.group },
          h('h4', { style: styles.groupTitle }, t('rules')),
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
                  h('td', { style: { ...styles.td, ...styles.mono } }, rule.provider),
                  h('td', { style: styles.td }, rule.model, details.length ? h('div', { style: styles.hint }, details.join(' · ')) : null),
                  h('td', { style: styles.td }, h(NumericInput, {
                    label: `${t('colLine')} ${rule.provider}/${rule.model}`,
                    value: rule.surchargeAtTokens, disabled, invalid, parse: text => parseTokens(text, 1),
                    onCommit: surchargeAtTokens => editRule(key, { surchargeAtTokens }),
                  })),
                  h('td', { style: styles.td }, formatTokens(Math.max(1, rule.surchargeAtTokens - margin))),
                  h('td', { style: styles.td }, t(state ? 'on' : 'off')),
                  h('td', { style: styles.td }, h('div', { style: styles.actions },
                    h('button', { type: 'button', disabled, style: styles.button,
                      onClick: () => editRule(key, { enabled: !state }) }, t(state ? 'disableRule' : 'enableRule')),
                    h('button', { type: 'button', disabled, style: { ...styles.button, ...styles.danger },
                      onClick: () => write('rules', rules.filter(entry => ruleKey(entry) !== key)) }, t('remove')),
                  )),
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
                  provider, model, surchargeAtTokens, enabled: false,
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
