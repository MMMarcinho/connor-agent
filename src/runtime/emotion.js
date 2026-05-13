'use strict';

// ── Emotion State ────────────────────────────────────────────────────────────

class EmotionState {
  constructor() {
    this.energy = 1.0;
    this.focus = 0.7;
    this.frustration = 0.05;
    this.novelty = 0.5;
    this.confidence = 0.5;
  }

  _clamp(v) { return Math.max(0, Math.min(1, v)); }
  _apply(dim, delta) { this[dim] = this._clamp(this[dim] + delta); }

  processEvent(event) {
    const { type } = event;
    switch (type) {
      case 'LlmCallCompleted':     this._apply('energy', -0.03); break;
      case 'SimpleToolCall':       this._apply('energy', -0.01); break;
      case 'ComplexToolCall':      this._apply('energy', -0.05); break;
      case 'ToolSuccess':
        this._apply('frustration', -0.10);
        this._apply('confidence',  +0.03);
        break;
      case 'ToolFailure':
        this._apply('frustration', +0.12);
        this._apply('confidence',  -0.10);
        if ((event.consecutiveFailures || 0) >= 3) this._apply('frustration', +0.20);
        break;
      case 'TaskCompleted':
        this._apply('frustration', -0.25);
        this._apply('confidence',  +0.10);
        break;
      case 'TaskSwitched':         this._apply('focus', -0.10); break;
      case 'StepTowardGoalCompleted':
        this._apply('focus',      +0.05);
        this._apply('confidence', +0.02);
        break;
      case 'UserPositiveKeyword':
        this._apply('frustration', -0.15);
        this._apply('confidence',  +0.08);
        break;
      case 'UserNegativeKeyword':
        this._apply('frustration', +0.12);
        this._apply('confidence',  -0.08);
        break;
      case 'AizoRecallEmpty':
        this._apply('novelty',    +0.20);
        this._apply('confidence', -0.05);
        break;
      case 'AizoRecallStrongMatch':
        this._apply('novelty',    -0.10);
        this._apply('confidence', +0.08);
        break;
      case 'IdlePeriod':
        this._apply('energy', (event.minutes || 1) * 0.04);
        break;
      case 'ReflectionCompleted':  this._apply('energy', +0.15); break;
    }
  }

  // 5% per minute natural decay toward baseline for Frustration and Novelty
  naturalDecay(deltaMinutes) {
    if (deltaMinutes <= 0) return;
    const rate = Math.pow(0.95, deltaMinutes);
    this.frustration = this._clamp(this.frustration * rate);
    this.novelty = this._clamp(0.5 + (this.novelty - 0.5) * rate);
  }

  applyCorrection(delta, dimension) {
    if (this[dimension] !== undefined) this._apply(dimension, delta);
  }

  snapshot() {
    return {
      energy: this.energy, focus: this.focus,
      frustration: this.frustration, novelty: this.novelty,
      confidence: this.confidence,
    };
  }

  loadSnapshot(snap) {
    if (!snap) return;
    for (const k of ['energy', 'focus', 'frustration', 'novelty', 'confidence']) {
      if (typeof snap[k] === 'number') this[k] = this._clamp(snap[k]);
    }
  }

  // Carry-over from previous session: regress 50% toward defaults
  static fromCarryOver(prev) {
    const s = new EmotionState();
    if (!prev) return s;
    s.energy      = (prev.energy      + s.energy)      / 2;
    s.focus       = (prev.focus       + s.focus)        / 2;
    s.frustration = (prev.frustration + s.frustration)  / 2;
    s.novelty     = (prev.novelty     + s.novelty)      / 2;
    s.confidence  = (prev.confidence  + s.confidence)   / 2;
    return s;
  }

  display() {
    const bar = (v) => '█'.repeat(Math.round(v * 10)).padEnd(10, '░');
    return [
      `  energy      ${bar(this.energy)} ${(this.energy * 100).toFixed(0)}%`,
      `  focus       ${bar(this.focus)} ${(this.focus * 100).toFixed(0)}%`,
      `  frustration ${bar(this.frustration)} ${(this.frustration * 100).toFixed(0)}%`,
      `  novelty     ${bar(this.novelty)} ${(this.novelty * 100).toFixed(0)}%`,
      `  confidence  ${bar(this.confidence)} ${(this.confidence * 100).toFixed(0)}%`,
    ].join('\n');
  }
}

// ── L1 Keyword Detector ──────────────────────────────────────────────────────

const POSITIVE_KW = [
  'perfect', 'exactly', 'great', 'love this', 'thank', 'good job',
  'nice', 'works', 'awesome', 'much better', 'that\'s it', 'correct',
];
const NEGATIVE_KW = [
  "no don't", 'wrong', 'bad', 'stop', 'hate this', 'not what i',
  'incorrect', 'nope', "doesn't work", 'revert', 'undo', 'that\'s wrong',
];

function detectL1Events(message) {
  const lower = message.toLowerCase();
  const events = [];
  if (POSITIVE_KW.some(kw => lower.includes(kw))) events.push({ type: 'UserPositiveKeyword' });
  if (NEGATIVE_KW.some(kw => lower.includes(kw))) events.push({ type: 'UserNegativeKeyword' });
  return events;
}

// ── Emotional Trajectory ─────────────────────────────────────────────────────

class EmotionTrajectory {
  constructor(windowSize = 5) {
    this.window = [];
    this.windowSize = windowSize;
  }

  push(snapshot) {
    if (this.window.length >= this.windowSize) this.window.shift();
    this.window.push(snapshot);
  }

  // Linear regression slope over window, normalized to [-1, 1]
  _trend(extract) {
    const vals = this.window.map(extract);
    const n = vals.length;
    if (n < 2) return 0;
    const sx = (n * (n - 1)) / 2;
    const sy = vals.reduce((a, b) => a + b, 0);
    const sxy = vals.reduce((s, y, i) => s + i * y, 0);
    const sxx = vals.reduce((s, _, i) => s + i * i, 0);
    const denom = n * sxx - sx * sx;
    if (denom === 0) return 0;
    return Math.max(-1, Math.min(1, (n * sxy - sx * sy) / denom));
  }

  frustrationTrend() { return this._trend(s => s.frustration); }
  confidenceTrend()  { return this._trend(s => s.confidence); }
  noveltyTrend()     { return this._trend(s => s.novelty); }
  energyTrend()      { return this._trend(s => s.energy); }

  isFlowState() {
    return this.noveltyTrend() > 0.3 && this.confidenceTrend() > 0.3;
  }

  adjustedThresholds() {
    return {
      frustrationCaution: 0.6 - Math.max(0, this.frustrationTrend()) * 0.1,
      confidenceLow:      0.3 + Math.max(0, -this.confidenceTrend()) * 0.1,
      flowState:          this.isFlowState(),
    };
  }
}

// ── Emotion-Biased Recall ────────────────────────────────────────────────────

function biasRecallQuery(baseQuery, emotion) {
  let query = baseQuery;
  let minWeight = null;
  let maxResults = null;
  let includeTaboo = false;
  let includeLowWeight = false;

  if (emotion.frustration > 0.6) {
    query = `${baseQuery} safe reliable`;
    includeTaboo = true;
  }
  if (emotion.novelty > 0.7) includeLowWeight = true;
  if (emotion.confidence < 0.3) minWeight = 7.0;
  if (emotion.energy < 0.3) maxResults = 5;

  return { query, minWeight, maxResults, includeTaboo, includeLowWeight };
}

async function recallBiased(aizo, baseQuery, emotion) {
  const params = biasRecallQuery(baseQuery, emotion);
  let results = await aizo.recall(params.query);

  if (params.includeTaboo) {
    const taboo = await aizo.recall(params.query, 'taboo');
    results = [...results, ...taboo];
  }
  if (params.minWeight !== null) {
    results = results.filter(e => (e.effective_weight || e.score || 0) >= params.minWeight);
  }
  if (params.maxResults !== null) {
    results = results.slice(0, params.maxResults);
  }

  const strongMatchCount = results.filter(
    e => (e.effective_weight || e.score || 0) >= 7
  ).length;

  return {
    entries: results,
    isEmpty: results.length === 0,
    isStrongMatch: strongMatchCount >= 5,
  };
}

// ── Emotional Memory Write-back ──────────────────────────────────────────────

function evaluateEmotionalWrite(current, prev, context, consecutiveFailures) {
  const tags = [];

  // Frustration threshold crossed this turn (rising edge)
  if (current.frustration > 0.7 && prev.frustration <= 0.7 && context.toolName) {
    tags.push({
      category: 'aversion',
      item: `${context.toolName} emotionally taxing`,
      reason: `frustration crossed 0.7 during ${context.toolName}`,
      score: 3.0,
      keywords: [context.toolName, 'frustration', 'taxing'],
    });
  }

  // 3+ consecutive failures with same tool
  if (consecutiveFailures >= 3 && context.toolName) {
    tags.push({
      category: 'aversion',
      item: `${context.toolName} repeated failure`,
      reason: `${consecutiveFailures} consecutive failures with ${context.toolName}`,
      score: 2.0,
      keywords: [context.toolName, 'failure', 'pattern'],
    });
  }

  // High confidence at task completion
  if (current.confidence > 0.8 && prev.confidence <= 0.8 && context.taskType) {
    tags.push({
      category: 'preference',
      item: `${context.taskType} confidence builder`,
      reason: `confidence ${current.confidence.toFixed(2)} reached during ${context.taskType}`,
      score: 7.0,
      keywords: [context.taskType, 'confidence', 'success'],
    });
  }

  return tags;
}

async function writeEmotionalTags(aizo, tags) {
  for (const tag of tags) {
    await aizo.add(tag.category, tag.item, tag.reason, tag.score, tag.keywords);
  }
}

// ── Prompt Modifiers ─────────────────────────────────────────────────────────

function promptModifiers(emotion, thresholds) {
  const t = thresholds || { frustrationCaution: 0.6, confidenceLow: 0.3, flowState: false };
  if (t.flowState) return [];
  const mods = [];
  if (emotion.energy < 0.3)         mods.push('Be concise. Skip explanations unless critical.');
  if (emotion.frustration > t.frustrationCaution) mods.push('If uncertain about anything, ask for clarification first.');
  if (emotion.novelty > 0.7)        mods.push('Consider whether a better approach exists before executing.');
  if (emotion.confidence < t.confidenceLow) mods.push('Double-check every assumption before acting.');
  if (emotion.focus < 0.4)          mods.push('Re-read the current goal before taking each action.');
  return mods;
}

module.exports = {
  EmotionState,
  EmotionTrajectory,
  detectL1Events,
  biasRecallQuery,
  recallBiased,
  evaluateEmotionalWrite,
  writeEmotionalTags,
  promptModifiers,
};
