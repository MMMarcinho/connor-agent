# Step 4: Behavioral Mode

## Objective

Implement the Behavioral Mode system — a single, emotion-derived behavioral
directive that determines what the agent "wants" to do each turn. This replaces
the previous four-drive motivation system with a direct mapping from emotion state
to one of four modes. Same behavioral range, substantially less complexity.

## Prerequisites

- Step 3 (Emotion Engine) complete — mode selection reads emotion state directly

## Implementation

### 4.1 Behavioral Mode enum

File: `src/runtime/behavioral_mode.rs`

```rust
use crate::runtime::emotion::EmotionState;

/// The agent's current behavioral posture. Derived from emotion state each turn.
#[derive(Debug, Clone, PartialEq)]
pub enum BehaviorMode {
    /// Safety first. Warn the user, block high-risk actions, require confirmation.
    Protect,
    /// Minimal effort. Familiar tools, fewest steps, defer complex decisions.
    Conserve,
    /// Exploration. Try novel tools, investigate root causes, suggest alternatives.
    Explore,
    /// Efficient execution. Focus on the stated goal, minimize tangents. Default.
    Deliver,
}
```

### 4.2 Mode selection

Mode is derived from the current emotion state and context signals each turn.
No separate state vector to track — this is a pure function of inputs.

```rust
/// Signals from the current turn that inform mode selection.
pub struct ModeSignals {
    /// A taboo entry matched the current context (from aizo recall).
    pub taboo_matched: bool,
    /// Dangerous keywords detected in the user request.
    pub risk_detected: bool,
}

/// Select the behavioral mode for this turn.
/// Priority order: Protect > Conserve > Explore > Deliver.
pub fn select_mode(emotion: &EmotionState, signals: &ModeSignals) -> BehaviorMode {
    // Safety always wins
    if signals.taboo_matched || signals.risk_detected {
        return BehaviorMode::Protect;
    }

    // Too tired or too frustrated → conserve energy
    if emotion.energy < 0.3 || emotion.frustration > 0.7 {
        return BehaviorMode::Conserve;
    }

    // Novel situation + sufficient confidence → explore
    if emotion.novelty > 0.6 && emotion.confidence > 0.5 {
        return BehaviorMode::Explore;
    }

    BehaviorMode::Deliver
}
```

### 4.3 Mode → system prompt directive

Each mode appends one short directive to the system prompt (in addition to the
emotion modifiers from step 3).

```rust
/// Translate behavioral mode into a system prompt directive string.
pub fn mode_directive(mode: &BehaviorMode) -> &'static str {
    match mode {
        BehaviorMode::Protect =>
            "A safety concern is present. Warn the user and ask for explicit confirmation before proceeding.",
        BehaviorMode::Conserve =>
            "Keep your response minimal. Do only what is explicitly asked. Defer anything complex.",
        BehaviorMode::Explore =>
            "Consider whether a better approach exists before executing. Note interesting alternatives.",
        BehaviorMode::Deliver =>
            "", // no extra directive — default efficient behavior
    }
}
```

### 4.4 Risk and taboo detection

Risk detection is L1 code (no LLM), same as keyword detection in step 3.

```rust
/// Detect risk patterns and taboo matches from user message + aizo recall results.
pub fn detect_signals(
    user_text: &str,
    aizo_results: &[crate::aizo_bridge::MemoryEntry],
) -> ModeSignals {
    let lower = user_text.to_lowercase();

    // L1 risk keyword list
    const RISK_PATTERNS: &[&str] = &[
        "rm -rf", "drop table", "drop database", "force push", "--force",
        "delete all", "truncate", "format disk", "sudo rm", "> /dev/",
        "chmod 777", "kill -9", "pkill", "shutdown", "reboot",
    ];

    let risk_detected = RISK_PATTERNS.iter().any(|p| lower.contains(p));

    // Taboo match: any aizo taboo entry in the recall results
    let taboo_matched = aizo_results.iter()
        .any(|e| e.category == "taboo");

    ModeSignals { taboo_matched, risk_detected }
}
```

### 4.5 Autonomous behavior

When EXPLORE mode is sustained for 3+ consecutive turns AND Energy > 0.4,
the agent may proactively suggest. Tracked by a simple counter in Runtime.

```rust
/// Track consecutive EXPLORE turns for autonomous behavior trigger.
pub struct ModeTracker {
    pub current: BehaviorMode,
    pub consecutive_explore: u32,
}

impl ModeTracker {
    pub fn new() -> Self {
        Self { current: BehaviorMode::Deliver, consecutive_explore: 0 }
    }

    pub fn update(&mut self, new_mode: BehaviorMode) -> bool {
        if new_mode == BehaviorMode::Explore {
            self.consecutive_explore += 1;
        } else {
            self.consecutive_explore = 0;
        }
        self.current = new_mode;

        // Returns true when autonomous suggestion is appropriate
        self.consecutive_explore >= 3
    }
}
```

When `update()` returns true AND `emotion.energy > 0.4`, the agent appends
a proactive suggestion to its response: `"I noticed X — want me to look into it?"`

### 4.6 Mode baseline storage

The agent's natural mode tendency is stored in aizo as a preference entry
(score 7–9). A naturally inquisitive agent has a higher-weight EXPLORE baseline.
Baselines drift through Reflection Agent updates.

```rust
const BASELINE_KEY: &str = "behavioral-mode-baseline";

/// Load mode weights from aizo. Returns default if not found.
pub fn load_baseline() -> ModeWeights {
    let entry = crate::aizo_bridge::recall(BASELINE_KEY, Some("habit"))
        .ok()
        .and_then(|v| v.into_iter().next())
        .and_then(|e| serde_json::from_str::<ModeWeights>(&e.reason).ok());
    entry.unwrap_or_default()
}

/// Save mode weights to aizo. Called by the Reflection Agent.
pub fn save_baseline(weights: &ModeWeights) {
    let json = serde_json::to_string(weights).unwrap_or_default();
    crate::aizo_bridge::add("habit", BASELINE_KEY, &json, 7.0, &[]).ok();
}

/// Natural tendency weights toward each mode (sum need not equal 1).
/// These shift the mode selection thresholds subtly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModeWeights {
    pub explore_bias: f64,   // positive → lowers the Explore novelty threshold
    pub conserve_bias: f64,  // positive → lowers the Conserve energy threshold
}

impl Default for ModeWeights {
    fn default() -> Self {
        Self { explore_bias: 0.0, conserve_bias: 0.0 }
    }
}
```

Apply `ModeWeights` in `select_mode` by adjusting the thresholds:

```rust
pub fn select_mode_with_baseline(
    emotion: &EmotionState,
    signals: &ModeSignals,
    weights: &ModeWeights,
) -> BehaviorMode {
    if signals.taboo_matched || signals.risk_detected {
        return BehaviorMode::Protect;
    }
    // Conserve bias lowers the energy/frustration trigger thresholds
    if emotion.energy < (0.3 + weights.conserve_bias * 0.1)
        || emotion.frustration > (0.7 - weights.conserve_bias * 0.1)
    {
        return BehaviorMode::Conserve;
    }
    // Explore bias lowers the novelty threshold needed to enter Explore
    if emotion.novelty > (0.6 - weights.explore_bias * 0.1)
        && emotion.confidence > 0.5
    {
        return BehaviorMode::Explore;
    }
    BehaviorMode::Deliver
}
```

## Placeholders to Fill

- **[TODO: risk keyword list completeness]** — the 15 patterns in `RISK_PATTERNS` are
  a starting set. What additional patterns should be included? Should this list be
  loaded from an external file for tuning without recompilation?
- **[TODO: autonomous suggestion phrasing]** — what exactly does the agent say when
  autonomous suggestion triggers? Should it be templated or LLM-generated?
- **[TODO: baseline drift rate]** — how much does the Reflection Agent adjust
  `explore_bias` and `conserve_bias` per session? What's the smoothing factor?
- **[TODO: ModeWeights schema validation]** — if the aizo reason field is corrupted,
  `serde_json::from_str` returns None and defaults are used. Is silent fallback
  acceptable, or should it log a warning?
