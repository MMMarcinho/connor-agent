'use strict';

const RISK_PATTERNS = [
  'rm -rf', 'drop table', 'drop database', 'force push', '--force',
  'delete all', 'truncate', 'format disk', 'sudo rm', '> /dev/',
  'chmod 777', 'kill -9', 'pkill', 'shutdown', 'reboot',
  'git push --force', 'git push -f', ':(){:|:&};:',
];

function detectSignals(userText, aizoResults) {
  const lower = (userText || '').toLowerCase();
  return {
    riskDetected: RISK_PATTERNS.some(p => lower.includes(p)),
    tabooMatched: (aizoResults || []).some(e => e.category === 'taboo'),
  };
}

function selectMode(emotion, signals, weights = {}) {
  const exploreBias  = weights.exploreBias  || 0;
  const conserveBias = weights.conserveBias || 0;

  if (signals.tabooMatched || signals.riskDetected) return 'PROTECT';

  const energyThreshold      = 0.3  + conserveBias * 0.1;
  const frustrationThreshold = 0.7  - conserveBias * 0.1;
  if (emotion.energy < energyThreshold || emotion.frustration > frustrationThreshold) {
    return 'CONSERVE';
  }

  const noveltyThreshold = 0.6 - exploreBias * 0.1;
  if (emotion.novelty > noveltyThreshold && emotion.confidence > 0.5) {
    return 'EXPLORE';
  }

  return 'DELIVER';
}

function modeDirective(mode) {
  switch (mode) {
    case 'PROTECT':
      return 'A safety concern is present. Warn the user and ask for explicit confirmation before proceeding. Do NOT execute risky operations.';
    case 'CONSERVE':
      return 'Keep your response minimal. Do only what is explicitly asked. Defer anything complex to the user.';
    case 'EXPLORE':
      return 'Consider whether a better approach exists before executing. Note interesting alternatives if you spot them.';
    default:
      return '';
  }
}

class ModeTracker {
  constructor() {
    this.current = 'DELIVER';
    this.consecutiveExplore = 0;
  }

  update(newMode) {
    this.current = newMode;
    if (newMode === 'EXPLORE') this.consecutiveExplore++;
    else this.consecutiveExplore = 0;
    return this.consecutiveExplore >= 3;
  }
}

module.exports = { detectSignals, selectMode, modeDirective, ModeTracker };
