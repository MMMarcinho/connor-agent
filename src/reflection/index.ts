import Anthropic from '@anthropic-ai/sdk';
import * as aizo from '../aizo_bridge';
import type { ReflectionInput } from '../types';

const DEFAULT_TRIGGER = {
  toolCallThreshold:    15,
  idleMinutesThreshold: 10,
};

export class ReflectionTrigger {
  private toolCallThreshold:    number;
  private idleMinutesThreshold: number;

  constructor(opts: Partial<typeof DEFAULT_TRIGGER> = {}) {
    this.toolCallThreshold    = opts.toolCallThreshold    ?? DEFAULT_TRIGGER.toolCallThreshold;
    this.idleMinutesThreshold = opts.idleMinutesThreshold ?? DEFAULT_TRIGGER.idleMinutesThreshold;
  }

  shouldReflect(toolCallsSinceLast: number, idleMinutes: number): boolean {
    return toolCallsSinceLast >= this.toolCallThreshold
      || idleMinutes >= this.idleMinutesThreshold;
  }
}

interface ReflectionResult {
  new_entries?:       { item: string; reason: string; score: number; keywords: string[] }[];
  confirmed_items?:   { item: string }[];
  emotion_correction?: { note: string; suggested_novelty_adjustment: number; suggested_confidence_adjustment: number };
  mode_correction?:   { explore_bias_delta: number; conserve_bias_delta: number };
}

async function runReflection(
  input: ReflectionInput,
  llmClient: Anthropic,
): Promise<ReflectionResult | null> {
  if (input.episodicEvents.length === 0) return null;

  try {
    const summary = input.episodicEvents.slice(-20).map(e =>
      `[${new Date(e.timestamp).toISOString()}] ${e.type}: ${e.summary}`
    ).join('\n');

    const memContext = (input.currentMemories ?? []).slice(0, 10).map(m =>
      `[${m.effective_weight ?? m.score ?? '?'}] ${m.item}: ${m.reason}`
    ).join('\n') || '(none)';

    const emotionSummary = (input.emotionLog ?? []).slice(-5).map(snap =>
      `E:${snap.energy?.toFixed(2)} Fr:${snap.frustration?.toFixed(2)} N:${snap.novelty?.toFixed(2)} Co:${snap.confidence?.toFixed(2)}`
    ).join(' → ') || '(none)';

    const prompt = `You are a background memory consolidation agent reviewing a completed session.

## Current Top Memories
${memContext}

## Session Events (last 20)
${summary}

## Emotion Arc (last 5 snapshots)
${emotionSummary}

Return ONLY valid JSON. Use score 0–10: 0=hard limit, 2=aversion, 5=habit, 7=style, 8=preference.
If nothing is worth saving, return empty arrays.
{
  "new_entries": [{"item": "...", "reason": "...", "score": 7.0, "keywords": []}],
  "confirmed_items": [{"item": "..."}],
  "emotion_correction": {"note": "...", "suggested_novelty_adjustment": 0.0, "suggested_confidence_adjustment": 0.0},
  "mode_correction": {"explore_bias_delta": 0.0, "conserve_bias_delta": 0.0}
}`;

    const resp = await llmClient.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text    = resp.content.find(b => b.type === 'text')?.text ?? '{}';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const result  = JSON.parse(cleaned) as ReflectionResult;

    for (const entry of (result.new_entries ?? [])) {
      await aizo.add(entry.item, entry.reason, entry.score, entry.keywords ?? []);
    }
    for (const item of (result.confirmed_items ?? [])) {
      await aizo.touch(item.item);
    }

    process.stderr.write(
      `[reflection] +${(result.new_entries ?? []).length} memories, ` +
      `confirmed ${(result.confirmed_items ?? []).length}\n`
    );

    return result;
  } catch (err) {
    process.stderr.write(`[reflection] failed: ${(err as Error).message}\n`);
    return null;
  }
}

export function spawnReflection(input: ReflectionInput, llmClient: Anthropic): void {
  setImmediate(() => runReflection(input, llmClient).catch(() => {}));
}
