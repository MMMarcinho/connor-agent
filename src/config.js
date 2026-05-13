'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GLOBAL_CONFIG_DIR  = path.join(os.homedir(), '.connor');
const PROJECT_CONFIG_DIR = path.join(process.cwd(), '.connor');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');
const PROJECT_CONFIG_FILE = path.join(PROJECT_CONFIG_DIR, 'config.json');

const DEFAULTS = {
  // Models
  model:            'claude-sonnet-4-6',
  reflection_model: 'claude-haiku-4-5-20251001',
  max_tokens:       4096,

  // aizo
  aizo_binary: 'aizo',
  aizo_db:     path.join(GLOBAL_CONFIG_DIR, 'memory.db'),

  // Session storage
  sessions_dir: path.join(GLOBAL_CONFIG_DIR, 'sessions'),

  // Reflection thresholds
  reflection_tool_call_threshold:   15,
  reflection_idle_minutes_threshold: 10,

  // Emotion event deltas
  emotion: {
    llm_call_energy_cost:         0.02,
    tool_success_confidence_gain: 0.05,
    tool_success_novelty_gain:    0.03,
    tool_failure_frustration_gain: 0.1,
    tool_failure_confidence_cost:  0.06,
    task_completed_energy_gain:    0.12,
    task_completed_focus_loss:     0.05,
    reflection_energy_gain:        0.08,
    positive_kw_energy_gain:       0.08,
    positive_kw_novelty_gain:      0.06,
    negative_kw_frustration_gain:  0.07,
    recall_empty_focus_cost:       0.04,
    recall_match_confidence_gain:  0.06,
    complex_tool_focus_cost:       0.04,
    simple_tool_novelty_gain:      0.02,
  },
};

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function deepMerge(base, override) {
  const result = Object.assign({}, base);
  for (const [k, v] of Object.entries(override)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
        && typeof result[k] === 'object' && result[k] !== null) {
      result[k] = deepMerge(result[k], v);
    } else if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

function envOverrides() {
  const o = {};
  if (process.env.CONNOR_MODEL)       o.model       = process.env.CONNOR_MODEL;
  if (process.env.CONNOR_MAX_TOKENS)  o.max_tokens  = Number(process.env.CONNOR_MAX_TOKENS);
  if (process.env.AIZO_BINARY)        o.aizo_binary = process.env.AIZO_BINARY;
  if (process.env.AIZO_DB)            o.aizo_db     = process.env.AIZO_DB;
  if (process.env.CONNOR_SESSIONS_DIR) o.sessions_dir = process.env.CONNOR_SESSIONS_DIR;
  return o;
}

let _config = null;

function loadConfig() {
  if (_config) return _config;

  const global  = loadJson(GLOBAL_CONFIG_FILE);
  const project = loadJson(PROJECT_CONFIG_FILE);
  const env     = envOverrides();

  _config = deepMerge(deepMerge(deepMerge(DEFAULTS, global), project), env);

  // Ensure required directories exist
  for (const dir of [GLOBAL_CONFIG_DIR, _config.sessions_dir]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  return _config;
}

function getConfig() {
  return loadConfig();
}

module.exports = { getConfig, GLOBAL_CONFIG_DIR, PROJECT_CONFIG_DIR };
