# Changelog

## Unreleased
- Enforce the surcharge line as a hard boundary. A fold cannot always lower the pressure (a
  failing summary, no safe range, a huge retained head), and the guard used to warn and send the
  request anyway, paying the higher rate. It now follows native context-overflow recovery: prune
  tool results without a model call, force one depth-zero fold that bypasses the attempt budget,
  and if the request is still priced at or above the line, refuse to dispatch the step. The turn
  ends with an error instead of the provider billing the whole request at 2x. A last gate on the
  `llm/stream` waterfall reprices the exact outgoing messages and tools, so growth after the
  pre-step cannot slip through; compaction summaries are exempt. On by default (`enforceLine`),
  and `maxAttempts: 0` disables it with the rest of the guard.
- Keep the adapter's real context window. Setting it to the surcharge line makes native compaction
  fold at `min(window x 0.8, window - maxTokens - 65536)`: a 272K window with a 128K output
  reservation and the default headroom leaves only 78,464 tokens, which is the repeated
  ~78K churn. The surcharge line is a billing boundary, not a model capacity.
- Re-arm the summary attempt budget on a fold that actually lowers the pressure. The limit used
  to be a per-turn counter that only advanced, so two failed (or two successful but later
  outgrown) folds silenced the guard for the rest of a long turn: a real session sat at 320K for
  six requests against a 272K–20K rule. Failures now count toward the limit, a helpful fold
  clears it. The hard line has its own forced fold, so a spent budget never disables protection.
- Calibrate the estimate against the provider's own count. `tokenMeter.measure()` reports the last
  provider count plus new content at four characters per token, so the safety margin was being
  spent by content the provider prices two to three times higher. The guard now reconstructs the
  heuristic price of the anchored history (`surfaceTokens − surfaceDeltaTokens`) and scales the
  surface delta and admitted messages by the observed provider/heuristic ratio, per route and per
  session. A larger observation applies immediately and a smaller one releases slowly.
- Report a spent budget once between attempts instead of on every step.
- Start new rules enabled, from both the family prefill and the manual form. A rule the user just
  configured should be in force; the prefilled threshold is documented as a suggestion to check, and
  a row can still be switched off or silenced with **Disable all**.
- Make a rule's on/off state visible where it is changed: the status column is now a switch with a
  coloured badge, a disabled rule dims its provider and model, and the table header carries one
  **Enable all / Disable all** button plus an enabled count.

- Stop folding the same step twice. The guard now runs one transaction per step and reports a residual gap instead of chasing it, because a second fold can only re-summarize the checkpoint the first one wrote. It also leaves a step alone when another middleware already replaced the surface: native pressure compaction runs in the same pre-step chain, so the guard was stacking a second summary on top of it.
- Choose the verbatim tail from the gap instead of a fixed fraction of the trigger. `retentionBudget` narrows the tail toward its floor when the recorded pressure sits far above the trigger, so one fold can land under the line; `foldFloor` prices the replacement checkpoint and the minimum reclaim that makes a fold worth a model call.
- Refuse folds that cannot pay for themselves: a span holding nothing but earlier checkpoints, or one whose reclaim does not cover its replacement, is now refused and reported rather than summarized. This is the "one record, ~2812 tokens" second row in the transcript.
- Report a refused fold once per turn. A refusal deliberately spends no attempt, so a persistent
  phantom pressure used to repeat the same warning on every step of the turn.
- Document the mechanism in [`docs/compact-twice-investigation.md`](docs/compact-twice-investigation.md): provider-usage pressure against heuristic thresholds, the tail that hides the foldable prefix, and the retry that rewrote the checkpoint.

- Document that raising a summary reasoning effort spends the summary's output cap, not a separate allowance, and that a small `maxTokens` plus a high effort fails as a truncated checkpoint rather than an unsupported level. No behaviour changes; the failure path is the backend's, and the guard's pre-flight cannot see it.
- Fix the comment on `withSummaryEffort`: schemastery passes unknown keys through, so the reason Basic cannot carry an effort is its own `resolveConfig` rejecting them, not the schema.
- Add an optional summary reasoning effort per rule. It applies only to a rule's chosen summary model, so the chat route, manual compaction and DSH's own summary settings keep their efforts. The effort is validated through `llm.resolveCallConfig` before a transaction opens: an unsupported level warns and that compaction never runs, without falling back and without spending an attempt. Because Basic cannot carry the field, the effort is bound to the isolated backend's `llm` service inside its per-transaction realm, leaving the shared service untouched. The settings page lists the levels the live catalog advertises for the chosen model and keeps a saved level that has left the catalog visible and flagged.
- Add an optional summary model per rule. A rule can name the provider and model that writes its summaries; the chat model, manual compaction and DSH's own policy keep their settings. The route runs through a separate Basic backend in its own `compaction` realm for that transaction, so concurrent sessions never share or overwrite it. A backend that does not take Basic's summary settings is reported instead of being replaced, and a failed route warns without falling back.
- Estimate pressure for the selected step route and the messages admitted by other pre-step middleware. Remeasure after summaries, warn about unresolved pressure, and leave the original step decision unchanged.
- Enforce a per-turn compaction attempt budget. Zero disables guard compaction, and an unavailable range does not spend an attempt.
- Preserve exact numeric settings, expose retention, and support manual rule entry.
- Distinguish catalog failures from an empty catalog and keep configured models available when a live provider is unavailable.
- Remove the unreachable bundle-list summary, browser test exports, and unused host family helpers. The `./logic` subpath still exposes normalization and range selection.

## 0.1.0

- Add an explicit `surchargeAtTokens` value for each provider and model.
- Configure rules under **Plugins → Surcharge guard**.
- Use the session's compaction backend with tool-pair-safe range selection and preserve the leading system message.
