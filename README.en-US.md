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
| Keep more recent history | Raise the retain ratio within `0.01–0.9` |
| Limit compaction attempts per turn | Set the summary attempt limit, default `2`; `0` disables guard compaction |
| Pause protection without removing rules | Turn the master switch off |

Thresholds and margins accept values such as `272000`, `272K`, and `1.05M`. Changes apply to subsequent steps without restarting the plugin.

## Limitations

- This is **best-effort protection, not a billing cap**. The guard estimates committed history and messages admitted for the step. Later prompt updates, tool definitions, attachment pricing, retries, and provider counts can differ.
- If there is no safe range, summarization fails, or the estimate remains above the line, the original request is not blocked. The session's DSH backend runs compaction, and its summary request may incur charges. The guard's attempt limit does not cap DSH's built-in compaction or internal backend retries.

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
