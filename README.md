# claude-cost

> See exactly how much you've spent on Claude Code. Per project, per session, per model.

```
$ claude-cost --month

  ◆ claude-cost  · last 30 days

  $8505 total  ·  8.8M out  ·  36.8K in
  97% cache hit · 30 sessions · 13 projects

  ──────────────────────────────────────────────────────────────────────
     $5962  ~/DemoPortal               4.2M out · 11630 ev ·   5 sess · cache 97%
     $698   ~/quant                  448.4K out · 1530 ev ·   1 sess · cache 97%
     $602   ~/code/claude-cost         1.1M out · 1244 ev ·   1 sess · cache 97%
     $471   ~                        887.2K out · 1717 ev ·  10 sess · cache 94%
     $221   ~/Desktop/cortex-report  426.7K out ·  705 ev ·   1 sess · cache 97%
     $191   ~/picklepointhq          637.3K out · 1008 ev ·   4 sess · cache 96%
     $109   ~/code/town-watcher      305.7K out ·  591 ev ·   2 sess · cache 97%
     $85.11 ~/cnct-integrations      480.2K out ·  257 ev ·   1 sess · cache 94%
     $74.58 ~/Downloads              135.3K out ·  182 ev ·   1 sess · cache 82%
     $62.45 ~/doo-clients             81.9K out ·  159 ev ·   1 sess · cache 96%
  ──────────────────────────────────────────────────────────────────────
  3 more · try --all
```

That's a real screenshot of someone running it on their machine. They had no idea.

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

1. **Subscription users** (Claude Max / Team flat-rate plans) actually pay their monthly subscription, not these per-token totals. This tool computes what your tokens *would* cost at API rates. Useful for "am I overusing my plan?" — not for "what was on my card statement".
2. **Pricing is hardcoded** at ship time. If Anthropic changes rates, output drifts until you `git pull` (or override prices via `~/.claude-cost.json`).
3. **Currency rates are approximate**, baked at v0.1.1. For accuracy, set `CLAUDE_COST_RATE` from a live FX source.
4. **Model name matching is fuzzy** — `claude-3-5-sonnet` and `claude-sonnet-4-7` both get sonnet rates. Off by 10–30% on legacy sessions.

Run `claude-cost --show-pricing` to see the exact rate table being used.

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
