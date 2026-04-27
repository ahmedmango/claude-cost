#!/usr/bin/env bun
// vibecosting — see what you've spent on Claude Code.

import { loadAllSessions, shortPath, shortModel, CURRENCIES, PRICING, PLANS, priceFor, type Session } from './parse.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.vibecosting.json');

type Config = { plan?: string; overage?: number; currency?: string };

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config; }
  catch { return {}; }
}
function saveConfig(c: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

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
  watch: boolean;
  wrapped: boolean;
  advise: boolean;
  subcommand?: string;       // 'setup' | undefined
};

function parseArgs(argv: string[]): Args {
  // Subcommand sniff (must be first arg, non-flag): vibecosting setup
  let subcommand: string | undefined;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    if (['setup', 'config'].includes(argv[0])) {
      subcommand = argv[0];
      argv = argv.slice(1);
    }
  }
  // Load saved config; flags / env override.
  const cfg = loadConfig();
  const a: Args = {
    range: 'month',
    groupBy: 'project',
    top: 10,
    json: false,
    help: false,
    version: false,
    currency: (process.env.CLAUDE_COST_CURRENCY || cfg.currency || 'USD').toUpperCase(),
    customRate: process.env.CLAUDE_COST_RATE ? Number(process.env.CLAUDE_COST_RATE) : undefined,
    showPricing: false,
    plan: process.env.CLAUDE_COST_PLAN || cfg.plan || 'api',
    overageUsd:
      process.env.CLAUDE_COST_OVERAGE ? Number(process.env.CLAUDE_COST_OVERAGE)
      : cfg.overage,
    vsPrevious: false,
    forecast: false,
    watch: false,
    wrapped: false,
    advise: false,
    subcommand,
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
    else if (v === '--watch' || v === '-w') a.watch = true;
    else if (v === '--wrapped') a.wrapped = true;
    else if (v === '--advise' || v === '--advice' || v === '--audit') a.advise = true;
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

${C.bold}MODES${C.reset}
  ${C.cyan}vibecosting setup${C.reset}    interactive wizard, saves ~/.vibecosting.json
  --advise          coaching analysis: cache, model mix, errors, plan fit
  --wrapped         Spotify-Wrapped-style recap card (great for sharing)
  --watch, -w       refresh every 5s in place; see live deltas as you code

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
  const noMinor = ['JPY', 'KRW', 'NGN', 'INR'].includes(CURRENCY_CODE);
  if (noMinor) {
    if (n >= 1_000_000) return `${CURRENCY_SYMBOL}${(n/1_000_000).toFixed(1)}M`;
    if (n >= 100_000)   return `${CURRENCY_SYMBOL}${(n/1000).toFixed(0)}K`;
    return `${CURRENCY_SYMBOL}${Math.round(n).toLocaleString('en-US')}`;
  }
  if (n >= 1_000_000) return `${CURRENCY_SYMBOL}${(n/1_000_000).toFixed(2)}M`;
  if (n >= 100_000)   return `${CURRENCY_SYMBOL}${(n/1000).toFixed(0)}K`;
  if (n >= 1000)      return `${CURRENCY_SYMBOL}${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100)       return `${CURRENCY_SYMBOL}${n.toFixed(0)}`;     // $157
  if (n >= 1)         return `${CURRENCY_SYMBOL}${n.toFixed(2)}`;     // $29.71
  return `${CURRENCY_SYMBOL}${n.toFixed(3)}`;                          // $0.123
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

// =============================================================================
// SETUP WIZARD — interactive plan/overage picker, saves ~/.vibecosting.json
// =============================================================================
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
  });
}

async function runSetup() {
  const existing = loadConfig();
  console.log();
  console.log(`  ${C.bold}${C.yellow}◆ vibecosting setup${C.reset}  ${C.dim}· saves to ~/.vibecosting.json${C.reset}`);
  console.log();
  console.log(`  ${C.dim}Pick a plan. Default value (in brackets) will be used if you press Enter.${C.reset}`);
  console.log();

  const planOptions = ['api', 'free', 'pro', 'max-5x', 'max-20x', 'team', 'enterprise'];
  console.log('  ' + planOptions.map((p, i) => `${C.cyan}${i+1}${C.reset} ${p}`).join('   '));
  const planDefault = existing.plan || 'api';
  const planAns = (await readLine(`  Plan [${planDefault}]: `)).trim();
  let plan = planDefault;
  if (planAns) {
    const idx = Number(planAns);
    if (idx >= 1 && idx <= planOptions.length) plan = planOptions[idx-1];
    else if (planOptions.includes(planAns)) plan = planAns;
    else console.log(`  ${C.yellow}unrecognized plan, using ${planDefault}${C.reset}`);
  }

  const overageDefault = existing.overage ?? 0;
  const overAns = (await readLine(`  Monthly overage in USD (from claude.ai → Settings → Usage) [${overageDefault}]: `)).trim();
  const overage = overAns ? Number(overAns) || 0 : overageDefault;

  const currencyDefault = existing.currency || 'USD';
  const ccAns = (await readLine(`  Display currency [${currencyDefault}]: `)).trim().toUpperCase();
  const currency = ccAns || currencyDefault;
  if (!CURRENCIES[currency]) {
    console.log(`  ${C.yellow}unknown currency, using USD${C.reset}`);
  }

  const cfg: Config = { plan, overage, currency: CURRENCIES[currency] ? currency : 'USD' };
  saveConfig(cfg);
  console.log();
  console.log(`  ${C.green}✓${C.reset} saved to ${C.cyan}${CONFIG_PATH}${C.reset}`);
  console.log(`  ${C.dim}you can now run \`vibecosting\` and it'll use these defaults.${C.reset}`);
  console.log();
}

// =============================================================================
// WRAPPED — Spotify-Wrapped-style recap card
// =============================================================================
function runWrapped(all: Session[], args: Args, label: string) {
  const start = rangeStart(args.range, args.since);
  const inRange = all.filter(s => (s.lastTs || s.firstTs) >= start);
  if (inRange.length === 0) {
    console.error(`${C.yellow}no activity in window${C.reset}`);
    return;
  }

  // Aggregates
  const totalCost = inRange.reduce((a, s) => a + s.costUsd, 0);
  const tokensOut = inRange.reduce((a, s) => a + s.tokensOut, 0);
  const cacheRead = inRange.reduce((a, s) => a + s.cacheRead, 0);
  const cacheCreate = inRange.reduce((a, s) => a + s.cacheCreate, 0);
  const tokensIn = inRange.reduce((a, s) => a + s.tokensIn, 0);
  const cacheHit = (cacheRead + cacheCreate + tokensIn) > 0
    ? cacheRead / (cacheRead + cacheCreate + tokensIn) : 0;

  // Most expensive day
  const dayTotals = new Map<string, number>();
  for (const s of inRange) {
    for (const [day, c] of s.dayBuckets) {
      dayTotals.set(day, (dayTotals.get(day) ?? 0) + c);
    }
  }
  let topDay = ['', 0] as [string, number];
  for (const [d, c] of dayTotals) if (c > topDay[1]) topDay = [d, c];

  // Peak hour
  const hourTotals = new Array(24).fill(0);
  for (const s of inRange) for (let h = 0; h < 24; h++) hourTotals[h] += s.hourBuckets[h];
  let topHour = 0, topHourVal = 0;
  for (let h = 0; h < 24; h++) if (hourTotals[h] > topHourVal) { topHourVal = hourTotals[h]; topHour = h; }

  // Favorite tool
  const toolTotals = new Map<string, number>();
  for (const s of inRange) for (const [t, c] of s.toolCounts) toolTotals.set(t, (toolTotals.get(t) ?? 0) + c);
  let topTool = ['', 0] as [string, number];
  for (const [t, c] of toolTotals) if (c > topTool[1]) topTool = [t, c];

  // Dominant project
  const projTotals = new Map<string, number>();
  for (const s of inRange) projTotals.set(s.projectPath, (projTotals.get(s.projectPath) ?? 0) + s.costUsd);
  let topProj = ['', 0] as [string, number];
  for (const [p, c] of projTotals) if (c > topProj[1]) topProj = [p, c];
  const projShare = totalCost > 0 ? topProj[1] / totalCost : 0;

  // Plan reframe
  const plan = PLANS[args.plan] ?? PLANS.api;
  const overage = args.overageUsd ?? 0;
  const actualPaid = args.plan === 'api' ? totalCost : plan.usdPerMonth + overage;

  // Clean column layout — left-aligned label, value, optional context
  const W = 64;
  const line = '─'.repeat(W);
  console.log();
  console.log(`  ${C.dim}╭${line}╮${C.reset}`);

  const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padRight = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visLen(s)));
  const padLeft  = (s: string, n: number) => ' '.repeat(Math.max(0, n - visLen(s))) + s;

  const blank = () => console.log(`  ${C.dim}│${C.reset}${' '.repeat(W)}${C.dim}│${C.reset}`);
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((W - visLen(s)) / 2));
    console.log(`  ${C.dim}│${C.reset}${' '.repeat(pad)}${s}${' '.repeat(W - pad - visLen(s))}${C.dim}│${C.reset}`);
  };
  // padded row, indent of 4 chars on left
  const kvrow = (label: string, value: string, note: string = '') => {
    const inner = `    ${C.dim}${padRight(label, 14)}${C.reset}  ${value}${note ? '   ' + C.dim + note + C.reset : ''}`;
    console.log(`  ${C.dim}│${C.reset}${padRight(inner, W)}${C.dim}│${C.reset}`);
  };
  const headerLine = (s: string) => {
    const inner = `    ${s}`;
    console.log(`  ${C.dim}│${C.reset}${padRight(inner, W)}${C.dim}│${C.reset}`);
  };

  blank();
  center(`${C.bold}${C.yellow}◆ YOUR ${label.toUpperCase()}${C.reset}`);
  blank();
  headerLine(`${C.bold}${C.green}${padLeft(fmtCost(totalCost), 8)}${C.reset}   ${C.dim}token-cost at API rates${C.reset}`);
  if (args.plan !== 'api') {
    headerLine(`${C.bold}${C.cyan}${padLeft(fmtCost(actualPaid), 8)}${C.reset}   ${C.dim}what you actually paid${C.reset}`);
  }
  blank();
  kvrow('project',    `${C.bold}${C.cyan}${shortPath(topProj[0])}${C.reset}`, `${(projShare*100).toFixed(0)}% of total`);
  kvrow('peak day',   `${C.bold}${C.yellow}${topDay[0]}${C.reset}`,           `${fmtCost(topDay[1])}`);
  kvrow('peak hour',  `${C.bold}${C.yellow}${String(topHour).padStart(2,'0')}:00${C.reset}`, `${fmtCost(topHourVal)} that hour`);
  kvrow('top tool',   `${C.bold}${C.cyan}${topTool[0]}${C.reset}`,            `${topTool[1].toLocaleString('en-US')} calls`);
  kvrow('cache hit',  `${C.bold}${C.green}${(cacheHit*100).toFixed(0)}%${C.reset}`);
  kvrow('out tokens', `${C.bold}${C.cyan}${fmtTok(tokensOut)}${C.reset}`,     'shipped');
  blank();
  center(`${C.dim}share: github.com/ahmedmango/vibecosting${C.reset}`);
  blank();
  console.log(`  ${C.dim}╰${line}╯${C.reset}`);
  console.log();
}

// =============================================================================
// ADVISE — coaching analysis from local data
// =============================================================================
function runAdvise(all: Session[], args: Args, label: string) {
  const start = rangeStart(args.range, args.since);
  const inRange = all.filter(s => (s.lastTs || s.firstTs) >= start);
  if (inRange.length === 0) {
    console.error(`${C.yellow}no activity in window — nothing to analyze${C.reset}`);
    return;
  }

  // Aggregates
  const totalCost = inRange.reduce((a, s) => a + s.costUsd, 0);
  const tokensIn  = inRange.reduce((a, s) => a + s.tokensIn, 0);
  const cacheRead = inRange.reduce((a, s) => a + s.cacheRead, 0);
  const cacheCreate = inRange.reduce((a, s) => a + s.cacheCreate, 0);
  const cacheHit = (cacheRead + cacheCreate + tokensIn) > 0
    ? cacheRead / (cacheRead + cacheCreate + tokensIn) : 0;

  // Model dominance
  const modelCount = new Map<string, number>();
  for (const s of inRange) {
    if (!s.dominantModel) continue;
    modelCount.set(s.dominantModel, (modelCount.get(s.dominantModel) ?? 0) + 1);
  }
  const opusSessions = Array.from(modelCount.entries()).filter(([m]) => /opus/i.test(m)).reduce((a, [, c]) => a + c, 0);
  const haikuSessions = Array.from(modelCount.entries()).filter(([m]) => /haiku/i.test(m)).reduce((a, [, c]) => a + c, 0);
  const opusShare = inRange.length > 0 ? opusSessions / inRange.length : 0;
  const haikuShare = inRange.length > 0 ? haikuSessions / inRange.length : 0;

  // Tool-call mix
  const toolTotals = new Map<string, number>();
  for (const s of inRange) for (const [t, c] of s.toolCounts) toolTotals.set(t, (toolTotals.get(t) ?? 0) + c);
  const totalTools = Array.from(toolTotals.values()).reduce((a, b) => a + b, 0);
  const cheapTools = ['Read', 'Grep', 'Glob', 'Bash'];
  const cheapCount = cheapTools.reduce((a, t) => a + (toolTotals.get(t) ?? 0), 0);
  const cheapShare = totalTools > 0 ? cheapCount / totalTools : 0;

  // Aborted sessions: <3 events
  const aborted = inRange.filter(s => s.events < 3).length;
  const abortedShare = inRange.length > 0 ? aborted / inRange.length : 0;

  // Error rate
  const totalEvents = inRange.reduce((a, s) => a + s.events, 0);
  const totalErrors = inRange.reduce((a, s) => a + s.errors, 0);
  const errorRate = totalEvents > 0 ? totalErrors / totalEvents : 0;

  // Project concentration
  const projTotals = new Map<string, number>();
  for (const s of inRange) projTotals.set(s.projectPath, (projTotals.get(s.projectPath) ?? 0) + s.costUsd);
  const projVals = Array.from(projTotals.values()).sort((a, b) => b - a);
  const topProjShare = totalCost > 0 ? (projVals[0] ?? 0) / totalCost : 0;

  // Top expensive turn
  let topMsg: { ts: number; cost: number; project: string } | null = null;
  for (const s of inRange) {
    if (s.topMessageCostUsd > (topMsg?.cost ?? 0)) {
      topMsg = { ts: s.topMessageTs, cost: s.topMessageCostUsd, project: shortPath(s.projectPath) };
    }
  }

  // Tool-only turns share (signal that those could've been Haiku)
  const toolOnlyTurns = inRange.reduce((a, s) => a + s.toolOnlyTurns, 0);
  const textTurns     = inRange.reduce((a, s) => a + s.textTurns, 0);
  const toolOnlyShare = (toolOnlyTurns + textTurns) > 0 ? toolOnlyTurns / (toolOnlyTurns + textTurns) : 0;

  // ── Render ──
  console.log();
  console.log(`  ${C.bold}${C.yellow}◆ vibecosting · advice${C.reset}  ${C.dim}· ${label}${C.reset}`);
  console.log(`  ${C.dim}grounded in your ${inRange.length} sessions, ${totalEvents} events, ${fmtCost(totalCost)} of API-equivalent cost${C.reset}`);
  console.log();

  const tip = (icon: string, color: string, title: string, lines: string[]) => {
    console.log(`  ${color}${icon}${C.reset} ${C.bold}${title}${C.reset}`);
    for (const l of lines) console.log(`    ${l}`);
    console.log();
  };

  // 1. Cache
  if (cacheHit < 0.7) {
    const lossEstimate = totalCost * 0.3;   // very rough: half of "cost" is cache reads, low hit means re-buying that
    tip('⚠', C.yellow, `CACHE HIT ${(cacheHit*100).toFixed(0)}%  ${C.dim}— heavy users typically hit 90%+${C.reset}`, [
      `${C.dim}You're paying API-equivalent for context Claude could've reused.${C.reset}`,
      `${C.dim}Rough cost-of-misses if billed at API rates: ~${fmtCost(lossEstimate)}.${C.reset}`,
      `${C.cyan}▸${C.reset} Append to existing conversations rather than ${C.cyan}/clear${C.reset}-ing.`,
      `${C.cyan}▸${C.reset} Use ${C.cyan}/compact${C.reset} when context grows; preserves cache better.`,
    ]);
  } else {
    tip('✓', C.green, `CACHE HIT ${(cacheHit*100).toFixed(0)}%  ${C.dim}— good${C.reset}`, [
      `${C.dim}Most context is being reused efficiently. Keep your conversation flow.${C.reset}`,
    ]);
  }

  // 2. Model mix
  if (opusShare > 0.6 && haikuShare < 0.05 && cheapShare > 0.5) {
    // Many Opus sessions doing simple tool work. Estimate savings if cheap tool turns went to Haiku.
    // Opus is ~19× Haiku per token. Conservative savings estimate.
    const cheapToolSpend = totalCost * cheapShare;
    const ifHaiku = cheapToolSpend / 19;
    const savings = cheapToolSpend - ifHaiku;
    tip('⚠', C.yellow, `MODEL MIX  ${C.dim}— ${(opusShare*100).toFixed(0)}% Opus, ${(haikuShare*100).toFixed(0)}% Haiku${C.reset}`, [
      `${C.dim}${cheapTools.join(' / ')} together = ${(cheapShare*100).toFixed(0)}% of your tool calls.${C.reset}`,
      `${C.dim}Those don't need Opus. At Haiku rates, that slice is ~19× cheaper.${C.reset}`,
      `${C.dim}Rough savings if routed to Haiku: ~${fmtCost(savings)} of API-equivalent value.${C.reset}`,
      `${C.cyan}▸${C.reset} Set up a per-task ${C.cyan}/model haiku${C.reset} workflow for greps/reads/checks.`,
    ]);
  } else if (haikuShare > 0.1) {
    tip('✓', C.green, `MODEL MIX  ${C.dim}— ${(haikuShare*100).toFixed(0)}% Haiku${C.reset}`, [
      `${C.dim}You're routing some work to cheaper models. Good discipline.${C.reset}`,
    ]);
  }

  // 3. Aborted sessions
  if (abortedShare > 0.15) {
    tip('⚠', C.yellow, `ABANDONED STARTS  ${C.dim}— ${aborted}/${inRange.length} sessions <3 events (${(abortedShare*100).toFixed(0)}%)${C.reset}`, [
      `${C.dim}Sessions you started but bailed on. Each still warmed cache + spawned overhead.${C.reset}`,
      `${C.cyan}▸${C.reset} Plan the prompt before you ${C.cyan}/clear${C.reset}.`,
      `${C.cyan}▸${C.reset} Use ${C.cyan}/resume${C.reset} when you come back to a project instead of starting fresh.`,
    ]);
  }

  // 4. Error rate
  if (errorRate > 0.04) {
    tip('⚠', C.yellow, `ERROR RATE  ${C.dim}— ${(errorRate*100).toFixed(1)}%  (typical disciplined users < 2%)${C.reset}`, [
      `${C.dim}${totalErrors} of ${totalEvents} events were tool failures or system errors.${C.reset}`,
      `${C.dim}Each retry is a billable round-trip you didn't need.${C.reset}`,
      `${C.cyan}▸${C.reset} Common culprits: bad ${C.cyan}grep${C.reset} patterns, wrong file paths, missing context.`,
    ]);
  } else {
    tip('✓', C.green, `ERROR RATE  ${C.dim}${(errorRate*100).toFixed(1)}% — disciplined${C.reset}`, [
      `${C.dim}Whatever you're doing prompt-wise, keep it.${C.reset}`,
    ]);
  }

  // 5. Project focus
  if (topProjShare > 0.85) {
    tip('⚠', C.yellow, `PROJECT FOCUS  ${C.dim}— top project = ${(topProjShare*100).toFixed(0)}% of cost${C.reset}`, [
      `${C.dim}Heavy concentration. Fine if intentional; risky if it's accidentally bloating one repo.${C.reset}`,
    ]);
  } else if (topProjShare > 0.5) {
    tip('✓', C.green, `PROJECT FOCUS  ${C.dim}— shipping ${(topProjShare*100).toFixed(0)}% on top project${C.reset}`, [
      `${C.dim}Healthy concentration.${C.reset}`,
    ]);
  } else {
    tip('◆', C.cyan, `PROJECT SPREAD  ${C.dim}— top project only ${(topProjShare*100).toFixed(0)}% of cost${C.reset}`, [
      `${C.dim}You're spread across many repos. Switching cost (cold caches) may be why ${C.reset}`,
      `${C.dim}your cache hit isn't higher.${C.reset}`,
    ]);
  }

  // 6. Top expensive single turn — one compact line
  if (topMsg && topMsg.cost > 5) {
    const dt = new Date(topMsg.ts);
    const when = `${dt.toLocaleString('en-US', { month: 'short', day: 'numeric' })} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
    tip('◆', C.cyan, `MOST EXPENSIVE TURN  ${C.bold}${fmtCost(topMsg.cost)}${C.reset} ${C.dim}· ${when} in ${topMsg.project}${C.reset}`, [
      `${C.dim}Likely a "load the whole codebase" moment. Worth scoping smaller.${C.reset}`,
    ]);
  }

  // 7. Plan fit (rough)
  if (args.plan !== 'api') {
    const plan = PLANS[args.plan] ?? PLANS.api;
    const planCost = plan.usdPerMonth + (args.overageUsd ?? 0);
    const ratio = planCost > 0 ? totalCost / planCost : 0;
    if (ratio < 5) {
      tip('◆', C.cyan, `PLAN FIT  ${C.dim}— ${plan.name}${C.reset}`, [
        `${C.dim}You used ~${ratio.toFixed(1)}× your plan price in API-equivalent value.${C.reset}`,
        `${C.dim}A lower-tier plan would probably suffice. Check claude.ai → Settings → Usage limits.${C.reset}`,
      ]);
    } else if (ratio > 30) {
      tip('◆', C.cyan, `PLAN FIT  ${C.dim}— ${plan.name}${C.reset}`, [
        `${C.dim}You used ~${ratio.toFixed(0)}× your plan price in API-equivalent value.${C.reset}`,
        `${C.dim}You're a heavy user. Stay on this tier or above.${C.reset}`,
      ]);
    }
  }

  console.log(`  ${C.dim}note: estimates are approximate. they're directional, not exact dollars.${C.reset}`);
  console.log();
}

// =============================================================================
// WATCH — refresh every 5s in place
// =============================================================================
async function runWatch(args: Args) {
  let prevCost = -1;
  const refresh = async () => {
    const all = loadAllSessions();
    const start = rangeStart(args.range, args.since);
    const inRange = all.filter(s => (s.lastTs || s.firstTs) >= start);
    const buckets = bucket(inRange, args.groupBy);
    const totals: Bucket = inRange.reduce((acc, s) => {
      acc.costUsd += s.costUsd;
      acc.tokensIn += s.tokensIn;
      acc.tokensOut += s.tokensOut;
      acc.cacheRead += s.cacheRead;
      acc.cacheCreate += s.cacheCreate;
      acc.events += s.events;
      acc.sessions += 1;
      return acc;
    }, newBucket('all', 'total'));
    const delta = prevCost >= 0 ? totals.costUsd - prevCost : 0;
    // ANSI: clear screen + cursor home
    process.stdout.write('\x1b[2J\x1b[H');
    render(buckets, totals, args, rangeLabel(args.range, args.since));
    if (prevCost >= 0) {
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
      const col = delta > 0 ? C.green : delta < 0 ? C.red : C.dim;
      console.log(`  ${C.dim}↻ refreshed · ${col}${arrow} ${delta >= 0 ? '+' : ''}${fmtCost(Math.abs(delta))}${C.reset}${C.dim} since last tick · ctrl-c to stop${C.reset}`);
    } else {
      console.log(`  ${C.dim}↻ watching · refreshes every 5s · ctrl-c to stop${C.reset}`);
    }
    prevCost = totals.costUsd;
  };
  await refresh();
  setInterval(refresh, 5000);
  // keep alive
  await new Promise(() => {});
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log('vibecosting 0.4.1');
    return;
  }

  // Subcommand: setup wizard
  if (args.subcommand === 'setup' || args.subcommand === 'config') {
    await runSetup();
    return;
  }

  setCurrency(args.currency, args.customRate);

  // --watch loops, separate flow
  if (args.watch) {
    await runWatch(args);
    return;
  }

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

  // --wrapped: pretty recap card
  if (args.wrapped) {
    runWrapped(all, args, rangeLabel(args.range, args.since));
    return;
  }

  // --advise: coaching analysis
  if (args.advise) {
    runAdvise(all, args, rangeLabel(args.range, args.since));
    return;
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
