#!/usr/bin/env bun
// vibecosting — see what you've spent on Claude Code.

import { loadAllSessions, shortPath, shortModel, CURRENCIES, PRICING, PLANS, type Session } from './parse.ts';

// ─── ANSI ────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const C = isTTY ? {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  bold:  '\x1b[1m',
  black: '\x1b[30m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
  bg:    '\x1b[48;5;235m',
} : Object.fromEntries(['reset','dim','bold','black','red','green','yellow','blue','magenta','cyan','gray','bg'].map(k => [k, ''])) as any;

// ─── ARGS ────────────────────────────────────────────────────────────────
type Args = {
  range: 'today' | 'week' | 'month' | 'all' | 'calendar-month';
  since?: number;
  groupBy: 'project' | 'model' | 'day' | 'session' | 'hour' | 'tool';
  top: number;
  json: boolean;
  help: boolean;
  version: boolean;
  currency: string;
  customRate?: number;
  showPricing: boolean;
  plan: string;
  overageUsd?: number;
  vsPrevious: boolean;
  forecast: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    range: 'month',
    groupBy: 'project',
    top: 10,
    json: false,
    help: false,
    version: false,
    currency: (process.env.CLAUDE_COST_CURRENCY || 'USD').toUpperCase(),
    customRate: process.env.CLAUDE_COST_RATE ? Number(process.env.CLAUDE_COST_RATE) : undefined,
    showPricing: false,
    plan: process.env.CLAUDE_COST_PLAN || 'api',
    overageUsd: process.env.CLAUDE_COST_OVERAGE ? Number(process.env.CLAUDE_COST_OVERAGE) : undefined,
    vsPrevious: false,
    forecast: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--today') a.range = 'today';
    else if (v === '--week') a.range = 'week';
    else if (v === '--month') a.range = 'month';
    else if (v === '--calendar-month') a.range = 'calendar-month';
    else if (v === '--all' || v === '--lifetime') a.range = 'all';
    else if (v === '--since' && argv[i+1]) {
      const t = Date.parse(argv[++i]);
      if (Number.isFinite(t)) a.since = t;
    }
    else if (v === '--by-project') a.groupBy = 'project';
    else if (v === '--by-model')   a.groupBy = 'model';
    else if (v === '--by-day')     a.groupBy = 'day';
    else if (v === '--by-session') a.groupBy = 'session';
    else if (v === '--by-hour')    a.groupBy = 'hour';
    else if (v === '--by-tool')    a.groupBy = 'tool';
    else if (v === '--vs-previous' || v === '--vs') a.vsPrevious = true;
    else if (v === '--forecast') a.forecast = true;
    else if (v === '--top' && argv[i+1]) a.top = Number(argv[++i]) || 10;
    else if (v === '--currency' && argv[i+1]) a.currency = argv[++i].toUpperCase();
    else if (v === '--rate' && argv[i+1]) a.customRate = Number(argv[++i]) || undefined;
    else if (v === '--show-pricing') a.showPricing = true;
    else if ((v === '--plan' || v === '--subscription') && argv[i+1]) a.plan = argv[++i].toLowerCase();
    else if (v === '--overage' && argv[i+1]) a.overageUsd = Number(argv[++i]) || undefined;
    else if (v === '--json' || v === '-j') a.json = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--version' || v === '-v') a.version = true;
    else if (v.startsWith('--')) {
      console.error(`unknown flag: ${v}`);
      process.exit(2);
    }
  }
  return a;
}

const HELP = `
${C.bold}vibecosting${C.reset} — what you've spent on Claude Code

${C.bold}USAGE${C.reset}
  ${C.cyan}vibecosting${C.reset} [range] [grouping] [options]

${C.bold}RANGE${C.reset} (default: --month)
  --today           activity since 00:00 today
  --week            last 7 days
  --month           last 30 days (trailing)
  --calendar-month  this calendar month (1st → today)
  --all             lifetime
  --since DATE      ISO date, e.g. 2026-01-01

${C.bold}GROUPING${C.reset} (default: --by-project)
  --by-project      group by repo / cwd
  --by-model        group by model
  --by-day          group by calendar day (sparkline trend)
  --by-session      one row per session
  --by-hour         hour-of-day distribution (when do you code?)
  --by-tool         which tools you call most
  --vs-previous     show % change vs previous period of same length
  --forecast        project end-of-period spend at current run rate

${C.bold}PLAN${C.reset} ${C.dim}(default: api — pay-per-token)${C.reset}
  --plan PLAN       free / pro / max-5x / max-20x / team / enterprise / api
                    Reframes output: "you pay \$200, equivalent API spend \$X".
                    Same as --subscription. Or env $CLAUDE_COST_PLAN.
  --overage N       extra USD billed beyond your plan (from Anthropic dash).
                    Or env $CLAUDE_COST_OVERAGE.

${C.bold}CURRENCY${C.reset} ${C.dim}(default: USD; override with $CLAUDE_COST_CURRENCY)${C.reset}
  --currency CODE   convert to USD/EUR/GBP/CAD/AUD/JPY/CNY/INR/BRL/MXN/
                    CHF/SEK/NOK/KRW/SGD/AED/SAR/TRY/ZAR/NGN
                    (rates approximate, baked at v0.1.1)
  --rate N          override conversion rate (1 USD = N target)
                    or set $CLAUDE_COST_RATE
  --show-pricing    print the model price table being used

${C.bold}OUTPUT${C.reset}
  --top N           show top N rows (default 10)
  --json, -j        machine-readable JSON
  --help, -h        this help
  --version, -v     print version

${C.bold}ACCURACY NOTE${C.reset}
  ${C.dim}Token counts come from Anthropic's response — those are exact.${C.reset}
  ${C.dim}Prices are hardcoded at ship time. If Anthropic changes rates,${C.reset}
  ${C.dim}your output drifts until \`git pull\` (or override w/ env vars).${C.reset}
  ${C.dim}If you're on Claude Max/Team flat-rate plans, what you actually${C.reset}
  ${C.dim}pay is the subscription, not these per-token totals.${C.reset}

${C.bold}EXAMPLES${C.reset}
  ${C.dim}# How much did I spend this month?${C.reset}
  vibecosting

  ${C.dim}# Top 5 most expensive projects this week${C.reset}
  vibecosting --week --top 5

  ${C.dim}# Cost broken down by model, all time${C.reset}
  vibecosting --all --by-model

  ${C.dim}# Daily spend in JSON for a chart${C.reset}
  vibecosting --month --by-day --json | jq

${C.dim}Reads ~/.claude/projects/**/*.jsonl. No network. No telemetry.${C.reset}
`;

// ─── DATE WINDOW ─────────────────────────────────────────────────────────
function rangeStart(range: Args['range'], since?: number): number {
  if (since) return since;
  const now = new Date();
  if (range === 'all') return 0;
  if (range === 'today') {
    const d = new Date(now); d.setHours(0,0,0,0); return d.getTime();
  }
  if (range === 'calendar-month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return d.getTime();
  }
  if (range === 'week')  return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  if (range === 'month') return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

function rangeLabel(range: Args['range'], since?: number): string {
  if (since) return `since ${new Date(since).toISOString().slice(0,10)}`;
  if (range === 'today') return 'today';
  if (range === 'week') return 'last 7 days';
  if (range === 'month') return 'last 30 days';
  if (range === 'calendar-month') {
    const d = new Date();
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }
  if (range === 'all') return 'lifetime';
  return range;
}

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────
let CURRENCY_SYMBOL = '$';
let CURRENCY_RATE = 1.0;
let CURRENCY_CODE = 'USD';

function setCurrency(code: string, customRate?: number) {
  CURRENCY_CODE = code;
  if (customRate && Number.isFinite(customRate) && customRate > 0) {
    CURRENCY_RATE = customRate;
    const known = CURRENCIES[code];
    CURRENCY_SYMBOL = known?.symbol ?? code + ' ';
    return;
  }
  const c = CURRENCIES[code];
  if (!c) {
    console.error(`unknown currency: ${code}. Known: ${Object.keys(CURRENCIES).join(', ')}`);
    console.error(`Or pass --rate N for a custom rate.`);
    process.exit(2);
  }
  CURRENCY_RATE = c.rate;
  CURRENCY_SYMBOL = c.symbol;
}

function fmtCost(usd: number): string {
  const n = usd * CURRENCY_RATE;
  // Adjust precision per currency magnitude. JPY/KRW have no minor unit.
  const noMinor = ['JPY', 'KRW', 'NGN', 'INR'].includes(CURRENCY_CODE);
  if (noMinor) {
    if (n >= 100_000) return `${CURRENCY_SYMBOL}${(n/1000).toFixed(0)}K`;
    return `${CURRENCY_SYMBOL}${Math.round(n).toLocaleString('en-US')}`;
  }
  if (n >= 1000) return `${CURRENCY_SYMBOL}${n.toFixed(0)}`;
  if (n >= 100)  return `${CURRENCY_SYMBOL}${n.toFixed(1)}`;
  if (n >= 1)    return `${CURRENCY_SYMBOL}${n.toFixed(2)}`;
  return `${CURRENCY_SYMBOL}${n.toFixed(3)}`;
}
function fmtTok(n: number): string {
  if (n >= 1_000_000_000) return (n/1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n/1_000).toFixed(1) + 'K';
  return String(n);
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function lpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - (n - 1));
}

// ─── BUCKETING ────────────────────────────────────────────────────────────
type Bucket = {
  key: string;
  label: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  events: number;
  sessions: number;
  models?: Set<string>;
};

function newBucket(key: string, label: string): Bucket {
  return { key, label, costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, cacheCreate5m: 0, cacheCreate1h: 0, events: 0, sessions: 0, models: new Set() };
}

function bucket(sessions: Session[], by: Args['groupBy']): Bucket[] {
  const map = new Map<string, Bucket>();

  // hour and tool groupings work differently — they aggregate sub-session data.
  if (by === 'hour') {
    // Bucket by hour-of-day 0..23 across all sessions in window.
    for (let h = 0; h < 24; h++) {
      const lab = `${String(h).padStart(2, '0')}:00`;
      map.set(String(h), newBucket(String(h), lab));
    }
    for (const s of sessions) {
      for (let h = 0; h < 24; h++) {
        const b = map.get(String(h))!;
        b.costUsd += s.hourBuckets[h] ?? 0;
      }
      // session count attribution is fuzzy for hour buckets — mark on most-active hour
      let topHour = 0, topVal = 0;
      for (let h = 0; h < 24; h++) {
        if ((s.hourBuckets[h] ?? 0) > topVal) { topVal = s.hourBuckets[h]; topHour = h; }
      }
      const b = map.get(String(topHour))!;
      b.sessions += 1;
      b.events += s.events;
      if (s.model) b.models!.add(s.model);
    }
    // sort by hour numerically (NOT by cost) for hourly view
    return Array.from(map.values()).sort((a, b) => Number(a.key) - Number(b.key));
  }

  if (by === 'tool') {
    for (const s of sessions) {
      for (const [toolName, count] of s.toolCounts) {
        let b = map.get(toolName);
        if (!b) { b = newBucket(toolName, toolName); map.set(toolName, b); }
        b.events += count;          // tool calls
        b.sessions = (b.sessions ?? 0) + 1;
        // No cost per tool — claude doesn't bill that way. Use events as proxy.
      }
    }
    return Array.from(map.values()).sort((a, b) => b.events - a.events);
  }

  for (const s of sessions) {
    let key: string, label: string;
    if (by === 'project') { key = s.projectPath; label = shortPath(s.projectPath); }
    else if (by === 'model') {
      key = s.dominantModel ?? s.model ?? '(unknown)';
      label = shortModel(key);
    }
    else if (by === 'day') {
      const d = s.lastTs ? new Date(s.lastTs) : null;
      key = d ? d.toISOString().slice(0, 10) : '(no date)';
      label = key;
    }
    else /* session */ { key = s.id; label = s.id.slice(0, 8); }

    let b = map.get(key);
    if (!b) { b = newBucket(key, label); map.set(key, b); }
    b.costUsd      += s.costUsd;
    b.tokensIn     += s.tokensIn;
    b.tokensOut    += s.tokensOut;
    b.cacheRead    += s.cacheRead;
    b.cacheCreate  += s.cacheCreate;
    b.cacheCreate5m += s.cacheCreate5m;
    b.cacheCreate1h += s.cacheCreate1h;
    b.events       += s.events;
    b.sessions     += 1;
    if (s.dominantModel) b.models!.add(s.dominantModel);
  }
  return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
}

// ─── BAR CHART HELPERS ───────────────────────────────────────────────────
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// Inline horizontal bar. fraction in [0..1], integer width chars wide.
function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = f * width;
  let full = Math.floor(filled);
  let remainder = Math.round((filled - full) * 8);
  // Clamp: if rounding bumps to 8, promote to a full block.
  if (remainder >= 8) { full += 1; remainder = 0; }
  if (full >= width)  { full = width; remainder = 0; }
  let s = '█'.repeat(full);
  if (remainder > 0 && full < width) s += EIGHTHS[remainder];
  return s.padEnd(width, ' ');
}

// Sparkline — one block char per value, height ∈ ▁▂▃▄▅▆▇█
const SPARKS = ['▁','▂','▃','▄','▅','▆','▇','█'];
function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return SPARKS[0].repeat(values.length);
  return values.map(v => {
    const idx = Math.min(SPARKS.length - 1, Math.floor((v / max) * (SPARKS.length - 1) + 0.5));
    return SPARKS[idx];
  }).join('');
}

// ─── RENDER ───────────────────────────────────────────────────────────────
function render(buckets: Bucket[], totals: Bucket, args: Args, label: string) {
  const term = Math.max(70, Math.min(120, process.stdout.columns || 92));
  const totalCacheRatio = (totals.cacheRead + totals.cacheCreate + totals.tokensIn) > 0
    ? totals.cacheRead / (totals.cacheRead + totals.cacheCreate + totals.tokensIn)
    : 0;

  const cacheColor =
    totalCacheRatio >= 0.7 ? C.green :
    totalCacheRatio >= 0.4 ? C.yellow :
    C.red;

  // ── BOXED SUMMARY ─────────────────────────────────────────────────────
  const ccTag = CURRENCY_CODE === 'USD' ? '' : ` · ${CURRENCY_CODE}`;
  const plan = PLANS[args.plan] ?? PLANS.api;
  const planTag = args.plan !== 'api' ? ` · ${plan.name}` : '';
  const headerText = `◆ vibecosting · ${label}${ccTag}${planTag}`;
  const boxWidth = Math.max(56, Math.min(74, term - 4));
  const lineH = '─'.repeat(boxWidth);
  const top    = `╭${lineH}╮`;
  const bot    = `╰${lineH}╯`;
  const innerPad = boxWidth;

  const rows: string[] = [];
  rows.push(`${C.bold}${C.yellow}${headerText}${C.reset}`);
  rows.push('');

  if (args.plan === 'api') {
    // Pay-per-token: the totals.costUsd IS what you're paying.
    rows.push(`${C.bold}${C.green}${fmtCost(totals.costUsd)}${C.reset}  ${C.dim}total spend (API rates)${C.reset}`);
    rows.push(`${C.bold}${C.cyan}${fmtTok(totals.tokensOut)}${C.reset}  ${C.dim}output tokens · ${fmtTok(totals.tokensIn)} fresh input${C.reset}`);
    rows.push(`${C.bold}${C.cyan}${fmtTok(totals.cacheRead)}${C.reset}  ${C.dim}cache read · ${fmtTok(totals.cacheCreate)} cache write${C.reset}`);
    rows.push(`${cacheColor}${(totalCacheRatio*100).toFixed(0)}%${C.reset}  ${C.dim}cache hit · ${totals.sessions} sessions · ${buckets.length} ${args.groupBy}${args.groupBy === 'session' ? '' : 's'}${C.reset}`);
    if ((args as any)._previousLabel) {
      rows.push(`${(args as any)._previousColor}${(args as any)._previousLabel}${C.reset}  ${C.dim}vs previous period${C.reset}`);
    }
    if ((args as any)._forecastLabel) {
      rows.push(`${C.bold}${C.yellow}${(args as any)._forecastLabel}${C.reset}  ${C.dim}projected (at current run rate)${C.reset}`);
    }
    if (totals.costUsd > 50 && !(args as any)._previousLabel) {
      rows.push('');
      rows.push(`${C.dim}${C.yellow}⚠ on a Claude subscription? add --plan max-20x to reframe${C.reset}`);
    }
  } else {
    // Subscription: show plan price + API-equivalent + neutral multiple.
    // The multiple is a TOKEN-COST ratio, NOT a "value" or "intelligence" ratio.
    // Same model, same outputs — just different billing path.
    const planUsd = plan.usdPerMonth;
    const overage = args.overageUsd ?? 0;
    const actualPaid = planUsd + overage;
    const apiEquiv = totals.costUsd;
    const ratio = actualPaid > 0 ? apiEquiv / actualPaid : 0;

    rows.push(`${C.bold}${C.green}${fmtCost(actualPaid)}${C.reset}  ${C.dim}what you actually pay${overage > 0 ? ` (${fmtCost(planUsd)} plan + ${fmtCost(overage)} overage)` : ` (${plan.name})`}${C.reset}`);
    rows.push(`${C.bold}${C.cyan}${fmtCost(apiEquiv)}${C.reset}  ${C.dim}token-cost at raw API rates (same model, different billing)${C.reset}`);
    rows.push(`${C.bold}${C.cyan}${fmtTok(totals.cacheRead)}${C.reset}  ${C.dim}cache read · ${fmtTok(totals.cacheCreate)} cache write${C.reset}`);
    if (ratio > 1) {
      rows.push(`${C.dim}${ratio.toFixed(1)}×${C.reset}  ${C.dim}per-token cost ratio (not a value/capability ratio)${C.reset}`);
    }
    rows.push(`${cacheColor}${(totalCacheRatio*100).toFixed(0)}%${C.reset}  ${C.dim}cache hit · ${totals.sessions} sessions · ${buckets.length} ${args.groupBy}${args.groupBy === 'session' ? '' : 's'}${C.reset}`);

    if ((args as any)._previousLabel) {
      rows.push(`${(args as any)._previousColor}${(args as any)._previousLabel}${C.reset}  ${C.dim}vs previous period${C.reset}`);
    }
    if ((args as any)._forecastLabel) {
      rows.push(`${C.bold}${C.yellow}${(args as any)._forecastLabel}${C.reset}  ${C.dim}projected (at current run rate)${C.reset}`);
    }
    if (totalCacheRatio > 0.7) {
      rows.push('');
      rows.push(`${C.dim}note: ${(totalCacheRatio*100).toFixed(0)}% cache means most "raw cost" is repeated context.${C.reset}`);
      rows.push(`${C.dim}      at API rates you'd architect prompts to use less of it.${C.reset}`);
    }
    if (overage === 0 && args.plan !== 'free') {
      rows.push('');
      rows.push(`${C.dim}grab actual overage from claude.ai → Settings → Usage, pass --overage N${C.reset}`);
    }
  }

  console.log();
  console.log(`  ${C.dim}${top}${C.reset}`);
  for (const r of rows) {
    const visible = stripAnsi(r);
    const padding = ' '.repeat(Math.max(0, innerPad - visible.length - 4));
    console.log(`  ${C.dim}│${C.reset}  ${r}${padding}  ${C.dim}│${C.reset}`);
  }
  console.log(`  ${C.dim}${bot}${C.reset}`);
  console.log();

  // ── TABLE ─────────────────────────────────────────────────────────────
  const visible = buckets.slice(0, args.top);
  if (visible.length === 0) {
    console.log(`  ${C.dim}(no activity in window)${C.reset}`);
    console.log();
    return;
  }

  // ── BY-HOUR: dedicated layout (24 rows, hour label + bar) ─────────────
  if (args.groupBy === 'hour') {
    const hourly = buckets;     // already 24 buckets sorted 0..23
    const maxC = Math.max(...hourly.map(b => b.costUsd));
    const totC = hourly.reduce((a, b) => a + b.costUsd, 0);
    if (maxC === 0) {
      console.log(`  ${C.dim}(no activity in window)${C.reset}`);
      console.log();
      return;
    }
    const barW = Math.max(20, Math.min(40, term - 30));
    console.log(`  ${C.dim}cost by hour-of-day (local time)${C.reset}`);
    console.log();
    for (const b of hourly) {
      const frac = maxC > 0 ? b.costUsd / maxC : 0;
      const share = totC > 0 ? b.costUsd / totC : 0;
      const cost = lpad(fmtCost(b.costUsd), 7);
      const isPeak = b.costUsd === maxC;
      const barCol = isPeak ? C.bold + C.yellow : C.cyan;
      const sharePct = share > 0.001 ? lpad(`${(share*100).toFixed(0)}%`, 4) : '  — ';
      console.log(`   ${C.dim}${b.label}${C.reset}  ${barCol}${bar(frac, barW)}${C.reset}  ${C.dim}${sharePct}${C.reset}  ${C.green}${cost}${C.reset}`);
    }
    console.log();
    return;
  }

  // ── BY-TOOL: tool name + count + bar (no cost) ────────────────────────
  if (args.groupBy === 'tool') {
    const maxN = Math.max(...visible.map(b => b.events));
    const totN = visible.reduce((a, b) => a + b.events, 0);
    const barW = Math.max(16, Math.min(34, term - 32));
    console.log(`  ${C.dim}tool calls (no per-tool $ — claude doesn't bill that way)${C.reset}`);
    console.log();
    for (let i = 0; i < visible.length; i++) {
      const b = visible[i];
      const isTop = i === 0;
      const frac = maxN > 0 ? b.events / maxN : 0;
      const share = totN > 0 ? b.events / totN : 0;
      const sharePct = lpad(`${(share*100).toFixed(0)}%`, 4);
      const count = lpad(String(b.events), 5);
      const barCol = isTop ? C.bold + C.yellow : C.cyan;
      const lbl = pad(truncate(b.label, 18), 18);
      const rank = isTop ? `${C.bold}${C.yellow}▸${C.reset}` : ' ';
      console.log(`  ${rank} ${C.bold}${C.green}${count}${C.reset}  ${barCol}${bar(frac, barW)}${C.reset}  ${C.dim}${sharePct}${C.reset}  ${C.cyan}${lbl}${C.reset}`);
    }
    console.log();
    return;
  }

  // For day grouping, emit a sparkline summary above the table.
  if (args.groupBy === 'day') {
    const sorted = [...buckets].sort((a, b) => a.key.localeCompare(b.key));
    const series = sorted.map(b => b.costUsd);
    const spark = sparkline(series);
    const days = sorted.length;
    console.log(`  ${C.dim}trend (${days}d)${C.reset}  ${C.cyan}${spark}${C.reset}`);
    console.log();
  }

  // Standard project/model/session/day rendering with model badge column.
  const maxCost = Math.max(...visible.map(b => b.costUsd));
  const labelWidth = Math.min(34, Math.max(14, ...visible.map(b => b.label.length)));
  const barWidth = Math.max(8, Math.min(20, term - labelWidth - 64));
  const showModel = args.groupBy === 'project' || args.groupBy === 'session';

  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    const isTop = i === 0;
    const share = totals.costUsd > 0 ? b.costUsd / totals.costUsd : 0;
    const barFrac = maxCost > 0 ? b.costUsd / maxCost : 0;

    const cost = lpad(fmtCost(b.costUsd), 7);
    const lbl  = pad(truncate(b.label, labelWidth), labelWidth);
    const sess = lpad(String(b.sessions), 3);

    const ratio = (b.cacheRead + b.cacheCreate + b.tokensIn) > 0
      ? b.cacheRead / (b.cacheRead + b.cacheCreate + b.tokensIn)
      : 0;
    const ratioStr = ratio > 0 ? lpad(`${(ratio*100).toFixed(0)}%`, 4) : '  — ';
    const ratioCol = ratio >= 0.7 ? C.green : ratio >= 0.4 ? C.yellow : ratio > 0 ? C.red : C.dim;

    const sharePct = lpad(`${(share*100).toFixed(0)}%`, 4);
    const barCol = isTop ? C.bold + C.yellow : C.cyan;
    const costCol = isTop ? C.bold + C.green : C.green;

    const barStr = `${barCol}${bar(barFrac, barWidth)}${C.reset}`;
    const rank = isTop ? `${C.bold}${C.yellow}▸${C.reset}` : ' ';

    // Model badge — most-used model in this bucket (project) or session
    let modelBadge = '';
    if (showModel && b.models && b.models.size > 0) {
      const m = Array.from(b.models)[0];
      modelBadge = ` ${C.magenta}${pad(shortModel(m), 9)}${C.reset}`;
    }

    console.log(`  ${rank} ${costCol}${cost}${C.reset}  ${barStr}  ${C.dim}${sharePct}${C.reset}  ${C.cyan}${lbl}${C.reset}${modelBadge}  ${C.dim}${sess} sess · ${ratioCol}${ratioStr}${C.reset}${C.dim} cache${C.reset}`);
  }

  if (buckets.length > visible.length) {
    console.log();
    console.log(`  ${C.dim}+ ${buckets.length - visible.length} more · ${args.range === 'all' ? 'try --top 50' : 'try --all'}${C.reset}`);
  }
  console.log();
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log('vibecosting 0.3.2');
    return;
  }

  setCurrency(args.currency, args.customRate);

  if (args.showPricing) {
    console.log();
    console.log(`  ${C.bold}${C.yellow}◆ pricing table${C.reset}  ${C.dim}· per 1M tokens · in ${CURRENCY_CODE}${C.reset}`);
    console.log();
    const cols = `${pad('model', 10)}  ${lpad('input', 8)}  ${lpad('output', 8)}  ${lpad('cache R', 8)}  ${lpad('cache W5', 8)}  ${lpad('cache W1h', 9)}`;
    console.log(`  ${C.dim}${cols}${C.reset}`);
    for (const [name, p] of Object.entries(PRICING)) {
      console.log(`  ${pad(name, 10)}  ${lpad(fmtCost(p.in), 8)}  ${lpad(fmtCost(p.out), 8)}  ${lpad(fmtCost(p.cacheRead), 8)}  ${lpad(fmtCost(p.cacheWrite5m), 8)}  ${lpad(fmtCost(p.cacheWrite1h), 9)}`);
    }
    console.log();
    console.log(`  ${C.dim}rates as of ship time. update src/parse.ts if Anthropic changes.${C.reset}`);
    if (CURRENCY_CODE !== 'USD') {
      console.log(`  ${C.dim}1 USD = ${CURRENCY_RATE} ${CURRENCY_CODE} (approximate, baked at v0.1.1)${C.reset}`);
    }
    console.log();
    return;
  }

  const all = loadAllSessions();
  if (all.length === 0) {
    console.error(`${C.yellow}No sessions found in ~/.claude/projects/${C.reset}`);
    console.error(`${C.dim}Have you run \`claude\` at least once?${C.reset}`);
    process.exit(1);
  }

  const start = rangeStart(args.range, args.since);
  const now = Date.now();
  const inRange = all.filter(s => (s.lastTs || s.firstTs) >= start);

  // ── Compute --vs-previous comparison ─────────────────────────────────
  if (args.vsPrevious && start > 0) {
    const periodLen = now - start;
    const prevStart = start - periodLen;
    const prevEnd = start;
    const prevSessions = all.filter(s => {
      const t = s.lastTs || s.firstTs;
      return t >= prevStart && t < prevEnd;
    });
    const currentTotal = inRange.reduce((acc, s) => acc + s.costUsd, 0);
    const previousTotal = prevSessions.reduce((acc, s) => acc + s.costUsd, 0);
    if (previousTotal > 0) {
      const delta = currentTotal - previousTotal;
      const pct = (delta / previousTotal) * 100;
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
      const sign = delta > 0 ? '+' : '';
      const col = delta > 0 ? '\x1b[31m' : delta < 0 ? '\x1b[32m' : '\x1b[2m';
      (args as any)._previousLabel = `${arrow} ${sign}${pct.toFixed(0)}%  (was ${fmtCost(previousTotal)})`;
      (args as any)._previousColor = col;
    } else if (currentTotal > 0) {
      (args as any)._previousLabel = `▲ new period (no prior data)`;
      (args as any)._previousColor = '\x1b[2m';
    }
  }

  // ── Compute --forecast: project end-of-period spend at current run rate ──
  // Only meaningful for partial periods (calendar-month, today) — trailing
  // windows like --week / --month are always full and have no "end".
  if (args.forecast && start > 0 && (args.range === 'calendar-month' || args.range === 'today')) {
    const elapsed = Math.max(1, now - start);
    let totalLen: number;
    if (args.range === 'today') {
      totalLen = 86400 * 1000;   // 24h
    } else { // calendar-month
      const d = new Date(now);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      totalLen = lastDay * 86400 * 1000;
    }
    const cur = inRange.reduce((acc, s) => acc + s.costUsd, 0);
    if (cur > 0 && elapsed < totalLen) {
      const projected = cur * (totalLen / elapsed);
      const eta = args.range === 'today' ? 'end of today' : 'end of month';
      (args as any)._forecastLabel = `${fmtCost(projected)}  by ${eta}`;
    }
  } else if (args.forecast) {
    (args as any)._forecastLabel = '— forecast needs --today or --calendar-month';
  }

  const buckets = bucket(inRange, args.groupBy);

  const totals: Bucket = inRange.reduce((acc, s) => {
    acc.costUsd      += s.costUsd;
    acc.tokensIn     += s.tokensIn;
    acc.tokensOut    += s.tokensOut;
    acc.cacheRead    += s.cacheRead;
    acc.cacheCreate  += s.cacheCreate;
    acc.cacheCreate5m += s.cacheCreate5m;
    acc.cacheCreate1h += s.cacheCreate1h;
    acc.events       += s.events;
    acc.sessions     += 1;
    return acc;
  }, { key: 'all', label: 'total', costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, cacheCreate5m: 0, cacheCreate1h: 0, events: 0, sessions: 0 });

  if (args.json) {
    const plan = PLANS[args.plan] ?? PLANS.api;
    const overage = args.overageUsd ?? 0;
    const actualPaidUsd = args.plan === 'api' ? totals.costUsd : plan.usdPerMonth + overage;
    console.log(JSON.stringify({
      range: rangeLabel(args.range, args.since),
      groupBy: args.groupBy,
      currency: CURRENCY_CODE,
      currencyRate: CURRENCY_RATE,
      plan: { id: args.plan, name: plan.name, usdPerMonth: plan.usdPerMonth, overageUsd: overage, actualPaidUsd },
      totals: {
        apiEquivCostUsd: round(totals.costUsd, 4),
        actualPaidUsd: round(actualPaidUsd, 4),
        valueRatio: actualPaidUsd > 0 ? round(totals.costUsd / actualPaidUsd, 2) : 0,
        costUsd: round(totals.costUsd, 4),
        cost: round(totals.costUsd * CURRENCY_RATE, 4),
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        cacheRead: totals.cacheRead,
        cacheCreate: totals.cacheCreate,
        cacheCreate5m: totals.cacheCreate5m,
        cacheCreate1h: totals.cacheCreate1h,
        totalInputTokens: totals.tokensIn + totals.cacheRead + totals.cacheCreate,
        events: totals.events,
        sessions: totals.sessions,
      },
      rows: buckets.slice(0, args.top).map(b => ({
        key: b.key,
        label: b.label,
        costUsd: round(b.costUsd, 4),
        cost: round(b.costUsd * CURRENCY_RATE, 4),
        tokensIn: b.tokensIn,
        tokensOut: b.tokensOut,
        cacheRead: b.cacheRead,
        cacheCreate: b.cacheCreate,
        cacheCreate5m: b.cacheCreate5m,
        cacheCreate1h: b.cacheCreate1h,
        totalInputTokens: b.tokensIn + b.cacheRead + b.cacheCreate,
        events: b.events,
        sessions: b.sessions,
        models: b.models ? Array.from(b.models) : undefined,
      })),
    }, null, 2));
    return;
  }

  render(buckets, totals, args, rangeLabel(args.range, args.since));
}

function round(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
