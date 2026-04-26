import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSession, priceFor, decodeHashDir, shortPath, PRICING } from '../src/parse.ts';

function makeJsonl(events: any[]): string {
  return events.map(e => JSON.stringify(e)).join('\n');
}

function writeFixture(events: any[]): { filePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'cc-test-'));
  const projectDir = join(root, '-Users-test-project');
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, 'session-uuid.jsonl');
  writeFileSync(filePath, makeJsonl(events));
  return { filePath };
}

describe('priceFor', () => {
  test('opus', () => expect(priceFor('claude-opus-4-7').in).toBe(15));
  test('haiku', () => expect(priceFor('claude-haiku-4-5').in).toBe(0.8));
  test('sonnet default', () => expect(priceFor('claude-sonnet-4-6').in).toBe(3));
  test('unknown model defaults to sonnet', () => expect(priceFor('mystery').in).toBe(3));
  test('undefined defaults to sonnet', () => expect(priceFor(undefined).in).toBe(3));
});

describe('decodeHashDir', () => {
  test('basic', () => expect(decodeHashDir('-Users-foo-bar')).toBe('/Users/foo/bar'));
  test('no leading dash', () => expect(decodeHashDir('Users-foo')).toBe('Users/foo'));
});

describe('shortPath', () => {
  test('home prefix collapses to ~', () => {
    const home = process.env.HOME!;
    expect(shortPath(home + '/code/foo')).toBe('~/code/foo');
  });
  test('non-home left as-is', () => {
    expect(shortPath('/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('parseSession — pricing math', () => {
  test('sonnet: 1M in + 1M out + 0 cache = $18.00', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    const s = parseSession(filePath)!;
    // $3 in + $15 out = $18
    expect(s.costUsd).toBeCloseTo(18.0, 2);
    expect(s.tokensIn).toBe(1_000_000);
    expect(s.tokensOut).toBe(1_000_000);
    expect(s.events).toBe(1);
  });

  test('opus: 1M out = $75', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        message: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 0, output_tokens: 1_000_000,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    const s = parseSession(filePath)!;
    expect(s.costUsd).toBeCloseTo(75, 2);
  });

  test('haiku: 100K cache_read = $0.008', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        message: {
          model: 'claude-haiku-4-5',
          usage: {
            input_tokens: 0, output_tokens: 0,
            cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    const s = parseSession(filePath)!;
    // 100K * $0.08 / 1M = $0.008
    expect(s.costUsd).toBeCloseTo(0.008, 4);
  });

  test('prices 1-hour cache creation separately when present', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        requestId: 'req-1',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1_000_000,
            cache_creation: {
              ephemeral_5m_input_tokens: 250_000,
              ephemeral_1h_input_tokens: 750_000,
            },
          },
        },
      },
    ]);
    const s = parseSession(filePath)!;
    // 250K * $3.75 + 750K * $6 = $5.4375
    expect(s.costUsd).toBeCloseTo(5.4375, 4);
    expect(s.cacheCreate5m).toBe(250_000);
    expect(s.cacheCreate1h).toBe(750_000);
  });

  test('deduplicates repeated assistant snapshots for the same request', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        requestId: 'req-1',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:01Z',
        requestId: 'req-1',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);
    const s = parseSession(filePath)!;
    expect(s.costUsd).toBeCloseTo(3, 2);
    expect(s.events).toBe(1);
  });

  test('sums across multiple assistant events', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant', sessionId: 'abc', timestamp: '2026-04-26T00:00:00Z',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      },
      {
        type: 'assistant', sessionId: 'abc', timestamp: '2026-04-26T00:00:01Z',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      },
    ]);
    const s = parseSession(filePath)!;
    expect(s.costUsd).toBeCloseTo(6, 2);
    expect(s.events).toBe(2);
  });
});

describe('parseSession — metadata', () => {
  test('prefers cwd from event over decoded hashDir', () => {
    const { filePath } = writeFixture([
      {
        type: 'user',
        sessionId: 'abc',
        timestamp: '2026-04-26T00:00:00Z',
        cwd: '/Users/test/my-project',  // dash-containing real cwd
        message: { content: 'hi' },
      },
    ]);
    const s = parseSession(filePath)!;
    expect(s.projectPath).toBe('/Users/test/my-project');
  });

  test('tracks first/last timestamps', () => {
    const { filePath } = writeFixture([
      { type: 'user', sessionId: 'abc', timestamp: '2026-04-26T00:00:00Z', message: { content: 'a' } },
      { type: 'user', sessionId: 'abc', timestamp: '2026-04-26T00:30:00Z', message: { content: 'b' } },
      { type: 'user', sessionId: 'abc', timestamp: '2026-04-26T01:00:00Z', message: { content: 'c' } },
    ]);
    const s = parseSession(filePath)!;
    expect(new Date(s.firstTs).toISOString()).toBe('2026-04-26T00:00:00.000Z');
    expect(new Date(s.lastTs).toISOString()).toBe('2026-04-26T01:00:00.000Z');
  });

  test('counts tool_use and errors', () => {
    const { filePath } = writeFixture([
      {
        type: 'assistant', sessionId: 'abc', timestamp: '2026-04-26T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
          ],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: 'user', sessionId: 'abc', timestamp: '2026-04-26T00:00:01Z',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'oops' }] },
      },
    ]);
    const s = parseSession(filePath)!;
    expect(s.toolUses).toBe(1);
    expect(s.errors).toBe(1);
  });

  test('returns null for missing file', () => {
    expect(parseSession('/no/such/file.jsonl')).toBeNull();
  });

  test('ignores malformed lines, processes good ones', () => {
    const { filePath } = writeFixture([
      'not json',
      { type: 'user', sessionId: 'abc', timestamp: '2026-04-26T00:00:00Z', message: { content: 'hi' } },
    ] as any);
    // The first array element is a string — JSON.stringify wraps it. Build manually:
    const root = mkdtempSync(join(tmpdir(), 'cc-test-bad-'));
    const projectDir = join(root, '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });
    const fp = join(projectDir, 'bad.jsonl');
    writeFileSync(fp, 'not-json\n' + JSON.stringify({
      type: 'user', sessionId: 'abc', timestamp: '2026-04-26T00:00:00Z', message: { content: 'hi' }
    }));
    const s = parseSession(fp)!;
    expect(s).not.toBeNull();
    expect(s.events).toBe(1);
  });
});
