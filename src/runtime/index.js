'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aizo = require('../aizo_bridge');
const { WorkingMemory } = require('./working_memory');
const {
  EmotionState, EmotionTrajectory,
  detectL1Events, recallBiased,
  evaluateEmotionalWrite, writeEmotionalTags,
  promptModifiers,
} = require('./emotion');
const { detectSignals, selectMode, modeDirective, ModeTracker } = require('./behavioral_mode');
const { ToolRegistry } = require('../tools');
const { ReflectionTrigger, spawnReflection } = require('../reflection');

// Model constants have a fallback here so Runtime works without config injection
// (e.g. in tests). Production code passes config via constructor.
const DEFAULT_MODEL      = process.env.CONNOR_MODEL    || 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = Number(process.env.CONNOR_MAX_TOKENS || 4096);

const BASE_PROMPT = `You are connor-agent, a thoughtful cyber bionic assistant with long-term memory and adaptive reasoning.
You have tools available and draw on past experience to guide your decisions.
You never perform irreversible or destructive actions without explicit user confirmation.
When uncertain, ask. When confident, act.`;

class Runtime {
  constructor(toolRegistry, config = {}, sessionLogger = null) {
    this.config  = config;
    this.session = sessionLogger;

    const model     = config.model      || DEFAULT_MODEL;
    const maxTokens = config.max_tokens || DEFAULT_MAX_TOKENS;
    const reflOpts  = {
      toolCallThreshold:    config.reflection_tool_call_threshold    || 15,
      idleMinutesThreshold: config.reflection_idle_minutes_threshold || 10,
    };

    this.model     = model;
    this.maxTokens = maxTokens;
    this.client    = new Anthropic();
    this.tools     = toolRegistry;
    this.memory    = new WorkingMemory();
    this.emotion   = new EmotionState();
    this.trajectory = new EmotionTrajectory();
    this.modeTracker = new ModeTracker();
    this.modeWeights = { exploreBias: 0, conserveBias: 0 };
    this.reflectionTrigger = new ReflectionTrigger(reflOpts);

    // Bookkeeping
    this.toolCallsSinceReflection = 0;
    this.lastActivityAt = Date.now();
    this.consecutiveFailures = {}; // toolName → count
    this.emotionLog = [];          // snapshots for reflection
    this.conversationHistory = []; // Anthropic messages array
  }

  // ── Session Init ──────────────────────────────────────────────────────────

  async initialize() {
    // Load mode baselines from aizo
    const baselineEntry = await aizo.recall('behavioral-mode-baseline', 'habit');
    if (baselineEntry.length > 0) {
      try { this.modeWeights = JSON.parse(baselineEntry[0].reason); } catch {}
    }

    // Load emotion carry-over from previous session
    const emotionEntry = await aizo.recall('session-end-emotion-state', 'habit');
    if (emotionEntry.length > 0) {
      try {
        const prev = JSON.parse(emotionEntry[0].reason);
        this.emotion = EmotionState.fromCarryOver(prev);
      } catch {}
    }

    // Pre-load top memories into working memory
    this.memory.aizoRecallCache = await aizo.top(20);
  }

  // ── Main Turn ─────────────────────────────────────────────────────────────

  async runTurn(userMessage) {
    const now = Date.now();

    // ── Step 2: L1 detection ─────────────────────────────────────────────
    const l1Events = detectL1Events(userMessage);

    // ── Step 3: Attention gate — build recall query ───────────────────────
    const activeTask = this.memory.taskStack.active();
    const recallQuery = (activeTask && this.emotion.focus >= 0.4)
      ? activeTask.description
      : userMessage;

    // ── Step 4: aizo recall (emotion-biased) ─────────────────────────────
    const { entries, isEmpty, isStrongMatch } = await recallBiased(
      aizo, recallQuery, this.emotion
    );
    this.memory.aizoRecallCache = entries;

    // ── Step 5: Emotion update ────────────────────────────────────────────
    const idleMinutes = (now - this.lastActivityAt) / 60000;
    this.emotion.naturalDecay(idleMinutes);

    for (const e of l1Events) this.emotion.processEvent(e);
    if (isEmpty)       this.emotion.processEvent({ type: 'AizoRecallEmpty' });
    if (isStrongMatch) this.emotion.processEvent({ type: 'AizoRecallStrongMatch' });
    this.trajectory.push(this.emotion.snapshot());
    this.emotionLog.push(this.emotion.snapshot());

    // ── Step 6: Mode select ───────────────────────────────────────────────
    const signals = detectSignals(userMessage, this.memory.aizoRecallCache);
    const mode    = selectMode(this.emotion, signals, this.modeWeights);
    const autonomous = this.modeTracker.update(mode);

    // ── Step 7: Prompt assembly (freeze emotion snapshot) ─────────────────
    const snapshot = this.emotion.snapshot();
    this.memory.emotionSnapshot = snapshot;

    const thresholds = this.trajectory.adjustedThresholds();
    const modifiers  = promptModifiers(this.emotion, thresholds);
    const directive  = modeDirective(mode);
    const memContext = this._formatMemoryContext();
    const systemPrompt = this._buildSystemPrompt(modifiers, directive, memContext, mode);

    // Add user message to conversation history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // ── Steps 8–12: LLM call + tool execution loop ────────────────────────
    const finalText = await this._llmToolLoop(systemPrompt);

    // ── Step 12: Record episode ───────────────────────────────────────────
    this.memory.episodicBuffer.push({
      type: 'UserInteraction',
      summary: userMessage.slice(0, 100),
    });

    // ── Step 13: Autonomous suggestion if warranted ───────────────────────
    let output = finalText;
    if (autonomous && this.emotion.energy > 0.4 && mode === 'EXPLORE') {
      output += '\n\n_(I noticed this might be worth exploring further — want me to dig in?)_';
    }

    // ── Session logging ───────────────────────────────────────────────────
    if (this.session) {
      this.session.logTurn(userMessage, output, this.emotion.snapshot());
    }

    // Save emotion snapshot for next session
    await aizo.add(
      'habit', 'session-end-emotion-state',
      JSON.stringify(this.emotion.snapshot()), 5, []
    );

    // ── Step 14: Reflection check ─────────────────────────────────────────
    const idleSinceActivity = (Date.now() - this.lastActivityAt) / 60000;
    if (this.reflectionTrigger.shouldReflect(
      this.toolCallsSinceReflection, idleSinceActivity
    )) {
      spawnReflection({
        episodicEvents: this.memory.episodicBuffer.drainForReflection(),
        emotionLog: this.emotionLog.slice(-20),
        currentMemories: this.memory.aizoRecallCache,
      }, this.client);
      this.toolCallsSinceReflection = 0;
      this.emotionLog = [];
      this.emotion.processEvent({ type: 'ReflectionCompleted' });
    }

    this.lastActivityAt = Date.now();
    return output;
  }

  // ── LLM + Tool Use Loop ───────────────────────────────────────────────────

  async _llmToolLoop(systemPrompt) {
    const policy = {
      avoidComplex: this.emotion.energy < 0.3 || this.emotion.frustration > 0.7,
    };
    const tools = this.tools.schemaForPrompt(policy);

    let messages = [...this.conversationHistory];

    for (let round = 0; round < 10; round++) {
      this.emotion.processEvent({ type: 'LlmCallCompleted' });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        messages,
      });

      // Collect text blocks and tool use blocks
      const textBlocks    = response.content.filter(b => b.type === 'text');
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        // Final text response
        const text = textBlocks.map(b => b.text).join('');
        this.conversationHistory.push({ role: 'assistant', content: response.content });
        return text;
      }

      // Execute all tool calls and collect results
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const isComplex = this.tools.isComplex(toolUse.name);
        this.emotion.processEvent({
          type: isComplex ? 'ComplexToolCall' : 'SimpleToolCall',
        });

        const result = await this.tools.execute(toolUse.name, toolUse.input);

        // ── Step 10: Emotion delta ──────────────────────────────────────
        const prevSnap = this.emotion.snapshot();
        if (result.exitCode === 0) {
          if (this.consecutiveFailures[toolUse.name]) {
            delete this.consecutiveFailures[toolUse.name];
          }
          this.emotion.processEvent({ type: 'ToolSuccess' });
          // Record successful tool use to aizo
          aizo.add(
            'preference', `use ${toolUse.name}`,
            `Successfully used ${toolUse.name}: ${(result.stdout || '').slice(0, 80)}`,
            8.0, [toolUse.name]
          ).catch(() => {});
        } else {
          this.consecutiveFailures[toolUse.name] =
            (this.consecutiveFailures[toolUse.name] || 0) + 1;
          this.emotion.processEvent({
            type: 'ToolFailure',
            consecutiveFailures: this.consecutiveFailures[toolUse.name],
          });
          // Record failure to aizo
          aizo.add(
            'aversion', `${toolUse.name} failed`,
            `${toolUse.name} failed: ${(result.stderr || '').slice(0, 80)}`,
            2.0, [toolUse.name]
          ).catch(() => {});
        }

        this.trajectory.push(this.emotion.snapshot());
        this.emotionLog.push(this.emotion.snapshot());
        this.toolCallsSinceReflection++;

        if (this.session) {
          this.session.logToolCall(toolUse.name, result.exitCode, this.emotion.snapshot());
        }

        // ── Step 11: Emotional write-back ───────────────────────────────
        const activeTask = this.memory.taskStack.active();
        const ctx = {
          toolName: toolUse.name,
          taskType: activeTask
            ? activeTask.description.split(/\s+/).slice(0, 3).join(' ')
            : null,
        };
        const tags = evaluateEmotionalWrite(
          this.emotion.snapshot(), prevSnap, ctx,
          this.consecutiveFailures[toolUse.name] || 0
        );
        writeEmotionalTags(aizo, tags).catch(() => {});

        // ── Step 12: Record episode ─────────────────────────────────────
        this.memory.episodicBuffer.push({
          type: result.exitCode === 0 ? 'ToolSuccess' : 'ToolFailure',
          summary: `${toolUse.name} → exit ${result.exitCode}`,
          tool: toolUse.name,
          exitCode: result.exitCode,
        });

        const output = result.exitCode === 0
          ? (result.stdout || '(no output)')
          : `Error: ${result.stderr || 'unknown error'}`;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: output,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    return '(max tool call rounds reached)';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _buildSystemPrompt(modifiers, directive, memContext, mode) {
    const parts = [BASE_PROMPT];

    if (modifiers.length > 0) {
      parts.push('\n## Current State\n' + modifiers.map(m => `- ${m}`).join('\n'));
    }
    if (directive) {
      parts.push(`\n## Behavioral Directive\n${directive}`);
    }
    if (memContext) {
      parts.push(`\n## Relevant Memory\n${memContext}`);
    }

    return parts.join('\n');
  }

  _formatMemoryContext() {
    if (this.memory.aizoRecallCache.length === 0) return '';
    return this.memory.aizoRecallCache
      .slice(0, 10)
      .map(e => {
        const weight = (e.effective_weight || e.score || '?').toFixed
          ? (e.effective_weight || e.score).toFixed(1)
          : '?';
        return `[${e.category} ${weight}] ${e.item}: ${e.reason || ''}`;
      })
      .join('\n');
  }

  emotionSummary() {
    const e = this.emotion;
    const mode = selectMode(e, { riskDetected: false, tabooMatched: false }, this.modeWeights);
    const traj = this.trajectory;
    const flow = traj.isFlowState() ? ' ⚡ FLOW' : '';
    return (
      `Mode: ${mode}${flow}\n` +
      this.emotion.display()
    );
  }
}

module.exports = { Runtime };
