# cn-llm-bench

**Which provider actually serves China's frontier models best?**

Qwen, Kimi, DeepSeek and GLM are each available from the lab's own API, from
aggregators like OpenRouter, and from a growing number of resellers. They
advertise the same model name. They do not deliver the same latency, the same
throughput, or the same price.

This tool measures them side by side, from your machine, in your region.

```
  Provider              Model         TTFT ms   Total ms   tok/s   $/1M in   $/1M out    Run cost    OK
  ────────────────────  ────────────  ────────  ─────────  ──────  ────────  ─────────  ──────────  ───
  gloritoken            qwen3.8-max        612       4180    61.2     $1.04      $3.11    $0.00083   3/3
  Alibaba (official)    qwen3.8-max        588       4402    58.1     $2.00      $6.00    $0.00159   3/3
  OpenRouter            qwen3.8-max        934       5871    43.7     $2.00      $6.00    $0.00159   3/3
```

*(Layout only — the latency figures above are placeholders. Run it and you get
your own numbers, from your own region. The prices are real, and they are the
reason this tool exists: for Qwen 3.8 Max the official API and OpenRouter list
the same rate, so the only variable worth measuring is who serves it faster.)*

---

## Install

Node 18 or newer. No dependencies.

```bash
npx cn-llm-bench --help
```

or

```bash
npm install -g cn-llm-bench
cnbench --help
```

## Use

Set only the keys you have. Providers without a key are skipped.

```bash
export DASHSCOPE_API_KEY=...      # Alibaba (official)
export MOONSHOT_API_KEY=...       # Moonshot (official)
export DEEPSEEK_API_KEY=...       # DeepSeek (official)
export OPENROUTER_API_KEY=...     # OpenRouter
export GLORITOKEN_API_KEY=...     # gloritoken

npx cn-llm-bench --model kimi-k3 --runs 5
```

Useful flags:

```
-m, --model <name>     one canonical model (default: every model that
                       at least two configured providers can serve)
-n, --runs <n>         runs per provider, median reported (default 3)
    --max-tokens <n>   output cap (default 256)
-p, --prompt <text>    your own prompt — benchmark your real workload
    --only <a,b>       restrict to specific providers
    --json             machine-readable
    --md               markdown table, ready to paste into a post
-l, --list             show the registry and which keys are set
```

## What it measures

| Metric | Definition |
|---|---|
| **TTFT** | Wall time from request sent to the first chunk carrying visible content. This is what a user feels as "responsiveness". |
| **Total** | Wall time until the stream closes, capped by `--max-tokens`. |
| **tok/s** | Output tokens divided by generation time (total minus TTFT). |
| **Run cost** | Actual cost of that request, from the token counts the provider reported and the price in `providers.json`. |
| **OK** | Successful runs out of attempted. Timeouts, 429s and 5xx all count as failures — reliability is part of the comparison. |

Every request uses the same prompt, the same `max_tokens`, `temperature=0`,
and streaming, against each provider's OpenAI-compatible endpoint. The median
of N runs is reported, not the best.

## What it does not measure

- **Output quality.** Nothing here tells you whether one host's build is
  better than another's. Two providers can serve the same model name and
  produce different quality if one is quantized. This tool measures speed,
  reliability and price only. Judge quality yourself.
- **Sustained load.** Runs are sequential and polite, one at a time. Behaviour
  under concurrency is a different question.
- **Your region.** Latency is measured from wherever you run this. Numbers
  from a machine in Frankfurt say little about a user in Jakarta. Run it
  yourself before deciding anything.
- **Cache pricing.** Every run here is uncached, so the cost column uses each
  provider's uncached rate. Cache economics differ sharply between providers —
  Moonshot charges $0.30 per 1M cached input against $3.00 uncached, DeepSeek
  $0.003625 against $0.435 — and some resellers, including this tool's
  maintainer, charge one flat rate either way. **If your workload re-sends a
  large unchanging prompt, the cheapest row in this table may not be the
  cheapest for you.** Work it out against your own cache hit rate.
- **Where your data is processed.** Providers differ in where requests are
  served and under which jurisdiction, and this tool does not measure that at
  all. Several entries here — the official Chinese labs, and resellers in front
  of them — process requests in mainland China. If data residency matters to
  your work, that question outranks every column in this table.

## Prices

Prices live in [`providers.json`](providers.json), together with the URL each
one was read from and the date it was checked. They go stale. Treat them as a
starting point, not gospel.

Three things the price column deliberately does **not** do:

- **No cache-hit rates.** Moonshot charges $0.30 per 1M input on a cache hit
  versus $3.00 on a miss; DeepSeek charges $0.003625 versus $0.435. Every run
  here is uncached, so the cost column shows the uncached price. If your
  workload caches well, your real bill is lower than anything printed here.
- **No credit fees or minimums.** OpenRouter charges a fee when you buy
  credits; that is not included.
- **No guessing.** An entry with no verified price is `null`, and the cost
  column shows `—` rather than a made-up number.

**Currencies.** Every provider in the registry today publishes in USD, so
nothing is converted. If you add one that does not — several Chinese labs price
their domestic endpoints in CNY — set `currency` on the model entry. The rate
lives in `_fx`, every converted row is flagged in the output, and you can
override it at runtime:

```bash
FX_CNY_USD=0.1395 npx cn-llm-bench --model kimi-k3
```

Silently changing currency would make the cost column meaningless, so the tool
refuses to do it quietly.

If any number here is wrong, **open a PR** — corrections are merged fast. A
wrong price helps nobody, including us.

## Adding a provider

Anything with an OpenAI-compatible `/chat/completions` endpoint works. Add a
block to `providers.json`:

```json
"your-provider": {
  "label": "Your Provider",
  "baseUrl": "https://api.example.com/v1",
  "envKey": "YOUR_PROVIDER_API_KEY",
  "models": {
    "kimi-k3": { "id": "their-model-id", "in": 1.23, "out": 4.56 }
  }
}
```

Send a PR. Providers are added on request — including ones that beat us.

## Disclosure

This tool is maintained by [gloritoken](https://gloritoken.ai), which is one of
the providers in the registry.

That is a conflict of interest, so the design compensates for it:

- The measurement code path is identical for every provider — there is no
  branch anywhere that treats `gloritoken` differently. Read [`index.js`](index.js).
- Results are printed exactly as measured, in the order measured, sorted by
  TTFT. Nothing is weighted, filtered or rounded in anyone's favour.
- Failures are printed, ours included.
- Competing providers can be added by PR, and we will merge them.
- You run it yourself, with your own keys, from your own machine. You never
  have to trust a number we published — only the code, which you can read.

If you find any way this tool flatters its maintainer, open an issue and we
will fix it. That is a bug, not a feature.

## Why this exists

We kept getting asked "is it actually cheaper, or just cheaper on the pricing
page?" A table we publish ourselves is worth very little. A tool that lets
anyone measure it in ninety seconds is worth something.

## License

MIT.
