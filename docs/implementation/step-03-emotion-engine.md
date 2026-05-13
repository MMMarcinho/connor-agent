# Step 3: Emotion Engine

## Objective

Implement the 5-dimension dynamic emotion state vector and the L1 signal layer
for event-driven emotion delta computation. The L2 valence scorer is covered in
Step 6 and can be developed in parallel.

## Prerequisites

- Step 2 (Tool Registry) complete (emotion deltas depend on tool execution outcomes)

## Implementation

### 3.1 Emotion state struct

File: `src/runtime/emotion.rs`

```rust
/// 5-dimension emotion state vector. All values clamped to [0.0, 1.0].
#[derive(Debug, Clone)]
pub struct EmotionState {
    pub energy: f64,        // decreases with activity, recovers with rest
    pub focus: f64,         // anchored to task clarity
    pub frustration: f64,   // accumulates with failures, decays to baseline
    pub curiosity: f64,     // driven by novelty
    pub confidence: f64,    // driven by evidence
}

impl Default for EmotionState {
    fn default() -> Self {
        Self {
            energy:       1.0,   // start fresh
            focus:        0.7,   // reasonably focused
            frustration:  0.05,  // essentially zero
            curiosity:    0.5,   // neutral
            confidence:   0.5,   // neutral — no evidence yet
        }
    }
}

impl EmotionState {
    /// Apply a delta and clamp to [0.0, 1.0].
    fn apply(&mut self, f: &mut f64, delta: f64) {
        *f = (*f + delta).clamp(0.0, 1.0);
    }
}
```

### 3.2 Detected event types

Events are produced by the Runtime during the main loop and passed to the
Emotion Engine for processing.

```rust
/// Events that can trigger emotion deltas. All code-detectable (L1).
#[derive(Debug, Clone)]
pub enum DetectedEvent {
    // Activity
    LlmCallCompleted,
    SimpleToolCall,           // read, grep, ls, stat — low cost
    ComplexToolCall,          // docker, kubectl, long script — high cost

    // Outcomes
    ToolSuccess,              // exit code = 0
    ToolFailure { same_tool_consecutive_failures: u32 },

    // Task
    StepTowardGoalCompleted,
    TaskCompleted,
    TaskSwitched,

    // User signals (L1 keyword detection)
    UserPositiveKeyword,      // "perfect", "exactly", "great", "love this"
    UserNegativeKeyword,      // "no don't", "wrong", "bad", "stop"

    // Memory
    AizoRecallEmpty,          // no results — novel situation
    AizoRecallStrongMatch,    // ≥5 results with weight ≥ 7

    // Time
    IdlePeriod { minutes: f64 },
    ReflectionCompleted,
}
```

### 3.3 Delta function

```rust
impl EmotionState {
    /// Process a detected event and update the emotion vector.
    pub fn process_event(&mut self, event: &DetectedEvent) {
        use DetectedEvent::*;
        match event {
            LlmCallCompleted => {
                self.apply(&mut self.energy, -0.03);
            }
            SimpleToolCall => {
                self.apply(&mut self.energy, -0.01);
            }
            ComplexToolCall => {
                self.apply(&mut self.energy, -0.05);
            }
            ToolSuccess => {
                self.apply(&mut self.frustration, -0.10);
                self.apply(&mut self.confidence, +0.03);
            }
            ToolFailure { same_tool_consecutive_failures } => {
                self.apply(&mut self.frustration, +0.12);
                self.apply(&mut self.confidence, -0.10);
                if *same_tool_consecutive_failures >= 3 {
                    self.apply(&mut self.frustration, +0.20); // extra spike
                }
            }
            StepTowardGoalCompleted => {
                self.apply(&mut self.focus, +0.05);
                // consecutive success also lifts confidence
                self.apply(&mut self.confidence, +0.02);
            }
            TaskCompleted => {
                self.apply(&mut self.frustration, -0.25);   // big relief
                self.apply(&mut self.confidence, +0.10);
            }
            TaskSwitched => {
                self.apply(&mut self.focus, -0.10);
            }
            UserPositiveKeyword => {
                self.apply(&mut self.frustration, -0.15);
                self.apply(&mut self.confidence, +0.08);
            }
            UserNegativeKeyword => {
                self.apply(&mut self.frustration, +0.12);
                self.apply(&mut self.confidence, -0.08);
            }
            AizoRecallEmpty => {
                self.apply(&mut self.curiosity, +0.20);
                self.apply(&mut self.confidence, -0.05);
            }
            AizoRecallStrongMatch => {
                self.apply(&mut self.curiosity, -0.10);
                self.apply(&mut self.confidence, +0.08);
            }
            IdlePeriod { minutes } => {
                // energy recovers
                self.apply(&mut self.energy, minutes * 0.04);
            }
            ReflectionCompleted => {
                self.apply(&mut self.energy, +0.15);
            }
        }
    }

    /// Natural decay toward baseline for Frustration and Curiosity.
    /// Called on a timer (e.g., every minute).
    pub fn natural_decay(&mut self, delta_minutes: f64) {
        let rate = 0.05_f64.powf(delta_minutes); // 5% per minute decay toward baseline
        // Frustration baseline = 0.0
        self.frustration *= rate;
        // Curiosity baseline = 0.5
        self.curiosity = 0.5 + (self.curiosity - 0.5) * rate;
        // Energy and Confidence do NOT auto-regress
    }
}
```

### 3.4 L1 keyword detector

Simple pattern matching for user message sentiment. More sophisticated detection
comes from the L2 Valence Scorer (Step 6).

```rust
/// Simple keyword-based sentiment detection for user messages.
pub struct L1KeywordDetector;

impl L1KeywordDetector {
    const POSITIVE: &'static [&'static str] = &[
        "perfect", "exactly", "great", "love this", "thank",
        "yes", "good", "nice", "works", "awesome", "much better",
    ];
    const NEGATIVE: &'static [&'static str] = &[
        "no don't", "wrong", "bad", "stop", "hate this",
        "not what i", "incorrect", "nope", "doesn't work", "revert",
    ];

    pub fn detect(message: &str) -> Vec<DetectedEvent> {
        let lower = message.to_lowercase();
        let mut events = Vec::new();

        if Self::POSITIVE.iter().any(|kw| lower.contains(kw)) {
            events.push(DetectedEvent::UserPositiveKeyword);
        }
        if Self::NEGATIVE.iter().any(|kw| lower.contains(kw)) {
            events.push(DetectedEvent::UserNegativeKeyword);
        }
        events
    }
}
```

### 3.5 System prompt modulation

```rust
/// Generate emotion-driven modifier strings for the LLM system prompt.
pub fn prompt_modifiers(state: &EmotionState) -> Vec<String> {
    let mut modifiers = Vec::new();

    if state.energy < 0.3 {
        modifiers.push("Be concise. Skip explanations unless critical.".into());
    }
    if state.frustration > 0.6 {
        modifiers.push("If uncertain about anything, ask for clarification first. Prefer safe approaches.".into());
    }
    if state.curiosity > 0.7 {
        modifiers.push("Consider alternative approaches and note interesting observations.".into());
    }
    if state.confidence < 0.3 {
        modifiers.push("Double-check every assumption before acting. Verify outputs carefully.".into());
    }
    if state.focus < 0.4 {
        modifiers.push("Re-read the current goal before taking each action. Stay on track.".into());
    }

    modifiers
}
```

### 3.6 Tool selection modulation

```rust
/// Adjust which tools the agent is willing to use based on emotion state.
pub fn tool_policy(state: &EmotionState) -> ToolPolicy {
    ToolPolicy {
        avoid_complex: state.energy < 0.3 || state.frustration > 0.7,
        prefer_familiar: state.frustration > 0.5,
        allow_exploration: state.curiosity > 0.6 && state.energy > 0.4,
        require_verification_step: state.confidence < 0.3,
        reduce_parallel: state.focus < 0.4,
    }
}

pub struct ToolPolicy {
    pub avoid_complex: bool,
    pub prefer_familiar: bool,
    pub allow_exploration: bool,
    pub require_verification_step: bool,
    pub reduce_parallel: bool,
}
```

### 3.7 Emotion snapshot for prompt assembly

```rust
impl EmotionState {
    /// Freeze a snapshot for the current LLM call.
    /// This snapshot stays static for the entire call.
    pub fn snapshot(&self) -> EmotionSnapshot {
        EmotionSnapshot {
            energy: self.energy,
            focus: self.focus,
            frustration: self.frustration,
            curiosity: self.curiosity,
            confidence: self.confidence,
        }
    }
}

pub struct EmotionSnapshot {
    pub energy: f64,
    pub focus: f64,
    pub frustration: f64,
    pub curiosity: f64,
    pub confidence: f64,
}
```

## Placeholders to Fill

- **[TODO: initial emotion state]** — should the default values be different? Should they be loaded from aizo on startup (e.g., "this agent tends to start sessions with high curiosity")?
- **[TODO: delta values calibration]** — all delta values (0.03, 0.12, 0.25, etc.) are starting points. What's the process for tuning them? Do you want a config file or CLI flags to adjust them without recompiling?
- **[TODO: natural decay timer granularity]** — should natural decay run on a 1-minute timer, or be recomputed on each event based on elapsed time?
- **[TODO: keyword list completeness]** — the positive/negative keyword lists need expansion. Should they be loaded from an external file so they can be tuned without recompilation? Path: `[TODO: keyword list file path]`
- **[TODO: emotion state persistence]** — should the emotion state survive across sessions? If the agent was "tired and frustrated" at the end of session A, should session B start with those same values, or reset to defaults?
- **[TODO: L2 integration point]** — the L1 keyword detector is basic. When L2 (valence scorer) is ready, how should L1 and L2 results be merged? L2 override L1? Both contribute independent deltas?
