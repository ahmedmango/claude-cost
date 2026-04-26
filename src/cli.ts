#!/usr/bin/env bun
// claude-cost — see what you've spent on Claude Code.

import { loadAllSessions, shortPath, type Session } from './parse.ts';

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
  range: 'today' | 'week' | 'month' | 'all';
  since?: number;
  groupBy: 'project' | 'model' | 'day' | 'session';
  top: number;
  json: boolean;
  help: boolean;
  version: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { range: 'month', groupBy: 'project', top: 10, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--today') a.range = 'today';
    else if (v === '--week') a.range = 'week';
    else if (v === '--month') a.range = 'month';
    else if (v === '--all' || v === '--lifetime') a.range = 'all';
    else if (v === '--since' && argv[i+1]) {
      const t = Date.parse(argv[++i]);
      if (Number.isFinite(t)) a.since = t;
    }
    else if (v === '--by-project') a.groupBy = 'project';
    else if (v === '--by-model')   a.groupBy = 'model';
    else if (v === '--by-day')     a.groupBy = 'day';
    else if (v === '--by-session') a.groupBy = 'session';
    else if (v === '--top' && argv[i+1]) a.top = Number(argv[++i]) || 10;
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
${C.bold}claude-cost${C.reset} — what you've spent on Claude Code

${C.bold}USAGE${C.reset}
  ${C.cyan}claude-cost${C.reset} [range] [grouping] [options]

${C.bold}RANGE${C.reset} (default: --month)
  --today          activity since 00:00 today
  --week           last 7 days
  --month          last 30 days
  --all            lifetime
  --since DATE     ISO date, e.g. 2026-01-01

${C.bold}GROUPING${C.reset} (default: --by-project)
  --by-project     group by repo / cwd
  --by-model       group by model
  --by-day         group by calendar day
  --by-session     one row per session

${C.bold}OUTPUT${C.reset}
  --top N          show top N rows (default 10)
  --json, -j       machine-readable JSON
  --help, -h       this help
  --version, -v    print version

${C.bold}EXAMPLES${C.reset}
  ${C.dim}# How much did I spend this month?${C.reset}
  claude-cost

  ${C.dim}# Top 5 most expensive projects this week${C.reset}
  claude-cost --week --top 5

  ${C.dim}# Cost broken down by model, all time${C.reset}
  claude-cost --all --by-model

  ${C.dim}# Daily spend in JSON for a chart${C.reset}
  claude-cost --month --by-day --json | jq

${C.dim}Reads ~/.claude/projects/*.jsonl. No network. No telemetry.${C.reset}
`;

// ─── DATE WINDOW ─────────────────────────────────────────────────────────
function rangeStart(range: Args['range'], since?: number): number {
  if (since) return since;
  const now = new Date();
  if (range === 'all') return 0;
  if (range === 'today') {
    const d = new Date(now); d.setHours(0,0,0,0); return d.getTime();
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
  if (range === 'all') return 'lifetime';
  return range;
}

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────
function fmtCost(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 100)  return `$${n.toFixed(1)}`;
  if (n >= 1)    return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
function fmtTok(n: number): string {
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
  events: number;
  sessions: number;
  models?: Set<string>;
};

function bucket(sessions: Session[], by: Args['groupBy']): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of sessions) {
    let key: string, label: string;
    if (by === 'project') { key = s.projectPath; label = shortPath(s.projectPath); }
    else if (by === 'model') {
      // Use most-recent model (or 'unknown' if none)
      key = s.model ?? '(unknown)';
      label = key;
    }
    else if (by === 'day') {
      const d = s.lastTs ? new Date(s.lastTs) : null;
      key = d ? d.toISOString().slice(0, 10) : '(no date)';
      label = key;
    }
    else /* session */ { key = s.id; label = s.id.slice(0, 8); }

    let b = map.get(key);
    if (!b) {
      b = { key, label, costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, events: 0, sessions: 0, models: new Set() };
      map.set(key, b);
    }
    b.costUsd      += s.costUsd;
    b.tokensIn     += s.tokensIn;
    b.tokensOut    += s.tokensOut;
    b.cacheRead    += s.cacheRead;
    b.cacheCreate  += s.cacheCreate;
    b.events       += s.events;
    b.sessions     += 1;
    if (s.model) b.models!.add(s.model);
  }
  return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
}

// ─── RENDER ───────────────────────────────────────────────────────────────
function render(buckets: Bucket[], totals: Bucket, args: Args, label: string) {
  const term = process.stdout.columns || 80;
  const totalCacheRatio = (totals.cacheRead + totals.cacheCreate + totals.tokensIn) > 0
    ? totals.cacheRead / (totals.cacheRead + totals.cacheCreate + totals.tokensIn)
    : 0;

  const cacheColor =
    totalCacheRatio >= 0.7 ? C.green :
    totalCacheRatio >= 0.4 ? C.yellow :
    C.red;

  // ── Header ────────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${C.bold}${C.yellow}◆ claude-cost${C.reset}  ${C.dim}· ${label}${C.reset}`);
  console.log();
  console.log(`  ${C.bold}${C.green}${fmtCost(totals.costUsd)}${C.reset} total  ${C.dim}·${C.reset}  ${fmtTok(totals.tokensOut)} out  ${C.dim}·${C.reset}  ${fmtTok(totals.tokensIn)} in`);
  console.log(`  ${cacheColor}${(totalCacheRatio*100).toFixed(0)}%${C.reset}${C.dim} cache hit · ${totals.sessions} sessions · ${buckets.length} ${args.groupBy}${args.groupBy === 'session' ? '' : 's'}${C.reset}`);
  console.log();

  // ── Table ─────────────────────────────────────────────────────────────
  const top = buckets.slice(0, args.top);
  if (top.length === 0) {
    console.log(`  ${C.dim}(no activity in window)${C.reset}`);
    console.log();
    return;
  }

  const labelWidth = Math.min(38, Math.max(12, ...top.map(b => b.label.length)));
  const sep = `  ${C.dim}${'─'.repeat(Math.min(70, term - 4))}${C.reset}`;
  console.log(sep);

  for (const b of top) {
    const cost = lpad(fmtCost(b.costUsd), 7);
    const tok  = lpad(fmtTok(b.tokensOut), 6);
    const lbl  = pad(truncate(b.label, labelWidth), labelWidth);
    const sess = lpad(String(b.sessions), 3);
    const evs  = lpad(String(b.events), 4);
    const ratio = (b.cacheRead + b.cacheCreate + b.tokensIn) > 0
      ? b.cacheRead / (b.cacheRead + b.cacheCreate + b.tokensIn)
      : 0;
    const ratioStr = ratio > 0 ? `${(ratio*100).toFixed(0)}%` : '— ';
    const ratioCol = ratio >= 0.7 ? C.green : ratio >= 0.4 ? C.yellow : ratio > 0 ? C.red : C.dim;
    console.log(`   ${C.bold}${C.green}${cost}${C.reset}  ${C.cyan}${lbl}${C.reset}  ${C.dim}${tok} out · ${evs} ev · ${sess} sess · cache ${C.reset}${ratioCol}${ratioStr}${C.reset}`);
  }
  console.log(sep);

  if (buckets.length > top.length) {
    console.log(`  ${C.dim}${buckets.length - top.length} more · ${args.range === 'all' ? 'try --top 50' : 'try --all'}${C.reset}`);
  }
  console.log();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log('claude-cost 0.1.0');
    return;
  }

  const all = loadAllSessions();
  if (all.length === 0) {
    console.error(`${C.yellow}No sessions found in ~/.claude/projects/${C.reset}`);
    console.error(`${C.dim}Have you run \`claude\` at least once?${C.reset}`);
    process.exit(1);
  }

  const start = rangeStart(args.range, args.since);
  const inRange = all.filter(s => (s.lastTs || s.firstTs) >= start);

  const buckets = bucket(inRange, args.groupBy);

  const totals: Bucket = inRange.reduce((acc, s) => {
    acc.costUsd      += s.costUsd;
    acc.tokensIn     += s.tokensIn;
    acc.tokensOut    += s.tokensOut;
    acc.cacheRead    += s.cacheRead;
    acc.cacheCreate  += s.cacheCreate;
    acc.events       += s.events;
    acc.sessions     += 1;
    return acc;
  }, { key: 'all', label: 'total', costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, events: 0, sessions: 0 });

  if (args.json) {
    console.log(JSON.stringify({
      range: rangeLabel(args.range, args.since),
      groupBy: args.groupBy,
      totals: {
        costUsd: round(totals.costUsd, 4),
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        cacheRead: totals.cacheRead,
        cacheCreate: totals.cacheCreate,
        events: totals.events,
        sessions: totals.sessions,
      },
      rows: buckets.slice(0, args.top).map(b => ({
        key: b.key,
        label: b.label,
        costUsd: round(b.costUsd, 4),
        tokensIn: b.tokensIn,
        tokensOut: b.tokensOut,
        cacheRead: b.cacheRead,
        cacheCreate: b.cacheCreate,
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
