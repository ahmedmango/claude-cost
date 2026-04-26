#!/usr/bin/env node
/* vibecosting CLI shim — finds bun, runs src/cli.ts, forwards stdio. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(REPO, 'src', 'cli.ts');

if (!existsSync(ENTRY)) {
  console.error(`[vibecosting] entry missing: ${ENTRY}`);
  process.exit(1);
}

// Find bun on PATH.
const hasBun = await new Promise((r) => {
  const t = spawn(process.platform === 'win32' ? 'where' : 'which', ['bun'], { stdio: 'ignore' });
  t.on('close', (code) => r(code === 0));
});
if (!hasBun) {
  console.error('[vibecosting] Bun is required. Install: curl -fsSL https://bun.sh/install | bash');
  process.exit(1);
}

const child = spawn('bun', [ENTRY, ...process.argv.slice(2)], { cwd: REPO, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT',  () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
