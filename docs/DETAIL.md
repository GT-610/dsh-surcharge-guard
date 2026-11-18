# dsh-surcharge-guard

Some providers charge more for long prompts even when the request still fits the model's context window. Set a surcharge threshold for the exact provider and model without altering the context window.

## Configure protection

Open **Plugins → Surcharge guard**. Enter a rule manually, or prefill suggestions for matching GPT, Gemini, or Grok model IDs. New rules start off. Confirm the threshold against your provider's pricing before turning a rule on.

The guard starts checking at `max(1, surcharge threshold − safety margin)`. A larger margin triggers earlier. The retain ratio sets a recent-history budget as a fraction of that trigger. The summary attempt limit applies to the current turn; `0` disables guard compaction.

## What happens before a step

The guard matches the selected route, measures the committed history, and adds an estimate for the messages admitted for that step. It delegates to the agent preset's compaction service (or a root backend where applicable), preserves the leading system message and tool pairs, and measures again after each successful summary. Only the backend records compaction events.

The estimate is not the final provider token count. If the history cannot be compacted enough, the guard leaves the step decision unchanged and reports the problem in the host log. A separate summary request can incur charges. The attempt limit does not cover native DSH compaction or the backend's internal retries.
