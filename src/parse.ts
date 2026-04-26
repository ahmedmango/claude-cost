// Parse a Claude Code .jsonl transcript and aggregate cost/tokens per session.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// Pricing (USD per 1M tokens). Per Anthropic's published rates as of 2026-04.
//
// SUBSCRIPTION USERS NOTE: if you're on Claude Max/Team flat-rate, what you
// actually pay is $200/month (or whatever your plan is), not these rates.
// This tool computes the API-equivalent cost — useful for "am I overusing
// my plan" or "what would this cost without the subscription".
export const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }> = {
  haiku:  { in:  0.80, out:  4, cacheRead: 0.08, cacheWrite5m:  1.00, cacheWrite1h:  1.60 },
  sonnet: { in:  3.00, out: 15, cacheRead: 0.30, cacheWrite5m:  3.75, cacheWrite1h:  6.00 },
  opus:   { in: 15.00, out: 75, cacheRead: 1.50, cacheWrite5m: 18.75, cacheWrite1h: 30.00 },
};

export function priceFor(model: string | undefined) {
  if (!model) return PRICING.sonnet;
  const m = model.toLowerCase();
  // Order matters: most specific first.
  if (m.includes('opus'))   return PRICING.opus;
  if (m.includes('haiku'))  return PRICING.haiku;
  if (m.includes('sonnet')) return PRICING.sonnet;
  // Synthetic / unknown — assume sonnet (conservative).
  return PRICING.sonnet;
}

// Anthropic subscription plan prices (USD/month). Use to reframe the
// token total as "what you'd pay raw vs what your plan covers".
// Update if Anthropic changes pricing. Source: anthropic.com pricing page.
export const PLANS: Record<string, { name: string; usdPerMonth: number; note: string }> = {
  free:        { name: 'Claude Free',          usdPerMonth: 0,   note: 'free tier' },
  pro:         { name: 'Claude Pro',           usdPerMonth: 20,  note: '5× free limits' },
  'max-5x':    { name: 'Claude Max (5×)',      usdPerMonth: 100, note: '5× Pro limits' },
  'max-20x':   { name: 'Claude Max (20×)',     usdPerMonth: 200, note: '20× Pro limits' },
  team:        { name: 'Claude Team',          usdPerMonth: 30,  note: 'per-seat (premium)' },
  enterprise:  { name: 'Claude Enterprise',    usdPerMonth: 60,  note: 'per-seat estimate' },
  api:         { name: 'API (no subscription)', usdPerMonth: 0,  note: 'pay per token' },
};

// Approximate USD → other currency rates as of 2026-04. NOT live — refresh
// via env var if you need accuracy. Override: CLAUDE_COST_RATE=0.92 (your fx).
export const CURRENCIES: Record<string, { rate: number; symbol: string; name: string }> = {
  USD: { rate: 1.00,    symbol: '$',   name: 'US Dollar' },
  EUR: { rate: 0.92,    symbol: '€',   name: 'Euro' },
  GBP: { rate: 0.78,    symbol: '£',   name: 'British Pound' },
  CAD: { rate: 1.36,    symbol: 'C$',  name: 'Canadian Dollar' },
  AUD: { rate: 1.51,    symbol: 'A$',  name: 'Australian Dollar' },
  JPY: { rate: 152.00,  symbol: '¥',   name: 'Japanese Yen' },
  CNY: { rate: 7.20,    symbol: '¥',   name: 'Chinese Yuan' },
  INR: { rate: 83.50,   symbol: '₹',   name: 'Indian Rupee' },
  BRL: { rate: 5.10,    symbol: 'R$',  name: 'Brazilian Real' },
  MXN: { rate: 17.10,   symbol: 'Mex$', name: 'Mexican Peso' },
  CHF: { rate: 0.90,    symbol: 'CHF', name: 'Swiss Franc' },
  SEK: { rate: 10.50,   symbol: 'kr',  name: 'Swedish Krona' },
  NOK: { rate: 10.80,   symbol: 'kr',  name: 'Norwegian Krone' },
  KRW: { rate: 1380.00, symbol: '₩',   name: 'South Korean Won' },
  SGD: { rate: 1.34,    symbol: 'S$',  name: 'Singapore Dollar' },
  AED: { rate: 3.67,    symbol: 'AED', name: 'UAE Dirham' },
  SAR: { rate: 3.75,    symbol: 'SAR', name: 'Saudi Riyal' },
  TRY: { rate: 32.50,   symbol: '₺',   name: 'Turkish Lira' },
  ZAR: { rate: 18.50,   symbol: 'R',   name: 'South African Rand' },
  NGN: { rate: 1500.00, symbol: '₦',   name: 'Nigerian Naira' },
};

export type Session = {
  id: string;
  filePath: string;
  hashDir: string;
  projectPath: string;            // best-known cwd (real cwd from event > decoded hashDir)
  model?: string;                 // most recent model in this session
  dominantModel?: string;         // model with most events in this session
  models: Set<string>;            // all models seen in session
  modelEvents: Map<string, number>;  // model -> event count
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  costUsd: number;
  events: number;
  toolUses: number;
  toolCounts: Map<string, number>;   // tool name -> count
  errors: number;
  firstTs: number;                // first event timestamp (ms)
  lastTs: number;                 // last event timestamp (ms)
  hourBuckets: number[];          // 24-element: cost per hour-of-day (0..23)
  topMessageCostUsd: number;      // most expensive single assistant turn
  topMessageTs: number;           // when that turn happened
};

const HOME = homedir();
export const PROJECTS_DIR = join(HOME, '.claude', 'projects');

// Decode "-Users-ahmedh-code-foo" → "/Users/ahmedh/code/foo".
// Lossy when project names contain '-'. Real cwd from events overrides this.
export function decodeHashDir(hashDir: string): string {
  return hashDir.replace(/^-/, '/').replace(/-/g, '/');
}

export function shortPath(abs: string): string {
  if (abs.startsWith(HOME)) return '~' + abs.slice(HOME.length);
  return abs;
}

export function parseSession(filePath: string): Session | null {
  let text: string;
  try { text = readFileSync(filePath, 'utf8'); }
  catch { return null; }

  const id = basename(filePath).replace(/\.jsonl$/, '');
  const hashDir = basename(filePath.slice(0, filePath.lastIndexOf('/')));
  const decoded = decodeHashDir(hashDir);

  const s: Session = {
    id, filePath, hashDir,
    projectPath: decoded,
    models: new Set(),
    modelEvents: new Map(),
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0,
    cacheCreate5m: 0, cacheCreate1h: 0,
    costUsd: 0, events: 0, toolUses: 0, errors: 0,
    toolCounts: new Map(),
    firstTs: Number.POSITIVE_INFINITY,
    lastTs: 0,
    hourBuckets: new Array(24).fill(0),
    topMessageCostUsd: 0,
    topMessageTs: 0,
  };

  const assistantEvents: any[] = [];

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Track first/last timestamp
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (ts) {
      if (ts < s.firstTs) s.firstTs = ts;
      if (ts > s.lastTs) s.lastTs = ts;
    }

    // Prefer real cwd from events
    if (typeof obj.cwd === 'string' && obj.cwd) {
      s.projectPath = obj.cwd;
    }

    if (obj.type === 'assistant') {
      assistantEvents.push(obj);
    } else if (obj.type === 'user') {
      s.events += 1;
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result' && b.is_error) s.errors += 1;
        }
      }
    } else if (obj.type === 'system' && /error/i.test(obj.subtype || '')) {
      s.errors += 1;
    }
  }

  for (const obj of dedupeAssistantEvents(assistantEvents)) {
    s.events += 1;
    const msg = obj.message;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    let turnCost = 0;
    if (msg?.usage) {
      const u = msg.usage;
      const model = msg.model || 'unknown';
      s.model = model;
      s.models.add(model);
      s.modelEvents.set(model, (s.modelEvents.get(model) ?? 0) + 1);
      const usage = normalizeUsage(u);
      s.tokensIn       += usage.input;
      s.tokensOut      += usage.output;
      s.cacheRead      += usage.cacheRead;
      s.cacheCreate    += usage.cacheCreate;
      s.cacheCreate5m  += usage.cacheCreate5m;
      s.cacheCreate1h  += usage.cacheCreate1h;
      turnCost = costForUsage(model, usage);
      s.costUsd += turnCost;
    }
    if (turnCost > s.topMessageCostUsd) {
      s.topMessageCostUsd = turnCost;
      s.topMessageTs = ts;
    }
    if (ts) {
      const h = new Date(ts).getHours();
      s.hourBuckets[h] += turnCost;
    }
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          s.toolUses += 1;
          const tn = (b.name || 'unknown') as string;
          s.toolCounts.set(tn, (s.toolCounts.get(tn) ?? 0) + 1);
        }
      }
    }
  }

  if (!Number.isFinite(s.firstTs)) s.firstTs = 0;
  // Compute dominantModel: model with most events
  let topN = 0;
  for (const [m, n] of s.modelEvents) {
    if (n > topN) { topN = n; s.dominantModel = m; }
  }
  return s;
}

type NormalizedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
};

function normalizeUsage(u: any): NormalizedUsage {
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  const cacheCreate5m = Number(u.cache_creation?.ephemeral_5m_input_tokens) || 0;
  const cacheCreate1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const knownCacheCreate = cacheCreate5m + cacheCreate1h;
  const unknownCacheCreate = Math.max(0, cacheCreate - knownCacheCreate);
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    cacheCreate5m: cacheCreate5m + unknownCacheCreate,
    cacheCreate1h,
  };
}

function usageTokenTotal(u: any): number {
  const n = normalizeUsage(u);
  return n.input + n.output + n.cacheRead + n.cacheCreate;
}

function dedupeAssistantEvents(events: any[]): any[] {
  const byResponse = new Map<string, any>();
  for (let i = 0; i < events.length; i++) {
    const obj = events[i];
    const key = String(obj.requestId || obj.message?.id || obj.uuid || i);
    const prev = byResponse.get(key);
    if (!prev || usageTokenTotal(obj.message?.usage) >= usageTokenTotal(prev.message?.usage)) {
      byResponse.set(key, obj);
    }
  }
  return Array.from(byResponse.values());
}

function costForUsage(model: string | undefined, u: NormalizedUsage): number {
  const p = priceFor(model);
  return (
    u.input * p.in +
    u.output * p.out +
    u.cacheRead * p.cacheRead +
    u.cacheCreate5m * p.cacheWrite5m +
    u.cacheCreate1h * p.cacheWrite1h
  ) / 1_000_000;
}

// Short-display name for a model: "claude-opus-4-7-20251201" → "opus-4-7"
export function shortModel(m: string | undefined): string {
  if (!m) return '?';
  const x = m.toLowerCase();
  // strip claude- prefix and any -date-yyyymmdd suffix
  let s = x.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return s;
}

export function loadAllSessions(): Session[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: Session[] = [];

  function visit(dirPath: string) {
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const p = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(p);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const s = parseSession(p);
        if (s) out.push(s);
      }
    }
  }

  visit(PROJECTS_DIR);
  return out;
}
