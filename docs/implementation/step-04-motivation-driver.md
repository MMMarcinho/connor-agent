# Step 4: Motivation Driver

## Objective

Implement the four-drive motivation system (Curiosity, Mastery, Utility, Conservation)
that determines what the agent "wants" to do. Motivation takes emotion state as input
and produces behavioral directives that modulate tool selection and response strategy.

## Prerequisites

- Step 3 (Emotion Engine) complete — motivation depends on emotion state

## Implementation

### 4.1 Drive state struct

File: `src/runtime/motivation.rs`

```rust
/// Four intrinsic drives. All values clamped to [0.0, 1.0].
#[derive(Debug, Clone)]
pub struct MotivationState {
    /// Drive to explore new patterns, try new tools, suggest improvements.
    pub curiosity: f64,
    /// Drive to pursue high-quality solutions, find root causes.
    pub mastery: f64,
    /// Drive to anticipate needs, protect user, provide extra context.
    pub utility: f64,
    /// Drive to minimize effort, choose shortest path.
    pub conservation: f64,
}

impl Default for MotivationState {
    fn default() -> Self {
        Self {
            curiosity:    0.5,  // neutral
            mastery:      0.5,  // neutral
            utility:      0.6,  // slightly helpful by default
            conservation: 0.3,  // not lazy to start
        }
    }
}

impl MotivationState {
    fn apply(&mut self, f: &mut f64, delta: f64) {
        *f = (*f + delta).clamp(0.0, 1.0);
    }
}
```

### 4.2 Motivation delta rules

Drives are updated after emotion deltas have been applied (main loop step 11).
They react to the same events, but through the lens of current emotion state.

```rust
/// Events for motivation updates. Subset of DetectedEvent + emotion-aware.
pub enum MotivationSignal {
    // From tool execution
    ToolCallSucceeded,
    ToolCallFailed,
    ComplexTaskCompleted,

    // From user interaction
    UserPositiveFeedback,
    UserNegativeFeedback,
    UserUncertainty,          // message contains "maybe", "?", "I think"
    UserExplicitMinimalScope, // "just do X", "简单做一下"

    // From memory
    NovelTask,                // aizo recall returned 0 results
    RoutineTask,              // aizo recall returned ≥5 strong matches
    TabooMatched,             // aizo taboo entry matches current context
    RiskPatternDetected,      // dangerous keywords in user request

    // From emotion
    EnergyState { is_low: bool },
    FrustrationState { is_high: bool },

    // Session
    SessionLongRunning,
}
```

### 4.3 Delta function

```rust
impl MotivationState {
    pub fn process_signal(&mut self, signal: &MotivationSignal, emotion: &EmotionState) {
        use MotivationSignal::*;
        match signal {
            ToolCallSucceeded => {
                self.apply(&mut self.mastery, +0.03);
            }
            ToolCallFailed => {
                self.apply(&mut self.mastery, -0.05);
            }
            ComplexTaskCompleted => {
                self.apply(&mut self.mastery, +0.20);
                self.apply(&mut self.conservation, -0.10); // success encourages depth
            }
            UserPositiveFeedback => {
                self.apply(&mut self.mastery, +0.15);
                self.apply(&mut self.conservation, -0.20); // praise → less lazy
            }
            UserNegativeFeedback => {
                self.apply(&mut self.curiosity, -0.10);    // less explorative
                self.apply(&mut self.conservation, +0.10); // safer
            }
            UserUncertainty => {
                self.apply(&mut self.utility, +0.15);
            }
            UserExplicitMinimalScope => {
                self.apply(&mut self.utility, -0.20);
                self.apply(&mut self.conservation, +0.20);
            }
            NovelTask => {
                self.apply(&mut self.curiosity, +0.25);
            }
            RoutineTask => {
                self.apply(&mut self.curiosity, -0.15);
                self.apply(&mut self.conservation, +0.15);
            }
            TabooMatched => {
                self.apply(&mut self.utility, +0.35);
                self.conservation = 0.0; // force: safety beats all
            }
            RiskPatternDetected => {
                self.apply(&mut self.utility, +0.40);
                self.conservation = 0.0;
            }
            EnergyState { is_low } => {
                if *is_low {
                    self.apply(&mut self.curiosity, -0.30);
                    self.apply(&mut self.mastery, -0.10);
                    self.apply(&mut self.conservation, +0.25);
                }
            }
            FrustrationState { is_high } => {
                if *is_high {
                    self.apply(&mut self.curiosity, -0.30);
                    self.apply(&mut self.conservation, +0.15);
                }
            }
            SessionLongRunning => {
                // long sessions gradually shift toward conservation
                self.apply(&mut self.conservation, +0.05);
            }
        }
    }
}
```

### 4.4 Conflict resolution

```rust
/// Resolve competing drives into a single behavioral directive.
pub fn resolve(state: &MotivationState, emotion: &EmotionState) -> BehaviorDirective {
    // Safety override: high utility + risk → force cautious behavior
    if state.utility > 0.8 {
        return BehaviorDirective::CautiousAssist; // protect user, ignore conservation
    }

    // Conservation-dominant: tired or routine → minimal effort
    if state.conservation > 0.7 && emotion.energy < 0.4 {
        return BehaviorDirective::MinimalEffort;
    }

    // Curiosity + Utility both high → proactive exploration
    if state.curiosity > 0.6 && state.utility > 0.6 {
        return BehaviorDirective::ExploreAlternatives;
    }

    // Mastery-dominant → deep work
    if state.mastery > 0.7 {
        return BehaviorDirective::DeepWork;
    }

    // Default: balanced
    BehaviorDirective::Balanced
}

pub enum BehaviorDirective {
    Balanced,
    CautiousAssist,       // high utility, low risk tolerance
    MinimalEffort,        // conservation-dominant
    ExploreAlternatives,  // curiosity + utility
    DeepWork,             // mastery-dominant
}
```

### 4.5 Drive baseline storage

Drive baselines (the resting values) are stored in aizo as preference entries.
On session start, baselines are loaded from aizo. During the session, actual
drive values fluctuate around these baselines.

```rust
/// Load drive baselines from aizo.
/// Uses well-known item labels that the agent reads on startup.
pub fn load_baselines() -> MotivationState {
    let defaults = MotivationState::default();
    // Try to load from aizo; fall back to defaults
    let curiosity_bl = aizo_bridge::recall("motivation-baseline-curiosity", None)
        .ok().and_then(|v| v.first().map(|e| e.effective_weight / 10.0))
        .unwrap_or(defaults.curiosity);
    let mastery_bl = aizo_bridge::recall("motivation-baseline-mastery", None)
        .ok().and_then(|v| v.first().map(|e| e.effective_weight / 10.0))
        .unwrap_or(defaults.mastery);
    let utility_bl = aizo_bridge::recall("motivation-baseline-utility", None)
        .ok().and_then(|v| v.first().map(|e| e.effective_weight / 10.0))
        .unwrap_or(defaults.utility);
    let conservation_bl = aizo_bridge::recall("motivation-baseline-conservation", None)
        .ok().and_then(|v| v.first().map(|e| e.effective_weight / 10.0))
        .unwrap_or(defaults.conservation);

    MotivationState {
        curiosity: curiosity_bl,
        mastery: mastery_bl,
        utility: utility_bl,
        conservation: conservation_bl,
    }
}

/// Save drive baselines to aizo (called by Reflection Agent).
pub fn save_baselines(state: &MotivationState) {
    aizo_bridge::add("habit", "motivation-baseline-curiosity", "drive baseline",
        state.curiosity * 10.0, &[]).ok();
    aizo_bridge::add("habit", "motivation-baseline-mastery", "drive baseline",
        state.mastery * 10.0, &[]).ok();
    aizo_bridge::add("habit", "motivation-baseline-utility", "drive baseline",
        state.utility * 10.0, &[]).ok();
    aizo_bridge::add("habit", "motivation-baseline-conservation", "drive baseline",
        state.conservation * 10.0, &[]).ok();
}
```

## Placeholders to Fill

- **[TODO: behavior directive → prompt translation]** — how should each `BehaviorDirective` be translated into LLM system prompt instructions? Need a mapping like the Emotion Engine's `prompt_modifiers`.
- **[TODO: autonomous behavior conditions]** — the spec says Curiosity + Utility > 1.5 AND Energy > 0.4 triggers autonomous behavior. What exactly should the agent DO autonomously? List specific actions.
- **[TODO: baseline drift rate]** — how fast should drive baselines change? The Reflection Agent updates them. What's the smoothing factor? (Currently unspecified)
- **[TODO: risk keyword list]** — what specific patterns trigger `RiskPatternDetected`? Needs a comprehensive list similar to the L1 keyword detector. Path: `[TODO: risk keyword list file path]`
- **[TODO: uncertainty signal detection]** — how should `UserUncertainty` be detected? Current approach is keyword-based ("maybe", "?", "I think"). Is this sufficient, or should it use L2? What's the full keyword list?
