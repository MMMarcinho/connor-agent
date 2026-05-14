import type { EmotionSnapshot, BehavioralMode, ModeWeights, Signals, AizoEntry } from '../types';

const RISK_PATTERNS = [
  'rm -rf', 'drop table', 'drop database', 'force push', '--force',
  'delete all', 'truncate', 'format disk', 'sudo rm', '> /dev/',
  'chmod 777', 'kill -9', 'pkill', 'shutdown', 'reboot',
  'git push --force', 'git push -f', ':(){:|:&};:',
];

export function detectSignals(userText: string, aizoResults: AizoEntry[]): Signals {
  const lower = (userText ?? '').toLowerCase();
  return {
    riskDetected: RISK_PATTERNS.some(p => lower.includes(p)),
    tabooMatched: (aizoResults ?? []).some(
      e => (e.base_score ?? e.score ?? 10) <= 1.5
    ),
  };
}

export function selectMode(
  emotion: EmotionSnapshot,
  signals: Signals,
  weights: Partial<ModeWeights> = {},
): BehavioralMode {
  const exploreBias  = weights.exploreBias  ?? 0;
  const conserveBias = weights.conserveBias ?? 0;

  if (signals.tabooMatched || signals.riskDetected) return 'PROTECT';

  const energyThreshold      = 0.3  + conserveBias * 0.1;
  const frustrationThreshold = 0.7  - conserveBias * 0.1;
  if (emotion.energy < energyThreshold || emotion.frustration > frustrationThreshold) {
    return 'CONSERVE';
  }

  const noveltyThreshold = 0.6 - exploreBias * 0.1;
  if (emotion.novelty > noveltyThreshold && emotion.confidence > 0.5) return 'EXPLORE';

  return 'DELIVER';
}

export function modeDirective(mode: BehavioralMode): string {
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

export class ModeTracker {
  current:           BehavioralMode = 'DELIVER';
  consecutiveExplore = 0;

  update(newMode: BehavioralMode): boolean {
    this.current = newMode;
    if (newMode === 'EXPLORE') this.consecutiveExplore++;
    else this.consecutiveExplore = 0;
    return this.consecutiveExplore >= 3;
  }
}
