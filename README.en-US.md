[中文](README.md)

# dsh-surcharge-guard

Set a long-context surcharge threshold per provider and model in DeepSeek Harness (DSH). The guard tries to compact history near that threshold without changing the model's context window.

## Usage

After enabling the plugin, open **Plugins → Surcharge guard**:

1. Use “Prefill GPT rules”, “Prefill Gemini rules”, or another family button to add suggestions, or enter the provider and model IDs manually. New rules start off.
2. Check the specific provider's pricing, correct the surcharge threshold, then enable each rule. Prefills are not verified provider rates.
3. Keep the master switch on. “Triggers at” shows the surcharge threshold minus the safety margin, with a minimum of one token.

| Goal | Action |
|---|---|
| Compact earlier | Raise the safety margin; this may spend more on summaries |
| Keep more recent history | Raise the retain ratio within `0.01–0.9`; it is a ceiling, and a large gap folds deeper |
| Limit compaction attempts per turn | Set the summary attempt limit, default `2`; `0` disables guard compaction, and one step folds at most once |
| Write summaries with a cheaper model | Pick a provider and model under the rule's **Summary model**; choose **Use existing summary settings** to restore the default |
| Spend less on summary reasoning | After choosing a summary model, pick one of its **Summary reasoning effort** levels; **Use the model default** overrides nothing |
| Pause protection without removing rules | Turn the master switch off |

Thresholds and margins accept values such as `272000`, `272K`, and `1.05M`. Changes apply to subsequent steps without restarting the plugin.

## How one fold is chosen

- **One fold per step.** A second fold in the same step can only re-summarize the checkpoint the first one wrote: it buys almost nothing and pays for another model call. A residual gap is reported instead.
- **Depth follows the gap.** The retain ratio is a ceiling for the verbatim tail, not a fixed budget. When the recorded pressure sits far above the trigger and the tail would keep everything worth folding, the tail shrinks toward its floor so one fold can actually land under the line.
- **No summary of a summary.** A candidate span that holds nothing but the checkpoints earlier folds wrote, or whose reclaim cannot cover the replacement, is not compacted at all.
- **No duplicate fold with native compaction.** If another middleware already replaced this step's surface, the guard does not add a second transaction.

The summary model is used only for compaction triggered by that rule. The chat model, manual compaction, and DSH's own compaction policy keep their settings. If you choose another provider, it receives the selected history and the prompts and tool definitions in that summary request.

The reasoning effort belongs to the summary model: it appears only once a custom summary model is chosen, and switching models returns to that model's own default. Levels come from the live catalog; while it is loading, after it fails to load, or when the model is not listed, no levels are shown and only the model default is available. A saved level the catalog no longer offers stays visible and flagged rather than being silently rewritten.

If the route cannot serve the chosen level at run time, the guard logs a warning and does not run that compaction: no marker is written, no other level is substituted, and the attempt does not count against the summary attempt limit, so one mistyped level cannot disable the rest of the turn. The step itself continues and can still cross the line.

## Limitations

- This is **best-effort protection, not a billing cap**. The guard estimates committed history and messages admitted for the step. Later prompt updates, tool definitions, attachment pricing, retries, and provider counts can differ.
- If there is no safe range, summarization fails, or the estimate remains above the line, the original request is not blocked. The session's DSH backend runs compaction, and its summary request may incur charges. The guard's attempt limit does not cap DSH's built-in compaction or internal backend retries, and it never folds the same step twice. When nothing is worth folding, that refusal is reported once per turn rather than on every step.
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
