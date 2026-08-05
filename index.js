#!/usr/bin/env node
'use strict';

/**
 * cn-llm-bench — compare providers serving China's frontier models.
 *
 * Measures, per provider: time to first token, total wall time, output
 * throughput, success rate, and the actual cost of the run.
 *
 * Design rules:
 *   - Every provider is measured the same way, with the same prompt.
 *   - Only providers whose API key is present in the environment are tested.
 *   - Numbers are printed exactly as measured. Nothing is weighted or adjusted.
 *   - Zero runtime dependencies. Node 18+ (global fetch).
 *
 * MIT licensed. Issues and PRs: https://github.com/collinliu/cn-llm-bench
 */

const fs = require('fs');
const path = require('path');

const REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8')
);

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const o = {
    model: null,
    runs: 3,
    maxTokens: 256,
    prompt: 'Write a haiku about distributed systems. Then explain it in exactly two sentences.',
    timeout: 120000,
    json: false,
    markdown: false,
    only: null,
    list: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--model' || a === '-m') o.model = next();
    else if (a === '--runs' || a === '-n') o.runs = parseInt(next(), 10);
    else if (a === '--max-tokens') o.maxTokens = parseInt(next(), 10);
    else if (a === '--prompt' || a === '-p') o.prompt = next();
    else if (a === '--timeout') o.timeout = parseInt(next(), 10);
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim());
    else if (a === '--json') o.json = true;
    else if (a === '--markdown' || a === '--md') o.markdown = true;
    else if (a === '--list' || a === '-l') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`unknown flag: ${a}  (try --help)`);
      process.exit(1);
    }
  }
  return o;
}

const HELP = `
cn-llm-bench — which provider actually serves China's frontier models best?

  Usage
    npx cn-llm-bench [options]

  Options
    -m, --model <name>     canonical model to test (default: every model that
                           at least two configured providers can serve)
    -n, --runs <n>         runs per provider, median is reported (default: 3)
        --max-tokens <n>   output cap per run (default: 256)
    -p, --prompt <text>    prompt to send (default: a short mixed-form task)
        --only <a,b>       restrict to these providers (comma separated)
        --timeout <ms>     per-request timeout (default: 120000)
        --json             machine-readable output
        --md, --markdown   markdown table, ready to paste into a post
    -l, --list             show providers, models and which keys are set
    -h, --help             this text

  Keys — set only the ones you have; the rest are skipped
    DASHSCOPE_API_KEY      Alibaba (official)
    MOONSHOT_API_KEY       Moonshot (official)
    DEEPSEEK_API_KEY       DeepSeek (official)
    OPENROUTER_API_KEY     OpenRouter
    GLORITOKEN_API_KEY     gloritoken

  FX — vendors that publish in another currency are converted for the cost
  column at the rate in providers.json. Override it, e.g. FX_CNY_USD=0.1395.

  Example
    export OPENROUTER_API_KEY=sk-...
    export GLORITOKEN_API_KEY=sk-...
    npx cn-llm-bench --model kimi-k3 --runs 5

  Latency depends on where you run this. Run it from your own machine, in
  your own region, before drawing conclusions about your own setup.
`;

// ---------------------------------------------------------------- utils

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmt = (v, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits);

const money = (v, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : '$' + v.toFixed(digits);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a list price to USD.
 *
 * Vendors publish in different currencies (Moonshot lists Kimi in CNY), so the
 * cost column would be meaningless without a stated conversion. The rate comes
 * from providers.json and can be overridden per currency at runtime, e.g.
 * FX_CNY_USD=0.1395. Converted rows are flagged in the output — a benchmark
 * that quietly changes currency is not a benchmark.
 */
function toUsd(value, currency) {
  if (value == null) return { usd: null, converted: false };
  if (!currency || currency === 'USD') return { usd: value, converted: false };
  const override = Number(process.env[`FX_${currency}_USD`]);
  const rate =
    Number.isFinite(override) && override > 0
      ? override
      : (REGISTRY._fx && REGISTRY._fx[currency]) || null;
  if (!rate) return { usd: null, converted: false };
  return { usd: value * rate, converted: true, rate, currency };
}

// ---------------------------------------------------------------- one run

/**
 * Streams one completion and measures it.
 * TTFT is the wall time until the first chunk carrying visible content.
 */
async function measureOnce(provider, modelId, opts) {
  const url = provider.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const key = process.env[provider.envKey];

  const body = {
    model: modelId,
    messages: [{ role: 'user', content: opts.prompt }],
    max_tokens: opts.maxTokens,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout);

  const started = Date.now();
  let ttft = null;
  let text = '';
  let usage = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${res.status} ${detail}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj.usage) usage = obj.usage;
        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
        const piece = delta && (delta.content || delta.reasoning_content);
        if (piece) {
          if (ttft === null) ttft = Date.now() - started;
          text += piece;
        }
      }
    }

    const total = Date.now() - started;

    // Prefer the provider's own accounting; fall back to a rough estimate so
    // a provider that omits usage is not silently excluded.
    const outTokens = usage?.completion_tokens ?? Math.round(text.length / 4);
    const inTokens = usage?.prompt_tokens ?? Math.round(opts.prompt.length / 4);
    const genMs = ttft === null ? total : Math.max(total - ttft, 1);

    return {
      ok: true,
      ttft,
      total,
      outTokens,
      inTokens,
      tps: (outTokens / genMs) * 1000,
      estimated: !usage,
      sample: text.slice(0, 120).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- bench

async function benchmark(opts) {
  const all = REGISTRY.providers;
  const available = Object.entries(all).filter(([name, p]) => {
    if (!process.env[p.envKey]) return false;
    if (opts.only && !opts.only.includes(name)) return false;
    return true;
  });

  if (!available.length) {
    console.error('No API keys found in the environment. Run with --list to see what is expected.');
    process.exit(1);
  }

  // Which models can we compare? Only those served by 2+ available providers,
  // unless the user named one explicitly.
  const counts = {};
  for (const [, p] of available) {
    for (const m of Object.keys(p.models)) counts[m] = (counts[m] || 0) + 1;
  }
  const models = opts.model
    ? [opts.model]
    : Object.keys(counts).filter((m) => counts[m] >= 2);

  if (!models.length) {
    console.error('Nothing to compare — fewer than two providers serve a common model.');
    console.error('Add another key, or name a model with --model.');
    process.exit(1);
  }

  const results = [];

  for (const model of models) {
    for (const [name, p] of available) {
      const entry = p.models[model];
      if (!entry) continue;

      // Progress is drawn in place, so only when stderr is a terminal —
      // otherwise piping the output leaves a trail of half-written lines.
      const tty = process.stderr.isTTY;
      const runs = [];
      for (let i = 0; i < opts.runs; i++) {
        if (tty) process.stderr.write(`  ${p.label} · ${model} · run ${i + 1}/${opts.runs}\r`);
        runs.push(await measureOnce(p, entry.id, opts));
        await sleep(400); // be a polite client
      }
      if (tty) process.stderr.write(' '.repeat(60) + '\r');

      const good = runs.filter((r) => r.ok);
      const failures = runs.filter((r) => !r.ok);

      const inTok = median(good.map((r) => r.inTokens));
      const outTok = median(good.map((r) => r.outTokens));
      const priceIn = toUsd(entry.in, entry.currency);
      const priceOut = toUsd(entry.out, entry.currency);
      const cost =
        priceIn.usd != null && priceOut.usd != null && inTok != null && outTok != null
          ? (inTok / 1e6) * priceIn.usd + (outTok / 1e6) * priceOut.usd
          : null;

      results.push({
        provider: name,
        label: p.label,
        model,
        modelId: entry.id,
        runs: opts.runs,
        ok: good.length,
        ttftMs: median(good.map((r) => r.ttft).filter((v) => v != null)),
        totalMs: median(good.map((r) => r.total)),
        tps: median(good.map((r) => r.tps)),
        inTokens: inTok,
        outTokens: outTok,
        priceIn: priceIn.usd,
        priceOut: priceOut.usd,
        listCurrency: entry.currency || 'USD',
        listIn: entry.in,
        listOut: entry.out,
        fxConverted: priceIn.converted || priceOut.converted,
        fxRate: priceIn.rate || priceOut.rate || null,
        runCost: cost,
        estimatedTokens: good.some((r) => r.estimated),
        errors: [...new Set(failures.map((r) => r.error))].slice(0, 2),
        note: p.note || null,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------- output

const COLUMNS = [
  ['Provider', (r) => r.label, 'l'],
  ['Model', (r) => r.model, 'l'],
  ['TTFT ms', (r) => fmt(r.ttftMs), 'r'],
  ['Total ms', (r) => fmt(r.totalMs), 'r'],
  ['tok/s', (r) => fmt(r.tps, 1), 'r'],
  ['$/1M in', (r) => money(r.priceIn, 2), 'r'],
  ['$/1M out', (r) => money(r.priceOut, 2), 'r'],
  ['Run cost', (r) => (r.runCost == null ? '—' : '$' + r.runCost.toFixed(5)), 'r'],
  ['OK', (r) => `${r.ok}/${r.runs}`, 'r'],
];

function renderTable(rows) {
  const head = COLUMNS.map((c) => c[0]);
  const body = rows.map((r) => COLUMNS.map((c) => String(c[1](r))));
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((b) => b[i].length))
  );
  const pad = (s, w, align) => (align === 'r' ? s.padStart(w) : s.padEnd(w));

  const line = (cells) =>
    '  ' + cells.map((c, i) => pad(c, widths[i], COLUMNS[i][2])).join('  ');

  const out = [];
  out.push(line(head));
  out.push('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const b of body) out.push(line(b));
  return out.join('\n');
}

function renderMarkdown(rows, opts) {
  const head = COLUMNS.map((c) => c[0]);
  const sep = COLUMNS.map((c) => (c[2] === 'r' ? '---:' : ':---'));
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map((r) => `| ${COLUMNS.map((c) => c[1](r)).join(' | ')} |`),
  ];
  lines.push('');
  lines.push(
    `_${opts.runs} runs per provider, median reported. max_tokens=${opts.maxTokens}, temperature=0. ` +
      `Measured with [cn-llm-bench](https://github.com/collinliu/cn-llm-bench) — run it yourself, latency depends on your region._`
  );
  return lines.join('\n');
}

function listProviders() {
  console.log('\n  Providers and models in the registry\n');
  for (const [name, p] of Object.entries(REGISTRY.providers)) {
    const has = process.env[p.envKey] ? 'key set' : 'no key';
    console.log(`  ${p.label}  (${name})  — ${p.envKey}: ${has}`);
    for (const [m, cfg] of Object.entries(p.models)) {
      const cur = cfg.currency || 'USD';
      const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '\u00a5' : cur + ' ';
      const price =
        cfg.in != null && cfg.out != null
          ? `${sym}${cfg.in}/${sym}${cfg.out} per 1M` + (cur === 'USD' ? '' : ` (${cur})`)
          : 'price not in registry';
      console.log(`      ${m.padEnd(18)} ${String(cfg.id).padEnd(28)} ${price}`);
    }
    if (p.note) console.log(`      note: ${p.note}`);
    console.log('');
  }
  console.log(`  Prices last checked: ${REGISTRY._pricesUpdated}`);
  console.log('  Verify against vendor pages before deciding anything. PRs welcome.\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return console.log(HELP);
  if (opts.list) return listProviders();

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) {
    console.error('Node 18 or newer is required (this tool uses global fetch).');
    process.exit(1);
  }

  if (!opts.json) {
    console.error(`\n  cn-llm-bench — ${opts.runs} runs per provider, median reported\n`);
  }

  const rows = await benchmark(opts);
  rows.sort((a, b) =>
    a.model === b.model ? (a.ttftMs ?? 1e9) - (b.ttftMs ?? 1e9) : a.model.localeCompare(b.model)
  );

  if (opts.json) {
    console.log(JSON.stringify({ meta: { ...opts, pricesUpdated: REGISTRY._pricesUpdated }, results: rows }, null, 2));
    return;
  }

  if (opts.markdown) {
    console.log(renderMarkdown(rows, opts));
    return;
  }

  console.log(renderTable(rows));
  console.log('');

  const failed = rows.filter((r) => r.ok < r.runs);
  for (const r of failed) {
    console.log(`  ! ${r.label} · ${r.model}: ${r.ok}/${r.runs} succeeded — ${r.errors.join(' | ')}`);
  }
  const estimated = rows.filter((r) => r.estimatedTokens);
  if (estimated.length) {
    console.log(
      `  ~ token counts estimated (provider returned no usage): ` +
        estimated.map((r) => r.label).join(', ')
    );
  }
  const unpriced = rows.filter((r) => r.runCost == null);
  if (unpriced.length) {
    console.log(
      `  ~ no price in registry for: ` +
        [...new Set(unpriced.map((r) => r.label))].join(', ') +
        ` — add it in providers.json and send a PR`
    );
  }
  const converted = rows.filter((r) => r.fxConverted);
  if (converted.length) {
    for (const r of converted) {
      console.log(
        `  ~ ${r.label} lists in ${r.listCurrency} (${r.listIn}/${r.listOut} per 1M); ` +
          `converted at 1 ${r.listCurrency} = $${r.fxRate} — override with FX_${r.listCurrency}_USD`
      );
    }
  }

  console.log(`\n  Prices last checked ${REGISTRY._pricesUpdated}. Latency reflects where you ran this.`);
  console.log(`  Maintained by gloritoken, which is one of the providers above. Numbers are printed as measured.\n`);
}

main().catch((e) => {
  console.error('\n' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
