import { execFile, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { AizoEntry, AizoConfig } from '../types';

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// Priority:
//   1. Explicit configure() override / AIZO_BINARY env var
//   2. aizo-node npm package  (node_modules/aizo-node/bin/aizo)
//   3. System PATH            ('aizo')

function resolveAizoBin(override?: string): string {
  if (override) return override;
  if (process.env['AIZO_BINARY']) return process.env['AIZO_BINARY'];

  try {
    const pkgDir  = path.dirname(require.resolve('aizo-node/package.json'));
    const binPath = path.join(pkgDir, 'bin', process.platform === 'win32' ? 'aizo.exe' : 'aizo');
    if (fs.existsSync(binPath)) return binPath;
    process.stderr.write('[aizo] aizo-node package found but binary missing — was install.js run?\n');
  } catch {
    // aizo-node not installed; fall through
  }

  return process.env['AIZO_BIN'] ?? 'aizo';
}

// ── Timeouts (ms) ─────────────────────────────────────────────────────────────

const TIMEOUTS = {
  recall:  2000,
  add:     1000,
  tag:     1000,
  touch:   1000,
  top:     2000,
  analyze: 30000,
} as const;

// ── Module state ──────────────────────────────────────────────────────────────

let _bin:     string | null = null;
let _dbArgs:  string[]      = [];
let degraded  = false;

export function configure(opts: AizoConfig = {}): void {
  _bin    = resolveAizoBin(opts.aizo_binary);
  const db = opts.aizo_db ?? process.env['AIZO_DB_PATH'] ?? process.env['AIZO_DB'] ?? null;
  _dbArgs = db ? ['--db', db] : [];
}

function getBin(): string {
  if (!_bin) _bin = resolveAizoBin();
  return _bin;
}

// ── Core subprocess helper ────────────────────────────────────────────────────

function runAizo(args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (degraded) return resolve(null);

    execFile(getBin(), [..._dbArgs, ...args], { timeout }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (!degraded) {
            degraded = true;
            process.stderr.write('[aizo] binary not found — running in degraded memory mode\n');
          }
        } else if (err.killed) {
          process.stderr.write(`[aizo] timeout after ${timeout}ms: ${args[0]}\n`);
        } else {
          process.stderr.write(`[aizo] error (${(err as NodeJS.ErrnoException).code}): ${err.message}\n`);
        }
        return resolve(null);
      }
      resolve(stdout);
    });
  });
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw.trim()) as T; } catch { return fallback; }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function recall(
  query: string = '',
  type?: string,
  limit = 20,
): Promise<AizoEntry[]> {
  const args = ['recall'];
  if (query) args.push(query);
  args.push('--json', '--limit', String(limit));
  if (type) args.push('--type', type);
  return parseJson<AizoEntry[]>(await runAizo(args, TIMEOUTS.recall), []);
}

export async function add(
  item: string,
  reason: string,
  score: number = 5,
  keywords: string[] = [],
): Promise<void> {
  await runAizo(['add', item, reason, '--score', String(score ?? 5)], TIMEOUTS.add);
  if (keywords.length > 0) {
    await runAizo(['tag', item, ...keywords], TIMEOUTS.tag);
  }
}

export async function touch(item: string): Promise<void> {
  await runAizo(['touch', item], TIMEOUTS.touch);
}

export async function top(n = 20, type?: string): Promise<AizoEntry[]> {
  const args = ['top', String(n), '--json'];
  if (type) args.push('--type', type);
  return parseJson<AizoEntry[]>(await runAizo(args, TIMEOUTS.top), []);
}

export function analyze(sessionText: string): Promise<AizoEntry[]> {
  return new Promise((resolve) => {
    if (degraded) return resolve([]);

    const child = spawn(getBin(), [..._dbArgs, 'analyze', '--json'], {
      timeout: TIMEOUTS.analyze,
    });

    let stdout   = '';
    let finished = false;

    child.stdout.on('data', (c: Buffer) => { stdout += c; });
    child.stderr.on('data', (c: Buffer) => { process.stderr.write(`[aizo analyze] ${c}`); });

    child.on('close', (code: number | null) => {
      if (finished) return;
      finished = true;
      resolve(code === 0 ? parseJson<AizoEntry[]>(stdout, []) : []);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      if (err.code === 'ENOENT' && !degraded) {
        degraded = true;
        process.stderr.write('[aizo] binary not found — running in degraded memory mode\n');
      }
      resolve([]);
    });

    child.stdin.write(sessionText);
    child.stdin.end();
  });
}

export const isDegraded  = (): boolean  => degraded;
export const getBinaryPath = (): string => getBin();
