'use strict';

const { execFile } = require('child_process');
const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs');

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// Priority order:
//   1. Explicit config override (aizo_binary / AIZO_BINARY env var)
//   2. aizo-node npm package   (node_modules/aizo-node/bin/aizo)
//   3. System PATH             ('aizo')

function resolveAizoBin(override) {
  if (override) return override;
  if (process.env.AIZO_BINARY) return process.env.AIZO_BINARY;

  try {
    // Resolve relative to the project root so monorepo layouts work too
    const pkgDir = path.dirname(require.resolve('aizo-node/package.json'));
    const binPath = path.join(pkgDir, 'bin', process.platform === 'win32' ? 'aizo.exe' : 'aizo');
    if (fs.existsSync(binPath)) return binPath;
    // Binary not yet downloaded (install.js may have failed)
    process.stderr.write('[aizo] aizo-node package found but binary missing — was install.js run?\n');
  } catch {
    // aizo-node not installed — fall through to system PATH
  }

  return process.env.AIZO_BIN || 'aizo'; // legacy env var + system fallback
}

// ── Category → score mapping ──────────────────────────────────────────────────
//
// aizo v0.3 no longer stores a "category" field. The --type filter on recall/top
// is purely a score-range alias. We map legacy category names to representative
// scores so existing call-sites (reflection, emotion write-back, etc.) keep working.
//
//   taboo      →  0.5   (0 – 1.5)
//   aversion   →  2.0   (1.6 – 4)
//   habit      →  5.0   (4 – 6.5)
//   style      →  7.0   (6.5 – 10, lower end)
//   preference →  8.0   (7 – 10)

const CATEGORY_SCORE = {
  taboo:      0.5,
  aversion:   2.0,
  habit:      5.0,
  style:      7.0,
  preference: 8.0,
};

function categoryToScore(category) {
  return CATEGORY_SCORE[category] ?? 5.0;
}

// ── Timeouts (ms) ─────────────────────────────────────────────────────────────

const TIMEOUTS = {
  recall:  2000,
  add:     1000,
  tag:     1000,
  touch:   1000,
  top:     2000,
  analyze: 30000,
};

// ── Module state ──────────────────────────────────────────────────────────────

let _bin      = null;
let _dbArgs   = [];    // [] or ['--db', '<path>']
let degraded  = false;

function configure(opts = {}) {
  _bin = resolveAizoBin(opts.aizo_binary || null);

  const db = opts.aizo_db || process.env.AIZO_DB_PATH || process.env.AIZO_DB || null;
  _dbArgs = db ? ['--db', db] : [];
}

function _getBin() {
  if (!_bin) _bin = resolveAizoBin(null); // lazy init
  return _bin;
}

// ── Core subprocess helper ────────────────────────────────────────────────────

function runAizo(args, timeout) {
  return new Promise((resolve) => {
    if (degraded) return resolve(null);

    const fullArgs = [..._dbArgs, ...args];

    execFile(_getBin(), fullArgs, { timeout }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          if (!degraded) {
            degraded = true;
            process.stderr.write('[aizo] binary not found — running in degraded memory mode\n');
          }
        } else if (err.killed) {
          process.stderr.write(`[aizo] timeout after ${timeout}ms: ${args[0]}\n`);
        } else {
          process.stderr.write(`[aizo] error (${err.code}): ${err.message}\n`);
        }
        return resolve(null);
      }
      resolve(stdout);
    });
  });
}

function parseJson(raw, fallback = []) {
  if (!raw) return fallback;
  try { return JSON.parse(raw.trim()); } catch { return fallback; }
}

// ── Public API ────────────────────────────────────────────────────────────────

// recall(query, category)
//   query    – keyword string (pass '' for type-only query)
//   category – optional score-range alias: 'preference'|'aversion'|'habit'|'style'|'taboo'
async function recall(query = '', category = null, limit = 20) {
  const args = ['recall'];
  if (query) args.push(query);
  args.push('--json', '--limit', String(limit));
  if (category) args.push('--type', category);
  const out = await runAizo(args, TIMEOUTS.recall);
  return parseJson(out, []);
}

// add(category, item, reason, score, keywords)
//   category  – legacy name; converted to a representative score if score is null
//   score     – explicit 0–10 override (takes priority over category mapping)
//   keywords  – tagged via a separate `aizo tag` call after add
async function add(category, item, reason, score = null, keywords = []) {
  const s = score !== null ? score : categoryToScore(category);

  // Step 1: add the entry
  const addArgs = ['add', item, reason || '', '--score', String(s)];
  await runAizo(addArgs, TIMEOUTS.add);

  // Step 2: tag keywords (separate command in v0.3+)
  if (keywords.length > 0) {
    const tagArgs = ['tag', item, ...keywords];
    await runAizo(tagArgs, TIMEOUTS.tag);
  }
}

// touch(item)
//   Resets the decay clock. v0.3 takes item name(s) only — no category argument.
async function touch(item) {
  await runAizo(['touch', item], TIMEOUTS.touch);
}

// top(n, category)
async function top(n = 20, category = null) {
  const args = ['top', String(n), '--json'];
  if (category) args.push('--type', category);
  const out = await runAizo(args, TIMEOUTS.top);
  return parseJson(out, []);
}

// analyze(sessionText) — pipes text into `aizo analyze` via stdin
function analyze(sessionText) {
  return new Promise((resolve) => {
    if (degraded) return resolve([]);

    const child = spawn(_getBin(), [..._dbArgs, 'analyze', '--json'], {
      timeout: TIMEOUTS.analyze,
    });

    let stdout   = '';
    let finished = false;

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { process.stderr.write(`[aizo analyze] ${c}`); });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      resolve(code === 0 ? parseJson(stdout, []) : []);
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

module.exports = {
  configure,
  recall,
  add,
  touch,
  top,
  analyze,
  isDegraded: () => degraded,
  getBinaryPath: () => _getBin(),
};
