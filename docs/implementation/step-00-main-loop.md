# Step 0: Main Loop Skeleton + Working Memory

## Objective

Build the central orchestrator that wires all modules together. This step is
intentionally done first — before individual components are finalized — so the
overall data-flow architecture can be validated with stubs. Each stub is replaced
by the real implementation as steps 1–6 complete.

This step also defines the **Working Memory** data structures, which are the
shared state that every module reads from and writes to during a turn.

## Prerequisites

None. This is the starting skeleton. All module dependencies are satisfied by
stubs that compile and return placeholder data.

---

## Part A: Working Memory Data Structures

File: `src/runtime/working_memory.rs`

Working memory is the agent's "scratchpad" for a single turn. It holds the
task stack, recent episodic events, the last aizo recall results, and the
frozen emotion snapshot used during the current LLM call.

### A.1 Task Stack

```rust
use std::collections::VecDeque;
use std::time::Instant;

/// A single task or sub-task currently tracked by the agent.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub parent_id: Option<String>,  // None = top-level task
    pub status: TaskStatus,
    pub created_at: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TaskStatus {
    Active,
    Paused,      // switched away from, can be resumed
    Completed,
    Abandoned,
}

/// Depth-limited stack of active and paused tasks.
///
/// Depth limit prevents unbounded nesting from runaway subtask chains.
/// When the limit is hit, the oldest Paused task is dropped (not Active).
pub struct TaskStack {
    tasks: Vec<Task>,
    pub max_depth: usize,  // default: 8
}

impl TaskStack {
    pub fn new(max_depth: usize) -> Self {
        Self { tasks: Vec::new(), max_depth }
    }

    pub fn push(&mut self, task: Task) {
        if self.tasks.len() >= self.max_depth {
            // Drop the oldest Paused task to make room
            if let Some(pos) = self.tasks.iter().position(|t| t.status == TaskStatus::Paused) {
                self.tasks.remove(pos);
            }
            // If no paused tasks exist, the stack is full of active tasks —
            // still push but log a warning; the LLM is likely stuck in a loop.
        }
        self.tasks.push(task);
    }

    pub fn active(&self) -> Option<&Task> {
        self.tasks.iter().rev().find(|t| t.status == TaskStatus::Active)
    }

    pub fn active_mut(&mut self) -> Option<&mut Task> {
        self.tasks.iter_mut().rev().find(|t| t.status == TaskStatus::Active)
    }

    pub fn all(&self) -> &[Task] {
        &self.tasks
    }

    /// Count context switches since session start (for Focus delta).
    pub fn switch_count(&self) -> usize {
        self.tasks.iter().filter(|t| t.status == TaskStatus::Paused).count()
    }
}
```

### A.2 Episodic Buffer

```rust
/// One event recorded in the episodic buffer.
#[derive(Debug, Clone)]
pub struct EpisodicEvent {
    pub timestamp: Instant,
    pub event_type: EpisodicEventType,
    pub summary: String,   // one line: "tool git_push failed with exit 128"
    pub tool_name: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EpisodicEventType {
    ToolSuccess,
    ToolFailure,
    Surprise,       // unexpected / novel outcome
    UserFeedback,   // explicit praise or criticism
    Milestone,      // task completed
}

/// Fixed-capacity ring buffer of recent events.
///
/// When full, the oldest event is overwritten (FIFO drop).
/// Capacity default: 50 events (~1 session of moderate activity).
/// The Reflection Agent reads but does not consume — drain_for_reflection
/// returns all events without clearing the buffer.
pub struct EpisodicBuffer {
    events: VecDeque<EpisodicEvent>,
    pub capacity: usize,
}

impl EpisodicBuffer {
    pub fn new(capacity: usize) -> Self {
        Self { events: VecDeque::with_capacity(capacity), capacity }
    }

    pub fn push(&mut self, event: EpisodicEvent) {
        if self.events.len() >= self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    /// Returns all events for Reflection Agent input. Does not clear the buffer.
    pub fn drain_for_reflection(&self) -> Vec<EpisodicEvent> {
        self.events.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }
}
```

### A.3 Working Memory Root

```rust
use crate::runtime::emotion::EmotionSnapshot;
use crate::aizo_bridge::MemoryEntry;

/// The agent's full working memory for the current session.
///
/// This struct lives inside the Runtime and is mutated at each turn.
pub struct WorkingMemory {
    /// Hierarchy of tasks currently tracked.
    pub task_stack: TaskStack,

    /// The current goal, extracted from the active task.
    /// Used by the Attention Gate to filter what enters working memory.
    pub active_context: String,

    /// Ring buffer of key events from this session.
    /// Fed into the Reflection Agent on trigger.
    pub episodic_buffer: EpisodicBuffer,

    /// Results from the most recent aizo recall call.
    /// Refreshed at step 4 of each turn.
    pub aizo_recall_cache: Vec<MemoryEntry>,

    /// Frozen emotion snapshot for the current LLM call.
    /// Set at step 7 (prompt assembly), stays static until step 10.
    pub emotion_snapshot: Option<EmotionSnapshot>,
}

impl WorkingMemory {
    pub fn new() -> Self {
        Self {
            task_stack: TaskStack::new(8),
            active_context: String::new(),
            episodic_buffer: EpisodicBuffer::new(50),
            aizo_recall_cache: Vec::new(),
            emotion_snapshot: None,
        }
    }
}
```

---

## Part B: Runtime Struct

File: `src/runtime/mod.rs`

The Runtime owns all state and drives the 14-step main loop.

### B.1 Runtime definition

```rust
use std::time::Instant;
use crate::runtime::emotion::{EmotionState, EmotionTrajectory};
use crate::runtime::behavioral_mode::{ModeTracker, ModeWeights};
use crate::runtime::working_memory::WorkingMemory;
use crate::tools::ToolRegistry;
use crate::reflection::{ReflectionTrigger, ReflectionHandle};

pub struct Runtime {
    pub working_memory: WorkingMemory,
    pub emotion: EmotionState,
    pub trajectory: EmotionTrajectory,   // sliding window for trend detection
    pub mode_tracker: ModeTracker,       // consecutive EXPLORE counter
    pub mode_baseline: ModeWeights,      // loaded from aizo on session start
    pub tool_registry: ToolRegistry,
    pub reflection_trigger: ReflectionTrigger,

    // Reflection bookkeeping
    pub tool_calls_since_reflection: u32,
    pub last_reflection_at: Instant,

    // Idle tracking (for energy recovery and reflection trigger)
    pub last_activity_at: Instant,

    // In-flight reflection handle (non-blocking)
    pub reflection_handle: Option<ReflectionHandle>,

    // Running counter of consecutive failures for the same tool (L1 detection)
    pub consecutive_tool_failures: std::collections::HashMap<String, u32>,
}

impl Runtime {
    pub fn new(tool_registry: ToolRegistry) -> Self {
        Self {
            working_memory: WorkingMemory::new(),
            emotion: EmotionState::default(),
            trajectory: EmotionTrajectory::new(),
            mode_tracker: ModeTracker::new(),
            mode_baseline: ModeWeights::default(),
            tool_registry,
            reflection_trigger: ReflectionTrigger::default(),
            tool_calls_since_reflection: 0,
            last_reflection_at: Instant::now(),
            last_activity_at: Instant::now(),
            reflection_handle: None,
            consecutive_tool_failures: std::collections::HashMap::new(),
        }
    }
}
```

### B.2 Input and output types

```rust
/// A single input event to the agent.
#[derive(Debug)]
pub enum AgentInput {
    UserMessage { text: String },
    CronTrigger { label: String },
    ToolCallback { tool_name: String, exit_code: i32, stdout: String, stderr: String },
}

/// A single output from the agent.
#[derive(Debug)]
pub struct AgentOutput {
    pub text: String,
    pub tool_call: Option<ToolCallRequest>,
}

#[derive(Debug)]
pub struct ToolCallRequest {
    pub name: String,
    pub params: std::collections::HashMap<String, String>,
}
```

---

## Part C: Main Loop (14 Steps)

File: `src/runtime/mod.rs` (continued)

Each step is a separate method so it can be replaced independently as real
implementations are added.

```rust
impl Runtime {
    /// Execute one full turn of the agent main loop.
    pub fn run_turn(&mut self, input: AgentInput) -> AgentOutput {
        // ── Step 1: Input ────────────────────────────────────────────────
        let (message_text, is_user_message) = self.extract_message(&input);

        // ── Step 2: L1 + L2 Detection ────────────────────────────────────
        let l1_events = self.step2_detect_l1(&message_text);
        // L2 valence: stub (returns 0.0 until Step 6 is complete)
        let valence: f64 = self.step2_valence_stub(&message_text);

        // ── Step 3: Attention Gate ────────────────────────────────────────
        let attention_query = self.step3_attention_gate(&message_text, &l1_events);

        // ── Step 4: aizo recall ───────────────────────────────────────────
        self.step4_aizo_recall(&attention_query);

        // ── Step 5: Emotion State Update (memory-driven events) ───────────
        self.step5_update_emotion(&l1_events, valence);

        // ── Step 6: Mode Select ───────────────────────────────────────────
        let directive = self.step6_select_mode();

        // ── Step 7: System Prompt Assembly (freeze emotion snapshot) ──────
        let system_prompt = self.step7_assemble_prompt(&directive);

        // ── Step 8: LLM Call ──────────────────────────────────────────────
        let llm_response = self.step8_llm_call_stub(&system_prompt, &message_text);

        // ── Step 9: Tool Execution ────────────────────────────────────────
        let tool_result = self.step9_execute_tool(&llm_response);

        // ── Step 10: Emotion Delta (post-tool) ────────────────────────────
        let pre_delta_snapshot = self.emotion.snapshot();
        self.step10_emotion_delta(&tool_result);

        // ── Step 11: Emotional Write → aizo ──────────────────────────────
        self.step11_emotional_write(&pre_delta_snapshot, &tool_result);

        // ── Step 12: Episodic Buffer Write ────────────────────────────────
        self.step12_record_episode(&tool_result, &message_text);

        // ── Step 13: Output ───────────────────────────────────────────────
        let output = self.step13_build_output(&llm_response, &tool_result);

        // ── Step 14: Reflection Check ─────────────────────────────────────
        self.step14_maybe_reflect();

        self.last_activity_at = Instant::now();
        output
    }
}
```

### C.1 Step implementations

```rust
impl Runtime {
    // ── Step 1 ──────────────────────────────────────────────────────────

    fn extract_message(&self, input: &AgentInput) -> (String, bool) {
        match input {
            AgentInput::UserMessage { text } => (text.clone(), true),
            AgentInput::CronTrigger { label } => (format!("CRON: {label}"), false),
            AgentInput::ToolCallback { tool_name, stdout, .. } =>
                (format!("CALLBACK {tool_name}: {stdout}"), false),
        }
    }

    // ── Step 2 ──────────────────────────────────────────────────────────

    fn step2_detect_l1(&self, text: &str) -> Vec<crate::runtime::emotion::DetectedEvent> {
        crate::runtime::emotion::L1KeywordDetector::detect(text)
    }

    fn step2_valence_stub(&self, _text: &str) -> f64 {
        // TODO: replace with valence_scorer::score(text) once Step 6 is built
        0.0
    }

    // ── Step 3 ──────────────────────────────────────────────────────────

    fn step3_attention_gate(&mut self, text: &str, _l1_events: &[crate::runtime::emotion::DetectedEvent]) -> String {
        // Attention gate uses the active task context to focus the recall query.
        // High focus → use precise task description.
        // Low focus → fall back to raw message text.
        if self.emotion.focus >= 0.4 {
            if let Some(task) = self.working_memory.task_stack.active() {
                return task.description.clone();
            }
        }
        text.to_string()
    }

    // ── Step 4 ──────────────────────────────────────────────────────────

    fn step4_aizo_recall(&mut self, query: &str) {
        use crate::aizo_bridge;
        // On recall failure, degrade gracefully: empty cache + fire AizoRecallEmpty
        match aizo_bridge::recall(query, None) {
            Ok(entries) => {
                let strong_match = entries.iter().filter(|e| e.effective_weight >= 7.0).count() >= 5;
                self.working_memory.aizo_recall_cache = entries;
                if strong_match {
                    self.emotion.process_event(
                        &crate::runtime::emotion::DetectedEvent::AizoRecallStrongMatch
                    );
                }
            }
            Err(_) => {
                self.working_memory.aizo_recall_cache = Vec::new();
                self.emotion.process_event(
                    &crate::runtime::emotion::DetectedEvent::AizoRecallEmpty
                );
            }
        }

        if self.working_memory.aizo_recall_cache.is_empty() {
            self.emotion.process_event(
                &crate::runtime::emotion::DetectedEvent::AizoRecallEmpty
            );
        }
    }

    // ── Step 5 ──────────────────────────────────────────────────────────

    fn step5_update_emotion(
        &mut self,
        l1_events: &[crate::runtime::emotion::DetectedEvent],
        valence: f64,
    ) {
        use crate::runtime::emotion::DetectedEvent;

        // Apply L1 keyword events
        for event in l1_events {
            self.emotion.process_event(event);
        }

        // Apply L2 valence if non-neutral (|valence| > 0.3 threshold)
        if valence > 0.3 {
            self.emotion.process_event(&DetectedEvent::UserPositiveKeyword);
        } else if valence < -0.3 {
            self.emotion.process_event(&DetectedEvent::UserNegativeKeyword);
        }

        // Natural decay based on time since last turn
        let elapsed_minutes = self.last_activity_at.elapsed().as_secs_f64() / 60.0;
        if elapsed_minutes > 0.0 {
            self.emotion.natural_decay(elapsed_minutes);
        }
    }

    // ── Step 6 ──────────────────────────────────────────────────────────

    fn step6_select_mode(&mut self) -> crate::runtime::behavioral_mode::BehaviorMode {
        use crate::runtime::behavioral_mode::{detect_signals, select_mode_with_baseline};

        let signals = detect_signals(
            &self.working_memory.active_context,
            &self.working_memory.aizo_recall_cache,
        );
        let mode = select_mode_with_baseline(&self.emotion, &signals, &self.mode_baseline);

        // Track consecutive EXPLORE for autonomous behavior
        if self.mode_tracker.update(mode.clone()) && self.emotion.energy > 0.4 {
            // TODO: append proactive suggestion to next output
        }

        mode
    }

    // ── Step 7 ──────────────────────────────────────────────────────────

    fn step7_assemble_prompt(&mut self, directive: &crate::runtime::behavioral_mode::BehaviorMode) -> String {
        use crate::runtime::emotion::{prompt_modifiers, tool_policy};
        use crate::runtime::behavioral_mode::BehaviorMode as BehaviorDirective;

        // Freeze emotion snapshot for this call
        let snapshot = self.emotion.snapshot();
        self.working_memory.emotion_snapshot = Some(snapshot.clone());

        // Build modifier strings from emotion state
        let mut modifiers = prompt_modifiers(&self.emotion);

        // Add mode directive
        let directive_instruction = crate::runtime::behavioral_mode::mode_directive(directive);
        if !directive_instruction.is_empty() {
            modifiers.push(directive_instruction.to_string());
        }

        // Format aizo memories for the prompt
        let memory_context = self.format_memory_context();

        // Tool policy modulates which tools are listed
        let _policy = tool_policy(&self.emotion);
        let tool_schema = self.tool_registry.schema_for_prompt(); // TODO: filter by policy

        format!(
            "{base}\n\n{modifiers}\n\n## Memory Context\n{memory}\n\n## Available Tools\n{tools}",
            base = BASE_SYSTEM_PROMPT,
            modifiers = modifiers.join("\n"),
            memory = memory_context,
            tools = tool_schema,
        )
    }

    fn format_memory_context(&self) -> String {
        if self.working_memory.aizo_recall_cache.is_empty() {
            return "(no relevant memories)".to_string();
        }
        self.working_memory.aizo_recall_cache.iter()
            .map(|e| format!("[{} {:.1}] {}: {}", e.category, e.effective_weight, e.item, e.reason))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // ── Step 8 (stub) ────────────────────────────────────────────────────

    fn step8_llm_call_stub(&self, _system_prompt: &str, _user_text: &str) -> LlmResponse {
        // TODO: replace with real LLM API call (Anthropic SDK or OpenAI-compatible)
        LlmResponse {
            text: "[LLM STUB — not yet implemented]".to_string(),
            tool_call: None,
        }
    }

    // ── Step 9 ──────────────────────────────────────────────────────────

    fn step9_execute_tool(&mut self, response: &LlmResponse) -> Option<ToolResult> {
        let call = response.tool_call.as_ref()?;

        let output = self.tool_registry.execute(&call.name, call.params.clone());
        self.tool_calls_since_reflection += 1;
        self.emotion.process_event(&crate::runtime::emotion::DetectedEvent::LlmCallCompleted);

        let (exit_code, stdout, stderr) = match &output {
            Ok(o) => (o.exit_code, o.stdout.clone(), o.stderr.clone()),
            Err(e) => (1, String::new(), format!("{e:?}")),
        };

        // Track consecutive failures per tool
        if exit_code == 0 {
            self.consecutive_tool_failures.remove(&call.name);
        } else {
            let count = self.consecutive_tool_failures.entry(call.name.clone()).or_insert(0);
            *count += 1;
        }

        Some(ToolResult {
            tool_name: call.name.clone(),
            exit_code,
            stdout,
            stderr,
            consecutive_failures: *self.consecutive_tool_failures.get(&call.name).unwrap_or(&0),
        })
    }

    // ── Step 10 ─────────────────────────────────────────────────────────

    fn step10_emotion_delta(&mut self, tool_result: &Option<ToolResult>) {
        use crate::runtime::emotion::DetectedEvent;

        let Some(result) = tool_result else { return };

        if result.exit_code == 0 {
            self.emotion.process_event(&DetectedEvent::ToolSuccess);
        } else {
            self.emotion.process_event(&DetectedEvent::ToolFailure {
                same_tool_consecutive_failures: result.consecutive_failures,
            });
        }
    }

    // ── Step 11 ─────────────────────────────────────────────────────────

    fn step11_emotional_write(
        &mut self,
        pre_delta_snapshot: &crate::runtime::emotion::EmotionSnapshot,
        tool_result: &Option<ToolResult>,
    ) {
        use crate::runtime::emotion::{evaluate_emotional_write, write_emotional_tags, EmotionalContext};

        let context = EmotionalContext {
            tool_name: tool_result.as_ref().map(|r| r.tool_name.clone()),
            task_type: self.working_memory.task_stack.active()
                .map(|t| t.description.split_whitespace().take(3).collect::<Vec<_>>().join(" ")),
        };

        let consecutive = tool_result.as_ref()
            .map(|r| *self.consecutive_tool_failures.get(&r.tool_name).unwrap_or(&0))
            .unwrap_or(0);

        let tags = evaluate_emotional_write(
            &self.emotion,
            pre_delta_snapshot,
            &context,
            consecutive,
        );
        write_emotional_tags(&tags);
    }

    // ── Step 12 ─────────────────────────────────────────────────────────

    fn step12_record_episode(&mut self, tool_result: &Option<ToolResult>, user_text: &str) {
        use crate::runtime::working_memory::{EpisodicEvent, EpisodicEventType};

        let event = if let Some(result) = tool_result {
            EpisodicEvent {
                timestamp: Instant::now(),
                event_type: if result.exit_code == 0 {
                    EpisodicEventType::ToolSuccess
                } else {
                    EpisodicEventType::ToolFailure
                },
                summary: format!(
                    "tool {} exited {} — {}",
                    result.tool_name, result.exit_code,
                    if result.exit_code == 0 { &result.stdout[..result.stdout.len().min(80)] }
                    else { &result.stderr[..result.stderr.len().min(80)] }
                ),
                tool_name: Some(result.tool_name.clone()),
                exit_code: Some(result.exit_code),
            }
        } else {
            EpisodicEvent {
                timestamp: Instant::now(),
                event_type: EpisodicEventType::UserFeedback,
                summary: user_text.chars().take(120).collect(),
                tool_name: None,
                exit_code: None,
            }
        };

        self.working_memory.episodic_buffer.push(event);
    }

    // ── Step 13 ─────────────────────────────────────────────────────────

    fn step13_build_output(&self, response: &LlmResponse, _tool_result: &Option<ToolResult>) -> AgentOutput {
        AgentOutput {
            text: response.text.clone(),
            tool_call: response.tool_call.as_ref().map(|tc| ToolCallRequest {
                name: tc.name.clone(),
                params: tc.params.clone(),
            }),
        }
    }

    // ── Step 14 ─────────────────────────────────────────────────────────

    fn step14_maybe_reflect(&mut self) {
        let idle_minutes = self.last_activity_at.elapsed().as_secs_f64() / 60.0;

        if self.reflection_trigger.should_reflect(self.tool_calls_since_reflection, idle_minutes) {
            let input = self.build_reflection_input();
            self.reflection_handle = Some(crate::reflection::spawn_reflection(input));
            self.tool_calls_since_reflection = 0;
            self.last_reflection_at = Instant::now();
        }

        // Poll completed reflection (non-blocking)
        if let Some(handle) = &self.reflection_handle {
            if let Some(result) = handle.try_result() {
                self.apply_reflection_result(result);
                self.reflection_handle = None;
                self.emotion.process_event(
                    &crate::runtime::emotion::DetectedEvent::ReflectionCompleted
                );
            }
        }
    }
}

/// The base system prompt. Emotion modifiers and memory context are appended per-turn.
const BASE_SYSTEM_PROMPT: &str = "\
You are connor-agent, a cyber bionic assistant with human-like reasoning and memory.
You have access to tools and long-term memory. Use them thoughtfully.
When uncertain, ask. When confident, act.";
```

### C.2 Helper types

```rust
#[derive(Debug)]
struct LlmResponse {
    text: String,
    tool_call: Option<LlmToolCall>,
}

#[derive(Debug)]
struct LlmToolCall {
    name: String,
    params: std::collections::HashMap<String, String>,
}

#[derive(Debug)]
struct ToolResult {
    tool_name: String,
    exit_code: i32,
    stdout: String,
    stderr: String,
    consecutive_failures: u32,
}
```

---

## Part D: Session Initialization

File: `src/runtime/mod.rs` (continued)

```rust
impl Runtime {
    /// Full session startup sequence.
    pub fn initialize(&mut self) {
        // 1. Load behavioral mode baselines from aizo
        self.mode_baseline = crate::runtime::behavioral_mode::load_baseline();

        // 2. Load emotion state carry-over from previous session
        //    Regress 50% toward defaults — continuity without entrenchment.
        self.emotion = load_emotion_carry_over();

        // 3. Seed working memory with top-20 aizo entries for attention gate
        if let Ok(top_memories) = crate::aizo_bridge::top(20, None) {
            self.working_memory.aizo_recall_cache = top_memories;
        }
    }

    fn apply_reflection_result(&mut self, result: crate::reflection::ReflectionResult) {
        // Apply retrospective emotion corrections (clamped to avoid wild swings)
        let correction = &result.emotion_correction;
        self.emotion.apply_correction(correction.suggested_novelty_adjustment, "novelty");
        self.emotion.apply_correction(correction.suggested_confidence_adjustment, "confidence");

        // Apply behavioral mode baseline drift
        let m = &result.mode_correction;
        let mut updated = self.mode_baseline.clone();
        updated.explore_bias  = (updated.explore_bias  + m.explore_bias_delta).clamp(-1.0, 1.0);
        updated.conserve_bias = (updated.conserve_bias + m.conserve_bias_delta).clamp(-1.0, 1.0);
        crate::runtime::behavioral_mode::save_baseline(&updated);
        self.mode_baseline = updated;
    }
}

/// Load emotion state from the previous session via aizo.
/// Regresses 50% toward defaults so the agent isn't stuck in a permanent emotional state.
fn load_emotion_carry_over() -> EmotionState {
    let defaults = EmotionState::default();
    // Try loading last session's final state from aizo (stored as a habit entry)
    let prev = crate::aizo_bridge::recall("session-end-emotion-state", Some("habit"))
        .ok()
        .and_then(|v| v.into_iter().next())
        .and_then(|e| serde_json::from_str::<EmotionState>(&e.reason).ok())
        .unwrap_or_else(|| defaults.clone());

    // 50% regression toward defaults
    EmotionState {
        energy:      prev.energy      * 0.5 + defaults.energy      * 0.5,
        focus:       prev.focus       * 0.5 + defaults.focus        * 0.5,
        frustration: prev.frustration * 0.5 + defaults.frustration  * 0.5,
        novelty:     prev.novelty     * 0.5 + defaults.novelty      * 0.5,
        confidence:  prev.confidence  * 0.5 + defaults.confidence   * 0.5,
    }
}
```

---

## Placeholders to Fill

- **[TODO: LLM call implementation (step 8)]** — replace `step8_llm_call_stub` with a real
  Anthropic SDK / OpenAI-compatible call. Which provider? Streaming or single-shot?
- **[TODO: base system prompt]** — `BASE_SYSTEM_PROMPT` is a placeholder. What is the
  full persona and instruction set for connor-agent?
- **[TODO: reflection input builder]** — `build_reflection_input()` is stubbed. It must
  serialize the episodic buffer, emotion log, and current aizo top-20 into the
  `ReflectionInput` struct defined in step-05.
- **[TODO: tool schema filtering by policy]** — when `ToolPolicy.avoid_complex = true`,
  which tools are removed from the schema sent to the LLM? Need a tool complexity
  categorization (simple vs complex). See step-02 placeholder.
- **[TODO: emotion carry-over serialization format]** — `load_emotion_carry_over` stores
  the state as JSON in an aizo entry's `reason` field. Should this be a dedicated aizo
  entry type instead?
