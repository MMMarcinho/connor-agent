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
///
/// Note: the exploration-drive dimension is named `novelty` here (not `curiosity`)
/// to avoid confusion with `MotivationState::curiosity`, which is a distinct
/// higher-level drive. Both concepts relate to exploration, but emotion Novelty
/// is a reactive signal (input), while motivation Curiosity is a behavioral
/// directive (output).
#[derive(Debug, Clone)]
pub struct EmotionState {
    pub energy: f64,        // decreases with activity, recovers with rest
    pub focus: f64,         // anchored to task clarity
    pub frustration: f64,   // accumulates with failures, decays to baseline
    pub novelty: f64,       // driven by how unknown the current situation is
    pub confidence: f64,    // driven by evidence
}

impl Default for EmotionState {
    fn default() -> Self {
        Self {
            energy:       1.0,   // start fresh
            focus:        0.7,   // reasonably focused
            frustration:  0.05,  // essentially zero
            novelty:      0.5,   // neutral — neither familiar nor alien
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
                self.apply(&mut self.novelty, +0.20);
                self.apply(&mut self.confidence, -0.05);
            }
            AizoRecallStrongMatch => {
                self.apply(&mut self.novelty, -0.10);
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

    /// Natural decay toward baseline for Frustration and Novelty.
    /// Called based on elapsed time since the last turn.
    pub fn natural_decay(&mut self, delta_minutes: f64) {
        let rate = 0.05_f64.powf(delta_minutes); // 5% per minute decay toward baseline
        // Frustration baseline = 0.0
        self.frustration *= rate;
        // Novelty baseline = 0.5 (neither over-stimulated nor under-stimulated)
        self.novelty = 0.5 + (self.novelty - 0.5) * rate;
        // Energy and Confidence do NOT auto-regress
    }

    /// Apply a named correction (used by Reflection Agent for retrospective adjustments).
    pub fn apply_correction(&mut self, delta: f64, dimension: &str) {
        match dimension {
            "energy"      => self.apply(&mut self.energy, delta),
            "focus"       => self.apply(&mut self.focus, delta),
            "frustration" => self.apply(&mut self.frustration, delta),
            "novelty"     => self.apply(&mut self.novelty, delta),
            "confidence"  => self.apply(&mut self.confidence, delta),
            _ => {}
        }
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
    if state.novelty > 0.7 {
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
        allow_exploration: state.novelty > 0.6 && state.energy > 0.4,
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
            novelty: self.novelty,
            confidence: self.confidence,
        }
    }
}

pub struct EmotionSnapshot {
    pub energy: f64,
    pub focus: f64,
    pub frustration: f64,
    pub novelty: f64,
    pub confidence: f64,
}
```

### 3.8 Replay / Simulation Mode

The delta values in §3.3 (0.03, 0.12, 0.25, etc.) are starting estimates.
Without a way to observe them on real sessions, calibration is guesswork.

The replay mode processes a recorded event log through the delta rules and
prints the emotion state at each step, so you can tune values without running
live sessions.

#### 3.8a Event log format

Save events as newline-delimited JSON during live runs (one object per line):

```json
{"ts":"2026-01-01T10:00:00Z","event":"LlmCallCompleted"}
{"ts":"2026-01-01T10:00:01Z","event":"SimpleToolCall"}
{"ts":"2026-01-01T10:00:02Z","event":"ToolSuccess"}
{"ts":"2026-01-01T10:00:10Z","event":"ToolFailure","same_tool_consecutive_failures":1}
{"ts":"2026-01-01T10:00:15Z","event":"UserPositiveKeyword"}
{"ts":"2026-01-01T10:05:00Z","event":"IdlePeriod","minutes":5.0}
```

Write event log in the Runtime main loop alongside episodic buffer writes (step 12).
Default log path: `~/.connor/sessions/<date>-events.jsonl`

#### 3.8b CLI invocation

```
connor-agent --replay ~/.connor/sessions/2026-01-01-events.jsonl
```

#### 3.8c Implementation

```rust
/// Run a saved event log through the emotion engine and print the state trace.
/// Used to calibrate delta values without running a live session.
pub fn replay_session(events_path: &str) {
    let content = std::fs::read_to_string(events_path)
        .expect("could not read event log");

    let mut state = EmotionState::default();
    let mut step = 0usize;

    println!(
        "{:<5} {:<30} {:>7} {:>7} {:>12} {:>8} {:>10}",
        "Step", "Event", "Energy", "Focus", "Frustration", "Novelty", "Confidence"
    );
    println!("{}", "-".repeat(85));

    // Print initial state
    println!(
        "{:<5} {:<30} {:>7.3} {:>7.3} {:>12.3} {:>8.3} {:>10.3}",
        0, "(initial)",
        state.energy, state.focus, state.frustration, state.novelty, state.confidence
    );

    for line in content.lines() {
        let Ok(raw) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Ok(event) = parse_event_json(&raw) else { continue };

        state.process_event(&event);
        step += 1;

        println!(
            "{:<5} {:<30} {:>7.3} {:>7.3} {:>12.3} {:>8.3} {:>10.3}",
            step,
            raw["event"].as_str().unwrap_or("?"),
            state.energy, state.focus, state.frustration, state.novelty, state.confidence
        );
    }

    println!("\nFinal state after {step} events:");
    println!("  energy={:.3} focus={:.3} frustration={:.3} novelty={:.3} confidence={:.3}",
        state.energy, state.focus, state.frustration, state.novelty, state.confidence);
}

fn parse_event_json(raw: &serde_json::Value) -> Result<DetectedEvent, ()> {
    match raw["event"].as_str().ok_or(())? {
        "LlmCallCompleted"      => Ok(DetectedEvent::LlmCallCompleted),
        "SimpleToolCall"        => Ok(DetectedEvent::SimpleToolCall),
        "ComplexToolCall"       => Ok(DetectedEvent::ComplexToolCall),
        "ToolSuccess"           => Ok(DetectedEvent::ToolSuccess),
        "ToolFailure"           => Ok(DetectedEvent::ToolFailure {
            same_tool_consecutive_failures: raw["same_tool_consecutive_failures"]
                .as_u64().unwrap_or(1) as u32,
        }),
        "UserPositiveKeyword"   => Ok(DetectedEvent::UserPositiveKeyword),
        "UserNegativeKeyword"   => Ok(DetectedEvent::UserNegativeKeyword),
        "AizoRecallEmpty"       => Ok(DetectedEvent::AizoRecallEmpty),
        "AizoRecallStrongMatch" => Ok(DetectedEvent::AizoRecallStrongMatch),
        "IdlePeriod"            => Ok(DetectedEvent::IdlePeriod {
            minutes: raw["minutes"].as_f64().unwrap_or(1.0),
        }),
        "ReflectionCompleted"   => Ok(DetectedEvent::ReflectionCompleted),
        _ => Err(()),
    }
}
```

#### 3.8d Calibration workflow

1. Run a live session with event logging enabled.
2. After the session, run `--replay` and review the trace.
3. If `frustration` hit 0.8+ before the user expressed frustration, lower `+0.12` or `+0.20`.
4. If `energy` drained too fast, lower `-0.03` per LLM call.
5. Adjust, re-run `--replay` on the same log, repeat until the trace "feels right."
6. Delta values can be made configurable via a `[emotion_deltas]` section in a
   TOML config file without recompiling — `[TODO: config file path and format]`.

---

## Placeholders to Fill

- **[TODO: initial emotion state]** — should the default values be different? Should they be loaded from aizo on startup (e.g., "this agent tends to start sessions with high novelty")?
- **[TODO: delta values calibration]** — use the replay mode (§3.8) to calibrate. Consider a `[emotion_deltas]` TOML config block so values can be tuned without recompiling.
- **[TODO: natural decay timer granularity]** — natural decay is now computed per-turn based on elapsed time since last turn (see step-00 §C.1 step 5). Confirm this is the right granularity or add a background timer.
- **[TODO: keyword list completeness]** — the positive/negative keyword lists need expansion. Should they be loaded from an external file so they can be tuned without recompilation? Path: `[TODO: keyword list file path]`
- ~~**[TODO: emotion state persistence]**~~ — **resolved in step-00 §D**: the session-end state is stored in aizo and regressed 50% toward defaults at next session start.
- **[TODO: L2 integration point]** — the L1 keyword detector is basic. When L2 (valence scorer) is ready, how should L1 and L2 results be merged? L2 override L1? Both contribute independent deltas?
