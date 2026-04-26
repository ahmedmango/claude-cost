# claude-cost

> See exactly how much you've spent on Claude Code. Per project, per session, per model.

```
$ claude-cost --plan max-5x --overage 57.29

  ╭──────────────────────────────────────────────────────────────────────────╮
  │  ◆ claude-cost · last 30 days · Claude Max (5×)                          │
  │                                                                          │
  │  $157.3  what you actually pay ($100.0 plan + $57.29 overage)            │
  │  $8657   API-equivalent value (raw token cost)                           │
  │  55.0×   value ratio · 97% cache · 31 sessions                           │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ▸   $5995  ███████████████████   69%  ~/DemoPortal               5 sess ·  97% cache
     $698.0  ██▎                    8%  ~/quant                    1 sess ·  97% cache
     $693.4  ██▎                    8%  ~/code/claude-cost         1 sess ·  98% cache
     $483.7  █▌                     6%  ~                         11 sess ·  94% cache
     $221.1  ▊                      3%  ~/Desktop/cortex-report    1 sess ·  97% cache

  + 8 more · try --all
```

Real output. Two numbers matter: **what you pay** (your plan + overage) and **API-equivalent value** (what those tokens would cost at raw API rates). The ratio tells you how much your subscription is doing for you.

---

## Why

Anthropic doesn't show you what you've spent on Claude Code. The `claude` CLI writes a transcript per session to `~/.claude/projects/`, and the usage data is in there — but it's buried in JSONL lines you'd need to parse yourself.

**`claude-cost` parses those transcripts and prints a number.** That's the whole tool.

It runs locally, makes no network calls, never sees your API key. It just reads files you already have.

## Install

```bash
bunx claude-cost
```

(or once installed: `claude-cost`)

Requires:
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Claude Code](https://www.anthropic.com/claude-code) — at least one session run, so the transcript files exist

## Usage

```bash
claude-cost                       # last 30 days, by project (default)
claude-cost --week                # last 7 days
claude-cost --today               # since 00:00 today
claude-cost --calendar-month      # 1st of this month → today
claude-cost --all                 # lifetime
claude-cost --since 2026-01-01    # custom start date

claude-cost --by-model            # group by model instead of project
claude-cost --by-day              # group by calendar day
claude-cost --by-session          # one row per session

claude-cost --plan max-5x         # reframe for subscribers (free/pro/max-5x/max-20x/team/enterprise)
claude-cost --plan max-5x --overage 57.29   # also include your billed overage from claude.ai
claude-cost --currency EUR        # convert (USD/EUR/GBP/CAD/JPY/INR/...)
claude-cost --rate 0.91           # custom fx rate, 1 USD = 0.91 target
claude-cost --show-pricing        # print the model price table
claude-cost --top 5               # top 5 only (default 10)
claude-cost --json                # machine output (jq it)
claude-cost --help
```

20 currencies built-in: USD EUR GBP CAD AUD JPY CNY INR BRL MXN CHF SEK NOK KRW SGD AED SAR TRY ZAR NGN. Set `CLAUDE_COST_CURRENCY=EUR` in your shell to make it default.

### Pipe-friendly

```bash
# Daily spend chart (jq + your favorite charter)
claude-cost --month --by-day --json | jq '.rows[] | [.label, .costUsd] | @csv'

# Total cost across everything you've ever done
claude-cost --all --json | jq '.totals.costUsd'

# Top 1 project, just the dollar amount
claude-cost --top 1 --json | jq -r '.rows[0].costUsd'
```

## What the columns mean

| column           | what                                                          |
| ---------------- | ------------------------------------------------------------- |
| **$**            | USD spend at Anthropic's published rates                      |
| **out**          | output tokens (the expensive ones)                            |
| **ev**           | "events" — assistant turns + user turns                       |
| **sess**         | distinct sessions in this bucket                              |
| **cache N%**     | cache_read / (cache_read + cache_create + tokens_in)          |

A high cache hit rate (≥70%, green) means most of your context is being reused — you're paying ~10× less than you would without caching. Low (red, <40%) means a lot of full-priced re-reads. Often a fixable workflow issue.

## Pricing

Hardcoded per-1M-token rates. Adjust in `src/parse.ts`:

```ts
opus:   { in: 15, out: 75, cacheRead: 1.50, cacheWrite: 18.75 },
sonnet: { in:  3, out: 15, cacheRead: 0.30, cacheWrite:  3.75 },
haiku:  { in:  1, out:  5, cacheRead: 0.10, cacheWrite:  1.25 },
```

These match Anthropic's published rates as of v0.1.0. Unknown models default to sonnet rates (conservative).

## How accurate is it?

**Token counts are exact** — they come straight from Anthropic's response in the transcript. No math from this tool.

**Dollar amounts are calculated**, not received. Caveats:

1. **API-rate vs subscription-rate.** By default the tool computes what your tokens would cost at raw API rates. If you're on Claude Pro / Max / Team, you're not paying that — you're paying your subscription. **Use `--plan max-5x` (or your tier) to reframe.** With `--overage N` you can also pass the actual overage from your claude.ai billing page so the "what you actually pay" number is exact.
2. **Pricing is hardcoded** at ship time. If Anthropic changes rates, output drifts until you `git pull` (or override prices via env vars).
3. **Currency rates are approximate**, baked at v0.1.1. For accuracy, set `CLAUDE_COST_RATE` from a live FX source.
4. **Model name matching is fuzzy** — `claude-3-5-sonnet` and `claude-sonnet-4-7` both get sonnet rates. Off by 10–30% on legacy sessions.

Run `claude-cost --show-pricing` to see the exact rate table being used.

### Plans reference

| `--plan` | what | $/mo |
|---|---|---|
| `api` (default) | pay-per-token, no subscription | 0 |
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
- ❌ Track API usage outside Claude Code (the `claude` CLI is the source)

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
            render() — terminal table
```

~250 lines of TypeScript. Zero runtime dependencies.

## License

MIT. Fork it. The `~/.claude/projects` format isn't documented — if Anthropic changes it, this will break gracefully (returns 0 cost rather than crashing) and need an update.

## Sibling projects

- [claude-colony](https://github.com/ahmedmango/claude-colony) — same data source, opposite philosophy: a pixel-art live dashboard. claude-cost is the focused CLI that fell out of building it.
