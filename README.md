<div align="center">

<pre>
   ╔═╗ ╦  ╔╗   ╔═╗  ╔═╗  ╔═╗  ╔═╗  ╔╦╗  ╦  ╔╗   ╔═╗
   ╚╗║ ║  ╠╩╗  ║╣   ║    ║ ║  ╚═╗   ║   ║  ║║║  ║ ╦
    ╚╝ ╩  ╚═╝  ╚═╝  ╚═╝  ╚═╝  ╚═╝   ╩   ╩  ╝╚╝  ╚═╝
        what's vibe coding costing you?
</pre>

**`bunx vibecosting`** — put a dollar value on your Claude Code token usage.
**Local-only · zero deps · MIT**

[![CI](https://github.com/ahmedmango/vibecosting/actions/workflows/test.yml/badge.svg)](https://github.com/ahmedmango/vibecosting/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-8ad06a?style=flat-square)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f472b6?style=flat-square)](https://bun.sh)
[![Node ≥18](https://img.shields.io/badge/node-≥18-339933?style=flat-square)](https://nodejs.org)
[![Telemetry: none](https://img.shields.io/badge/telemetry-none-blue?style=flat-square)](#what-it-doesnt-do)

</div>

---

`vibecosting` is a local CLI that reads Claude Code's transcript files and prices your token usage at Anthropic API rates. It shows the API-equivalent value of your work by project, model, session, day, hour, and tool.

No API key. No telemetry. No daemon. Just the receipts Claude Code already writes on your machine.

It answers the fun question:

> If this Claude Code usage had gone through the API meter, what would it have cost?

```
$ vibecosting

  ╭──────────────────────────────────────────────────────────────────────────╮
  │  ◆ vibecosting · last 30 days                                            │
  │                                                                          │
  │  $9414   total spend (API rates)                                          │
  │  6.9M    output tokens · 90.3K fresh input                               │
  │  3.9B    cache read · 105.2M cache write                                 │
  │  97%     cache hit · 102 sessions · 17 projects                          │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ▸   $6766  ████████   72%  ~/DemoPortal            opus-4-6    43 sess ·  97% cache
     $722.4  ▉           8%  ~/doo-demo-sdk          opus-4-6     5 sess ·  97% cache
     $536.9  ▋           6%  ~/quant                 opus-4-6     1 sess ·  98% cache
     $479.1  ▋           5%  ~/code/vibecosting      opus-4-7     1 sess ·  99% cache
     $349.9  ▍           4%  ~                       opus-4-6    17 sess ·  95% cache

  + 12 more · try --all
```

This is not your subscription bill. It is the API-rate shadow price of the tokens Claude Code consumed. If you are on Claude Pro / Max / Team, that distinction is the whole point: subscription billing hides the meter, while `vibecosting` shows the token value underneath.

The big number is usually cache, not fresh input. In the sample above, only 90.3K tokens were fresh input, but 3.9B cached tokens were read back into context. That is why long coding sessions can look absurdly expensive at API rates.

## More views

```
$ vibecosting --by-hour                  # when do you actually code?

   00:00  ▏                                          —     $2.23
   13:00  ████████████████████████████████████████  10%   $888.5    ← peak
   14:00  ████████████████████▊                      5%   $460.1
   15:00  ██████████████████████████████████         9%   $754.4
```

```
$ vibecosting --by-tool                  # which tools you call most

  ▸  2451  ██████████████████████████████████   35%  Bash
     1810  █████████████████████████▏           26%  Edit
     1365  ██████████████████▉                  20%  Read
      614  ████████▌                             9%  Write
```

```
$ vibecosting --calendar-month --forecast

  $8147  token-cost at raw API rates
  $9480  by end of month                  ← projected at current rate
```

```
$ vibecosting --week --vs-previous

  $1284  total spend
  ▼ -32% (was $1882)                       ← week-over-week
```

---

## Why

Anthropic doesn't give you a clear running total of Claude Code's API-equivalent token value. Claude Code writes per-session transcripts to `~/.claude/projects/`, which contain every token count, but it's buried in JSONL.

`vibecosting` parses those files and prints the number. Local-only TypeScript, zero runtime dependencies.

## Install

**One line, no prereqs.** macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/ahmedmango/vibecosting/main/install.sh | bash
```

That installs Bun if you don't have it, then runs vibecosting. Pass flags after a `--`:

```bash
curl -fsSL https://raw.githubusercontent.com/ahmedmango/vibecosting/main/install.sh | bash -s -- --plan max-5x --by-hour
```

**Already have Bun?** Use the direct form:

```bash
bunx github:ahmedmango/vibecosting
```

> Once published to npm: `bunx vibecosting`. The forms above work today regardless.

**Windows?** Install Bun manually (https://bun.sh), then `bunx github:ahmedmango/vibecosting`.

## Usage

```bash
vibecosting                        # last 30 days, by project (default)
vibecosting --week                 # last 7 days
vibecosting --today                # since 00:00 today
vibecosting --calendar-month       # 1st of this month → today
vibecosting --all                  # lifetime
vibecosting --since 2026-01-01     # custom start

vibecosting --by-model             # group by model
vibecosting --by-day               # group by calendar day (with sparkline)
vibecosting --by-session           # one row per session

vibecosting --plan max-5x          # reframe for subscribers (free/pro/max-5x/max-20x/team/enterprise)
vibecosting --plan max-5x --overage 57.29   # include your billed overage from claude.ai

vibecosting --currency EUR         # convert (USD/EUR/GBP/CAD/JPY/INR/...)
vibecosting --rate 0.91            # custom fx rate (1 USD = 0.91 target)
vibecosting --show-pricing         # print the model price table

vibecosting --top 5                # top 5 only (default 10)
vibecosting --json                 # machine output (jq it)
vibecosting --help
```

20 currencies built-in. Set `CLAUDE_COST_PLAN=max-5x` and `CLAUDE_COST_OVERAGE=57.29` in your shell to make them defaults.

### Pipe-friendly

```bash
# Daily spend chart
vibecosting --month --by-day --json | jq '.rows[] | [.label, .cost] | @csv'

# Total billed across everything you've ever done
vibecosting --all --json | jq '.totals.actualPaidUsd'

# Top 1 project, just the dollar amount
vibecosting --top 1 --json | jq -r '.rows[0].costUsd'
```

## What the columns mean

| column           | what                                                          |
| ---------------- | ------------------------------------------------------------- |
| **$**            | USD spend at Anthropic's published rates (or your currency)   |
| **bar / %**      | share of total                                                |
| **out**          | output tokens (the expensive ones)                            |
| **fresh input**  | uncached input tokens from Anthropic's response                |
| **cache read**   | cached input tokens reused by Claude Code                     |
| **cache write**  | input tokens written into prompt cache (5m and 1h priced separately) |
| **ev**           | "events" — assistant turns + user turns                       |
| **sess**         | distinct sessions in this bucket                              |
| **cache N%**     | cache_read / (cache_read + cache_create + tokens_in)          |

A high cache hit rate (≥70%, green) means most context is being reused — paying ~10× less than full input tier. Low (<40%, red) means full-priced re-reads. Often a fixable workflow issue.

## How accurate is it?

**Token counts are exact** — they come straight from Anthropic's response in the transcript. No math from this tool.

**Dollar amounts are calculated**, not received. Caveats:

1. **API-rate vs subscription-rate.** By default, output is computed at raw API rates. If you're on Claude Pro / Max / Team, you're paying your subscription, not these per-token totals. **Use `--plan max-5x`** (or your tier) to reframe. With `--overage N` you can also pass the actual overage from claude.ai → Settings → Usage so the "what you actually pay" number is exact.

   ⚠️ **Don't read "55× ratio" as "55× smarter."** Same model, same outputs. The multiple is a per-token billing comparison, distorted by cache reads (which would be architected differently on the API plan) and by the fact that subscription users use Claude more freely because there's no meter ticking.

2. **Pricing is hardcoded** at ship time. If Anthropic changes rates, output drifts until next release.
3. **Currency rates are approximate** — set `CLAUDE_COST_RATE` for live FX.
4. **Model name matching is fuzzy** — `claude-3-5-sonnet` and `claude-sonnet-4-7` both get sonnet rates. Off by 10–30% on legacy sessions.
5. **Claude Code transcript shape can change.** vibecosting de-duplicates repeated assistant snapshots by request id and recursively includes nested subagent transcripts, but the source of truth for actual charges remains Anthropic's billing page.

Run `vibecosting --show-pricing` to see the exact rate table being used.

### Plans reference

| `--plan` | what | $/mo |
|---|---|---|
| `api` (default) | pay-per-token | 0 |
| `free` | Claude free tier | 0 |
| `pro` | Claude Pro | 20 |
| `max-5x` | Claude Max 5× | 100 |
| `max-20x` | Claude Max 20× | 200 |
| `team` | Claude Team (per-seat premium) | 30 |
| `enterprise` | per-seat estimate | 60 |

Update prices in `src/parse.ts → PLANS` if Anthropic changes them.

## What it doesn't do

- ❌ Limit / cap your spending (read-only by design)
- ❌ Watch live (run again to refresh — it's that fast)
- ❌ Send anything anywhere (entirely local)
- ❌ Track API usage outside Claude Code

## How it works

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
                  │
                  ▼
       ┌───────────────────────────┐
       │   parseSession()          │   per file
       │   sums input/output/      │
       │   cache tokens by model,  │
       │   computes USD            │
       └─────────┬─────────────────┘
                 │
                 ▼
            bucket() — group by project/model/day/session
                 │
                 ▼
            render() — terminal table with bars & sparklines
```

Local-only TypeScript. Zero runtime dependencies.

## License

MIT. Fork it.

## Sibling projects

- [claude-colony](https://github.com/ahmedmango/claude-colony) — same data source, opposite philosophy: a pixel-art live dashboard. vibecosting is the focused CLI that fell out of building it.
