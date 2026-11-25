# Changelog

## Unreleased
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
