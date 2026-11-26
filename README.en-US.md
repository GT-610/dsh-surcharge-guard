[中文](README.md)

# dsh-surcharge-guard

Set a long-context surcharge threshold per provider and model in DeepSeek Harness (DSH). The guard compacts history near that threshold and refuses to dispatch a request that could be billed at the higher rate, without changing the model's context window.

## Usage

After enabling the plugin, open **Plugins → Surcharge guard**:

1. Use “Prefill GPT rules”, “Prefill Gemini rules”, or another family button to add suggestions, or enter the provider and model IDs manually. New rules start enabled.
2. Check the surcharge threshold against the specific provider's pricing and edit it where they differ. Prefills are not verified provider rates.
3. Keep the master switch on. “Triggers at” shows the surcharge threshold minus the safety margin, with a minimum of one token.
4. New rules start enabled, so a rule takes effect as soon as it is added; the prefilled threshold is only a suggestion, so check it against the provider's pricing. The status column is a switch beside an **Enabled / Off** badge, the header shows how many rules are on, and **Enable all / Disable all** handles the whole table.

| Goal | Action |
|---|---|
| Compact earlier | Raise the safety margin; this may spend more on summaries |
| Keep more recent history | Raise the retain ratio within `0.01–0.9`; it is a ceiling, and a large gap folds deeper |
| Treat the line as a hard boundary | Keep **Hard surcharge line** on (the default). Tool results are pruned, a deep fold is forced, and a step that still prices over the line is blocked instead of sent |
| Bound repeated summaries | Set the summary attempt limit, default `2`. It counts attempts that failed or did not lower the pressure; a helpful fold re-arms it. `0` disables guard compaction and the hard line; one step folds at most once |
| Write summaries with a cheaper model | Pick a provider and model under the rule's **Summary model**; choose **Use existing summary settings** to restore the default |
| Spend less on summary reasoning | After choosing a summary model, pick one of its **Summary reasoning effort** levels; **Use the model default** overrides nothing |
| Pause protection without removing rules | Turn the master switch off |

Thresholds and margins accept values such as `272000`, `272K`, and `1.05M`. Changes apply to subsequent steps without restarting the plugin.

## How one fold is chosen

- **One fold per step, with one exception.** Repeating the same fold in a step can only re-summarize the checkpoint the first one wrote: it buys almost nothing and pays for another model call, so a residual gap is reported instead. At the surcharge line the forced fallback may fold once more in the same step, and only to get the request under the line.
- **A helpful fold re-arms protection.** The summary attempt limit counts attempts that failed or did not lower the pressure. A fold that really lowers it resets the count, so a long turn that keeps growing back over the trigger stays protected instead of going quiet for the rest of the turn.
- **Depth follows the gap.** The retain ratio is a ceiling for the verbatim tail, not a fixed budget. When the recorded pressure sits far above the trigger and the tail would keep everything worth folding, the tail shrinks toward its floor so one fold can actually land under the line.
- **The estimate is calibrated per route.** `measure()` reports the last provider count plus new content priced at four characters per token. The guard scales that new part by the ratio observed between provider counts and the heuristic price on the same route, so a fixed denominator cannot quietly consume the safety margin. The ratio only moves up immediately and is released slowly.
- **The surcharge line is a hard boundary.** When a soft-trigger fold leaves the estimate at or above the line, the guard follows native context-overflow recovery: prune tool results without a model call, force one depth-zero fold, and if the request is still over, **refuse to dispatch that step**. The turn ends with an error instead of sending a request that would be billed at the higher rate. A last gate before dispatch reprices the exact messages and tool schemas, covering growth after the pre-step (a refreshed system prompt, late context).
- **No summary of a summary.** A candidate span that holds nothing but the checkpoints earlier folds wrote, or whose reclaim cannot cover the replacement, is not compacted at all.
- **No duplicate fold with native compaction.** If another middleware already replaced this step's surface, the guard does not add a second transaction.

The summary model is used only for compaction triggered by that rule. The chat model, manual compaction, and DSH's own compaction policy keep their settings. If you choose another provider, it receives the selected history and the prompts and tool definitions in that summary request.

The reasoning effort belongs to the summary model: it appears only once a custom summary model is chosen, and switching models returns to that model's own default. Levels come from the live catalog; while it is loading, after it fails to load, or when the model is not listed, no levels are shown and only the model default is available. A saved level the catalog no longer offers stays visible and flagged rather than being silently rewritten.

If the route cannot serve the chosen level at run time, the guard logs a warning and does not run that compaction: no marker is written, no other level is substituted, and the attempt does not count against the summary attempt limit, so one mistyped level cannot disable the rest of the turn. The step itself continues and can still cross the line.

## Limitations

- The hard line guarantees that **the guard never dispatches a request it prices at or above the line**; it cannot guarantee the provider counts it below 272K. The estimate can still undercount: a tokenizer change, tool definitions or attachments expanded at request time, retries, and provider counts can differ, and the calibration comes from requests that already happened. When that happens the step is blocked: run `/compact`, shorten the input, or raise the threshold and continue.
- This is **best-effort protection, not a billing cap**. The guard estimates committed history and messages admitted for the step, and calibrates the new part against the ratio recently observed between provider counts and the heuristic.
- If there is no safe range, summarization fails, or the estimate remains above the trigger but below the line, the original request is not blocked; the guard warns. At the line it applies the hard line above (prune, forced fold, then block). Compaction runs through the session's DSH backend and its summary request may incur charges. The attempt limit does not cap DSH's built-in compaction or internal backend retries, and it never folds the same step twice. When nothing is worth folding, that refusal is reported once per turn rather than on every step.
- A custom summary model needs DSH's Basic compaction backend and enough context capacity. Switching models usually cannot reuse the chat model's prefix cache, so the summary itself may be slower or cost more. If the selected route fails, the guard logs a warning and continues the step without falling back to the original route, and that step can still cross the line.
- A summary reasoning effort applies only to the chosen summary model; DSH's own summary settings, manual compaction, and the chat route keep theirs. Effort names are provider-defined, so the same name need not mean the same thinking budget across models.
- Raising the effort spends part of the summary's output cap rather than a separate allowance. Basic's `maxTokens` covers provider-counted reasoning tokens, and a `max-tokens` finish is treated as a truncated, incomplete checkpoint. The guard inherits that cap from the guarded model's policy, so a small cap combined with a high effort can spend the whole budget on thinking and never finish the summary: that compaction fails, the step continues uncompacted, and the attempt is still spent. The failure reports `truncated at the token cap` rather than blaming the level, and validation cannot catch it because the level is supported — there is simply not enough room left to emit it. Leaving the cap comfortably above the effort's thinking budget avoids it, and the default headroom usually does.

## Development

```sh
pnpm install
pnpm check
```

Tests cover host decisions, range selection, and rendering from the registered settings entry. An installed DSH can also exercise the real compaction transaction with an offline summarizer. Run this from the DSH Desktop terminal:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test tests/installed-host.test.mjs
```

## License

[MIT](LICENSE)
