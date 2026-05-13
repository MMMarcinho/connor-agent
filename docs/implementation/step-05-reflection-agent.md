# Step 5: Reflection Agent

## Objective

Implement the background Reflection Agent that consolidates session experiences
into long-term memory (aizo). Analogous to human sleep — runs in background,
never blocks the user, produces memory updates and retrospective emotion assessments.

## Prerequisites

- Step 1 (aizo bridge)
- Step 3 (Emotion Engine) — L3 assessment requires emotion state logs
- Step 4 (Motivation Driver) — baseline updates

## Implementation

### 5.1 Reflection trigger

File: `src/reflection/mod.rs`

```rust
/// Conditions that trigger a Reflection run.
pub struct ReflectionTrigger {
    /// Trigger after N cumulative tool calls since last reflection.
    pub tool_call_threshold: u32, // default: 15

    /// Trigger after idle time exceeds this.
    pub idle_minutes_threshold: f64, // default: 10.0

    /// Cron-like schedule.
    /// [TODO: cron expression format — same as system cron? simplified?]
    pub cron_schedule: Option<String>,
}

impl Default for ReflectionTrigger {
    fn default() -> Self {
        Self {
            tool_call_threshold: 15,
            idle_minutes_threshold: 10.0,
            cron_schedule: None, // [TODO: set default cron schedule? e.g. "0 2 * * *"]
        }
    }
}

impl ReflectionTrigger {
    pub fn should_reflect(
        &self,
        tool_calls_since_last: u32,
        idle_minutes: f64,
    ) -> bool {
        tool_calls_since_last >= self.tool_call_threshold
            || idle_minutes >= self.idle_minutes_threshold
    }
}
```

### 5.2 Session data collection

Before forking the Reflection Agent, the Runtime collects:

```rust
pub struct ReflectionInput {
    /// Full session transcript (user messages + agent responses).
    pub session_transcript: String,

    /// Current top-20 aizo entries (for dedup and context).
    pub current_memories: Vec<MemoryEntry>,

    /// Emotion state log from the session:
    /// snapshot of the 5-dim vector after each event.
    pub emotion_log: Vec<EmotionLogEntry>,

    /// Motivation state log from the session.
    pub motivation_log: Vec<MotivationLogEntry>,

    /// Episodic buffer: key events from the session.
    pub episodic_events: Vec<EpisodicEvent>,
}

pub struct EmotionLogEntry {
    pub timestamp: String,
    pub energy: f64,
    pub focus: f64,
    pub frustration: f64,
    pub curiosity: f64,
    pub confidence: f64,
    pub trigger_event: String,
}

pub struct MotivationLogEntry {
    pub timestamp: String,
    pub curiosity: f64,
    pub mastery: f64,
    pub utility: f64,
    pub conservation: f64,
}

pub struct EpisodicEvent {
    pub timestamp: String,
    pub event_type: EpisodicEventType,
    pub summary: String, // one-line: "tool git_push failed with exit 128"
}

pub enum EpisodicEventType {
    Success,
    Failure,
    Surprise,     // unexpected outcome
    UserFeedback, // explicit praise or criticism
    Milestone,    // task completed
}
```

### 5.3 Forking and isolation

```rust
use std::thread;
use std::sync::mpsc;

/// Fork a Reflection Agent. Returns immediately — the reflection runs
/// in a separate thread and writes results to aizo on completion.
pub fn spawn_reflection(input: ReflectionInput) -> ReflectionHandle {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let result = run_reflection(input);
        let _ = tx.send(result); // caller can check later; usually ignored
    });

    ReflectionHandle { rx }
}

pub struct ReflectionHandle {
    rx: mpsc::Receiver<ReflectionResult>,
}

impl ReflectionHandle {
    /// Check if reflection completed. Non-blocking.
    pub fn try_result(&self) -> Option<ReflectionResult> {
        self.rx.try_recv().ok()
    }
}
```

### 5.4 Reflection prompt and LLM call

```rust
fn run_reflection(input: ReflectionInput) -> ReflectionResult {
    const MAX_TOOL_CALLS: u32 = 8; // budget limit

    let prompt = build_reflection_prompt(&input);

    // Call LLM with the reflection prompt.
    // The LLM response is parsed as JSON and used to:
    // 1. Call aizo add for new memories
    // 2. Call aizo touch for confirmed memories
    // 3. Return emotion/motivation corrections
    // ...

    // [TODO: LLM call implementation — which provider? which model?]
    let llm_response = call_llm_for_reflection(&prompt)?;
    let reflection: ReflectionOutput = parse_reflection_output(&llm_response)?;

    // Apply to aizo
    for entry in &reflection.new_entries {
        aizo_bridge::add(&entry.category, &entry.item, &entry.reason,
            entry.base_score, &entry.keywords).ok();
    }
    for touch in &reflection.confirmed_items {
        aizo_bridge::touch(&touch.category, &touch.item).ok();
    }

    ReflectionResult {
        new_memories: reflection.new_entries.len(),
        confirmed_memories: reflection.confirmed_items.len(),
        emotion_correction: reflection.emotion_correction,
        motivation_correction: reflection.motivation_correction,
    }
}
```

### 5.5 Reflection prompt template

```rust
fn build_reflection_prompt(input: &ReflectionInput) -> String {
    format!(
        r#"You are a background memory consolidation agent. Your job is to review a
completed session and identify what should be remembered.

## Current Memory Profile
{current_memories}

## Session Transcript
{session_transcript}

## Emotion State Log
{emotion_log}

## Episodic Events
{episodic_events}

## Instructions
1. Identify tool patterns worth remembering (successes AND failures). For each:
   - category: "preference" for successful patterns, "aversion" for failures
   - item: a short label (≤5 words)
   - reason: one sentence describing what happened
   - base_score: 7-9 for successes, 1-3 for failures
   - keywords: 3-6 related terms

2. From the current memory profile, identify which entries were clearly
   demonstrated or confirmed in this session (to reset their decay clock).
   Return their category and item.

3. Analyze the emotion state log for the overall emotional arc:
   - Was the agent persistently frustrated at anything?
   - Did the agent miss signals from the user?
   - What emotion corrections would you suggest for next session?

4. If nothing is worth saving, return empty arrays.

Return ONLY valid JSON with this exact shape:
{{
  "new_entries": [
    {{"category": "...", "item": "...", "reason": "...", "base_score": 0.0, "keywords": []}}
  ],
  "confirmed_items": [
    {{"category": "...", "item": "..."}}
  ],
  "emotion_correction": {{
    "note": "one sentence summary of emotional arc",
    "suggested_confidence_adjustment": 0.0,
    "suggested_curiosity_adjustment": 0.0
  }},
  "motivation_correction": {{
    "suggested_curiosity_baseline_delta": 0.0,
    "suggested_mastery_baseline_delta": 0.0,
    "suggested_utility_baseline_delta": 0.0,
    "suggested_conservation_baseline_delta": 0.0
  }}
}}"#,
        current_memories = format_current_memories(&input.current_memories),
        session_transcript = input.session_transcript,
        emotion_log = format_emotion_log(&input.emotion_log),
        episodic_events = format_episodic_events(&input.episodic_events),
    )
}
```

### 5.6 Output parsing

```rust
#[derive(Debug, Deserialize)]
struct ReflectionOutput {
    new_entries: Vec<NewMemoryEntry>,
    confirmed_items: Vec<ConfirmItem>,
    emotion_correction: EmotionCorrection,
    motivation_correction: MotivationCorrection,
}

#[derive(Debug, Deserialize)]
struct NewMemoryEntry {
    category: String,
    item: String,
    reason: String,
    base_score: f64,
    keywords: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ConfirmItem {
    category: String,
    item: String,
}

#[derive(Debug, Deserialize)]
struct EmotionCorrection {
    note: String,
    suggested_confidence_adjustment: f64,
    suggested_curiosity_adjustment: f64,
}

#[derive(Debug, Deserialize)]
struct MotivationCorrection {
    suggested_curiosity_baseline_delta: f64,
    suggested_mastery_baseline_delta: f64,
    suggested_utility_baseline_delta: f64,
    suggested_conservation_baseline_delta: f64,
}

fn parse_reflection_output(llm_response: &str) -> Result<ReflectionOutput> {
    // Strip markdown fences, parse JSON, validate
    // ...
}
```

### 5.7 Reflection result

```rust
#[derive(Debug)]
pub struct ReflectionResult {
    pub new_memories: usize,
    pub confirmed_memories: usize,
    pub emotion_correction: EmotionCorrection,
    pub motivation_correction: MotivationCorrection,
}
```

## Placeholders to Fill

- **[TODO: LLM provider for Reflection]** — which model and provider should the Reflection Agent use? A flash/cheap model (like claude-haiku or GPT-4o-mini) is recommended since it's background. Which one?
- **[TODO: Reflection max tool calls]** — the spec says max 8 internal tool calls. Is 8 the right number? Should this be configurable?
- **[TODO: emotion/motivation correction application]** — the Reflection Agent produces suggested corrections to emotion/motivation. How should the Runtime apply these? Immediately for the next session? Gradually over the next N turns? Only if the Reflection LLM is highly confident?
- **[TODO: Reflection output logging]** — should Reflection results be logged anywhere for debugging? A log file? Aizo entries don't show "why" a memory was created. Should we keep a separate reflection log?
- **[TODO: recursive reflection prevention]** — the spec says "nudge counters disabled" to prevent infinite recursion. How exactly is this enforced? By checking if the caller is already a Reflection Agent?
- **[TODO: cron integration]** — how should cron-triggered reflection work? Does connor-agent have its own scheduler, or does it rely on the system cron daemon?
- **[TODO: Reflection failure handling]** — what happens if the Reflection LLM call fails (API error, timeout)? Retry? Skip? Queue for later?
