// Shared types used across the codebase

export interface EmotionSnapshot {
  energy: number;
  focus: number;
  frustration: number;
  novelty: number;
  confidence: number;
}

export type EmotionDimension = keyof EmotionSnapshot;

export type EmotionEventType =
  | 'LlmCallCompleted'
  | 'SimpleToolCall'
  | 'ComplexToolCall'
  | 'ToolSuccess'
  | 'ToolFailure'
  | 'TaskCompleted'
  | 'TaskSwitched'
  | 'StepTowardGoalCompleted'
  | 'UserPositiveKeyword'
  | 'UserNegativeKeyword'
  | 'AizoRecallEmpty'
  | 'AizoRecallStrongMatch'
  | 'IdlePeriod'
  | 'ReflectionCompleted';

export interface EmotionEvent {
  type: EmotionEventType;
  consecutiveFailures?: number;
  minutes?: number;
}

export interface AizoEntry {
  id?: number;
  item: string;
  reason: string;
  keywords: string[];
  base_score: number;
  effective_weight?: number;
  score?: number;
  source?: string;
  added_at?: string;
  last_seen?: string;
}

export interface EmotionalTag {
  item: string;
  reason: string;
  score: number;
  keywords: string[];
}

export interface EmotionalContext {
  toolName?: string;
  taskType?: string | null;
}

export interface AdjustedThresholds {
  frustrationCaution: number;
  confidenceLow: number;
  flowState: boolean;
}

export interface BiasedRecallResult {
  entries: AizoEntry[];
  isEmpty: boolean;
  isStrongMatch: boolean;
}

export type BehavioralMode = 'PROTECT' | 'CONSERVE' | 'EXPLORE' | 'DELIVER';

export interface ModeWeights {
  exploreBias: number;
  conserveBias: number;
}

export interface Signals {
  riskDetected: boolean;
  tabooMatched: boolean;
}

export interface TaskEntry {
  id: string;
  description: string;
  parentId: string | null;
  status: 'active' | 'paused' | 'completed';
  createdAt: number;
}

export interface EpisodicEvent {
  type: string;
  summary: string;
  timestamp: number;
  tool?: string;
  exitCode?: number;
}

export interface ToolParam {
  name: string;
  type: string;
  desc?: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Tool {
  name: string;
  description: string;
  params: ToolParam[];
  handler(input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export interface ToolPolicy {
  avoidComplex?: boolean;
}

export interface AizoConfig {
  aizo_binary?: string;
  aizo_db?: string;
}

export interface EmotionConfig {
  llm_call_energy_cost?: number;
  tool_success_confidence_gain?: number;
  tool_success_novelty_gain?: number;
  tool_failure_frustration_gain?: number;
  tool_failure_confidence_cost?: number;
  task_completed_energy_gain?: number;
  task_completed_focus_loss?: number;
  reflection_energy_gain?: number;
  positive_kw_energy_gain?: number;
  positive_kw_novelty_gain?: number;
  negative_kw_frustration_gain?: number;
  recall_empty_focus_cost?: number;
  recall_match_confidence_gain?: number;
  complex_tool_focus_cost?: number;
  simple_tool_novelty_gain?: number;
}

export interface Config {
  model: string;
  reflection_model: string;
  max_tokens: number;
  aizo_binary: string;
  aizo_db: string;
  sessions_dir: string;
  reflection_tool_call_threshold: number;
  reflection_idle_minutes_threshold: number;
  emotion: EmotionConfig;
}

export interface ReflectionInput {
  episodicEvents: EpisodicEvent[];
  emotionLog: EmotionSnapshot[];
  currentMemories: AizoEntry[];
}
