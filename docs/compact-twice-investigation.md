# 为什么 GPT 路由会"一次压缩两条记录"

调查对象：本机 DSH（desktop profile，`~/.dsh`）、`@deepseek-ai/dsh-compaction-basic@0.2.2-rc.3`、`@deepseek-ai/dsh-token-meter`、本插件 `dsh-surcharge-guard`。
证据来源：`~/.dsh/profiles/<profile>/cordis.patch.yml`、asar 内的 `dsh-compaction-basic` / `dsh-token-meter` 源码、`~/.dsh/sessions/**/session.v4.jsonl.zstd`（解压后按 seq 读）。

## 0. 结论

不是 GPT 在"压两次"，而是**同一次 `agent/pre-step` 里连做了两次压缩事务**，第二次折叠的正是第一次刚写下的那条 checkpoint 摘要：

```
3535 compaction/start  turn=25
3536 compaction/summary  shadowed 2980–2987   4 节点   3,213 tok
3537 user/message       source.kind = compact-checkpoint
3538 compaction/end
3539 compaction/start  turn=25              ← 同一步、紧接着
3540 compaction/summary  shadowed 3537       1 节点   2,431 tok
3541 user/message       source.kind = compact-checkpoint（摘要的摘要）
3542 compaction/end
3543 step/start  turn=25 step=2
```

一次本机会话（下称 `PROVIDER/MODEL` 路由，本地时间 15:40:20 / 15:40:35）里这种"成对出现"重复了 6 轮：turn 25 的 step 1、2、3 各一对。

成因是三条叠加，缺一不可：

| 层 | 事实 | 后果 |
|---|---|---|
| 压力口径 | 触发用的 `tokenMeter.measure()` 在 provider 用量 ≥ 启发式锚点时**直接采用 provider 报的 prompt**（`baseline.kind = 'usage'`），而阈值/保留预算/“是否变小”全部用 4 字符/token 的启发式值 | 两条曲线永不收敛：估值 ~88–92K，provider 报 253–310K |
| 选区 | 只保留"最近 16% 预算"的尾巴，从尾部往前累加到预算就停；没有"可压范围里只剩新 checkpoint"的守卫 | 第一次压完，可压前缀只剩 checkpoint → 第二次必然只压 1 条 |
| 重试 | `compaction-basic` 的 `compactionRetries = 1` 就是"压完还在线上再压一次"；本插件 `maxAttempts = 2` 是同一形状，且它在 `next()` 之后跑，原生压过它还会再压 | 一步之内 2 次摘要调用，第二次净收益 ≈ 0 或为负 |

## 1. 数字

该路由：`contextWindow = 1,050,000`、`maxTokens = 128,000`（`llm-pi-ai` 里的声明），原生 `headroomTokens` 默认 65,536。

```
原生（今天）  messageBudget = 1,050,000 − 128,000 = 922,000
              pressureBudget = 922,000 − 65,536 = 856,464
              T = floor(min(1,050,000 × 0.8, 856,464)) = 840,000
              R = floor(922,000 × 0.16) = 147,520
原生（11-17 那次的 450,000 窗口）
              T = 256,464    R = 51,520
本插件        cap = 272,000 − 20,000 = 252,000
              retain = floor(252,000 × 0.16) = 40,320
```

11-17 那次 `T = 256,464`，而 provider 报的 prompt 一直在 **253,200–310,575** 之间抖动 —— 阈值正好卡在幻影压力的下沿，于是每一步都"越线"，每一步都压。

## 2. 为什么第二次只能压 1 条

压完之后 surface 形如 `[system, checkpoint, 若干小节点, 一个很大的工具结果]`。`selectRange()` 从尾部累加到 `retain = 40,320` 就停；只要最后那个节点单独就 ≥ 40,320，切点被钉在它前面，于是可压范围 `= [firstIdx, 该节点前一个]`。

用本仓库的纯函数复现（`system(26000) / checkpoint(2812) / call(300) / result(41000)`，retain 40,320）：

```js
selectRange(session, nodes, 40320)  // → { start: 2, end: 2 }，只含 checkpoint 2812 tok
```

这正是截图第二行的「已压缩 1 条历史记录（约 2812 tokens）」。

同一个会话里，`compaction/summary` 53 次、`compaction/end(error)` 26 次，失败几乎全是：

```
summary is not smaller than the shadowed content (1940 estimated framed tokens >= 1940)
summary is not smaller than the shadowed content (2358 estimated framed tokens >= 2301)
```

即"把摘要再摘要一遍"这一步经常连几 token 的净收益都拿不到。

## 3. 归因：11-17 是原生，今天轮到本插件

- 本插件首个提交是 **2026-11-17 17:57**，而上面成对的压缩发生在 **14:16–16:10** —— 那时插件还不存在，所以那批"压两次"是 `compaction-basic` 自己的 `compactionRetries = 1` 循环（turn 25 一步一对、turn 17 一轮 12 次，也超过本插件"每轮 2 次"的上限）。
- 今天窗口改成 `1,050,000` 后，原生 `T = 840,000`，provider 报的 ~260K 远达不到，**原生静默**；而本插件 `cap = 252,000` 恰好压在同一条幻影压力下面 → 现在再有"两次"，就是本插件的 `maxAttempts = 2`。

两种实现共用一个缺陷：**用 provider 的 prompt 数量当压力，用启发式估值当阈值和保留预算，且都允许把刚写的 checkpoint 再摘要一遍。**

## 4. 为什么只有 GPT 路由明显

这条 OpenAI 兼容代理池路由上报的 prompt 约为启发式估值的 **2.9–3.1 倍**（同一步内 129K → 379K 的跳变，cache/uncached 口径混算），直连 DeepSeek 的路由约为 1.0–1.5 倍。倍数一大，压力曲线就永远趴在阈值上方，压缩再多次也只削掉真实的那部分。

计费侧本身没问题：OpenAI 的 long-context 档是「>272K input tokens 时**整个请求**按 2× input / 1.5× output 计」，所以按 provider 报数守线是对的 —— 问题在于这条路由的报数和历史不自洽，压缩治不了它。

## 5. 插件能怎么修（按价值排序）

1. **一步只压一次，且不与原生重复。** `enforce` 里先记 `session.surface.replaceGeneration`，`await next()` 之后若 generation 前进（原生刚压过），本步直接跳过；并把 `maxAttempts` 降为"每步 1、每轮 2"的上限。
2. **按缺口选深度，而不是固定 16%。** `needed = projected − cap + slack`，`retain = clamp(surfaceTokens − needed, minTail, cap × retainRatio)`，一刀切到线下；`minTail` 可用绝对 token（如 8K–20K）而不是比例。
3. **不许压新 checkpoint、要最小净收益。** 选区里若每个节点都是 `source.kind === 'compact-checkpoint'`，或估算净收益 < `max(1K, cap × 1%)`，返回 `undefined` 并记一次警告，不再重试。
4. **用量一致性闸门 + 跨步冷却。** `baseline.kind === 'usage'` 且 `usage > k × (surfaceTokens + 工具估值)`（k 默认 1.5）时，按估值判定并在会话内警告一次"该路由上报与历史不符"；一次压缩后仍未回到线下，则按"估值表层增长量"冷却（例如再长 5% 或 20K 才允许下一次），把"每步都压"变成"每次增长压一次"。

前两条就能消掉截图里的现象；后两条决定它会不会在下一轮又冒出来。

## 6. 立即止血（不改代码）

- 本插件：`maxAttempts: 1`；`safetyMarginTokens` 不要低于幻影压力与 272K 之间的空隙（当前 ~260K，余量 20K 的 cap 是 252K，正好被压住 → 可把余量降到 8K–12K 或把阈值调到 280K 让它退出触发区）。
- 原生：`compaction-basic` 行加 `compactionRetries: 0` 与绝对 `retainTokens`，避免它自己连压两次。
- 根治仍在上游：`measure()` 的 usage 采信需要一致性钳制，`selectCompactableRange()` 需要"只含新 checkpoint 就返回 null"的守卫。
