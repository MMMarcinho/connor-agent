'use strict';

const { execFile } = require('child_process');
const { spawn } = require('child_process');

// Binary and DB path can be overridden via env vars or config (config takes
// precedence at call time via getAizoBin / getAizoDB helpers below).
const AIZO_BIN = process.env.AIZO_BINARY || process.env.AIZO_BIN || 'aizo';
const AIZO_DB  = process.env.AIZO_DB || null;
const TIMEOUTS = {
  recall: 2000,
  add:    1000,
  touch:  1000,
  top:    2000,
  analyze: 30000,
};

let degraded = false;
let _configBin = null;
let _configDb  = null;

function configure(opts = {}) {
  if (opts.aizo_binary) _configBin = opts.aizo_binary;
  if (opts.aizo_db)     _configDb  = opts.aizo_db;
}

function _bin() { return _configBin || AIZO_BIN; }

function _baseArgs() {
  const db = _configDb || AIZO_DB;
  return db ? ['--db', db] : [];
}

function runAizo(args, timeout) {
  return new Promise((resolve) => {
    if (degraded) return resolve(null);

    const fullArgs = [..._baseArgs(), ...args];
    const child = execFile(_bin(), fullArgs, { timeout }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          if (!degraded) {
            degraded = true;
            process.stderr.write('[aizo] binary not found — running in degraded memory mode\n');
          }
        } else if (err.killed) {
          process.stderr.write(`[aizo] timeout after ${timeout}ms for: ${args.join(' ')}\n`);
        } else {
          process.stderr.write(`[aizo] error (${err.code}): ${err.message}\n`);
        }
        return resolve(null);
      }
      resolve(stdout);
    });
    void child;
  });
}

function parseJson(raw, fallback = []) {
  if (!raw) return fallback;
  try { return JSON.parse(raw.trim()); } catch { return fallback; }
}

async function recall(query, category = null) {
  const args = ['recall', query, '--json'];
  if (category) args.push('--type', category);
  const out = await runAizo(args, TIMEOUTS.recall);
  return parseJson(out, []);
}

async function add(category, item, reason, score, keywords = []) {
  const args = [
    'add', item, reason,
    '--type', category,
    '--score', String(score),
  ];
  if (keywords.length > 0) args.push('--keywords', keywords.join(','));
  await runAizo(args, TIMEOUTS.add);
}

async function touch(category, item) {
  await runAizo(['touch', category, item], TIMEOUTS.touch);
}

async function top(n = 20, category = null) {
  const args = ['top', String(n), '--json'];
  if (category) args.push('--type', category);
  const out = await runAizo(args, TIMEOUTS.top);
  return parseJson(out, []);
}

function analyze(sessionText) {
  return new Promise((resolve) => {
    if (degraded) return resolve([]);

    const child = spawn(_bin(), [..._baseArgs(), 'analyze', '--json'], {
      timeout: TIMEOUTS.analyze,
    });

    let stdout = '';
    let finished = false;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[aizo analyze] ${chunk}`);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (code === 0) resolve(parseJson(stdout, []));
      else resolve([]);
    });

    child.on('error', (err) => {
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

module.exports = { recall, add, touch, top, analyze, configure, isDegraded: () => degraded };
