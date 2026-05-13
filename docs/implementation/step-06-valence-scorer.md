# Step 6: Valence Scorer (L2)

## Objective

Build a lightweight, standalone binary that scores user messages for
emotional valence (positive/negative) using a pre-compiled word dictionary.
Zero LLM overhead, pure table lookup + arithmetic, < 5ms per message.

This is an independent micro-project — it can be developed in parallel with
Steps 2–5. It follows the same design pattern as aizo: CLI subprocess that
connor-agent calls.

## Prerequisites

- None (independent of other steps)
- Optional: Rust toolchain (if reusing aizo's tech stack)
- **[TODO: choose implementation language — Rust (matching aizo), or something else?]**

## Implementation

### 6.1 Design

```
User message → Tokenize → Word lookup in valence dictionary
    → Weighted average (with negation handling)
    → Output: single valence score [-1.0, +1.0]
```

### 6.2 Word dictionary format

File: `[TODO: path to dictionary file, e.g. data/valence_dict.txt]`

```
# Format: word<TAB>valence_score
# Score range: -1.0 (strongly negative) to +1.0 (strongly positive)
# Comments start with #

perfect  0.90
excellent 0.85
great    0.80
good     0.60
okay     0.10
bad     -0.60
terrible -0.85
wrong   -0.55
hate    -0.80
stop    -0.30
never   -0.40
```

**Dictionary size:** ~3,000 words. Source options:
- AFINN (public domain, ~2,500 English words with valence -5 to +5)
- VADER lexicon (MIT licensed, ~7,500 entries including emoticons and slang)
- Custom-built from [TODO: specify source or approach]

### 6.3 Negation handling

Words like "not", "never", "don't", "doesn't" invert the valence of the
following 1–2 words:

```
"not good"     → good(0.60) × -0.8 = -0.48
"not terrible" → terrible(-0.85) × -0.8 = +0.68
"don't like"   → like(0.50) × -0.8 = -0.40
```

### 6.4 Intensifier handling

Words like "very", "extremely", "really", "absolutely" amplify the next word:

```
"very good"     → good(0.60) × 1.3 = 0.78
"extremely bad" → bad(-0.60) × 1.5 = -0.90
```

### 6.5 CLI interface

Match aizo's CLI style:

```
valence "perfect, exactly what I wanted"
→ {"score": 0.85, "positive": true, "magnitude": 0.85}

valence "this is wrong, stop doing that"
→ {"score": -0.70, "positive": false, "magnitude": 0.70}

valence "move the button 5px left"
→ {"score": 0.05, "positive": true, "magnitude": 0.05}
```

JSON output by default (for connor-agent), human-readable with `--text` flag.

```rust
// Pseudocode CLI
#[derive(Parser)]
struct Cli {
    /// The text to analyze
    text: String,
    /// Output human-readable instead of JSON
    #[arg(long)]
    text: bool,
    /// Path to custom dictionary
    #[arg(long)]
    dict: Option<PathBuf>,
}
```

### 6.6 Integration with connor-agent

connor-agent calls the valence scorer as a subprocess (same pattern as aizo bridge):

```rust
// In src/valence/mod.rs or inside the Emotion Engine
use std::process::Command;

pub fn score_message(text: &str) -> Result<ValenceResult> {
    let output = Command::new("valence")
        .arg(text)
        .output()?;
    serde_json::from_slice(&output.stdout)
}

#[derive(Debug, Deserialize)]
pub struct ValenceResult {
    pub score: f64,       // -1.0 to +1.0
    pub positive: bool,   // true if score > 0
    pub magnitude: f64,   // absolute value
}
```

### 6.7 L2 → Emotion Delta mapping

When the valence scorer returns a score, it maps to emotion deltas in the
Emotion Engine:

```rust
pub fn valence_to_emotion_delta(score: f64) -> Vec<DetectedEvent> {
    let mut events = Vec::new();

    if score > 0.5 {
        // Strongly positive → user is happy
        events.push(DetectedEvent::UserPositiveKeyword);
    } else if score < -0.4 {
        // Strongly negative → user is unhappy
        events.push(DetectedEvent::UserNegativeKeyword);
    }
    // Neutral scores (-0.4 to 0.5) produce no events

    events
}
```

### 6.8 L1 + L2 merge strategy

L1 (keyword regex) and L2 (valence scorer) both detect sentiment. The merge
strategy:

```
L1 detects positive → +positive event
L2 detects positive → +positive event (independent)
→ Both contribute deltas → reinforces the signal

L1 detects nothing, L2 detects negative → +negative event
→ L2 catches what L1 misses

L1 detects positive, L2 detects negative (contradiction) →
→ Trust L2 (word-list is broader than keyword list)
→ Log the contradiction for debugging
```

## Placeholders to Fill

- **[TODO: implementation language]** — Rust (matching aizo), Python (faster to prototype), or Go? What's preferred?
- **[TODO: dictionary source]** — AFINN (public domain, 2,500 words), VADER (MIT, 7,500 words), or build custom? Where to source the word list?
- **[TODO: dictionary maintenance strategy]** — how should the word list be extended over time with domain-specific vocabulary?
- **[TODO: negation word list]** — what's the complete list of negation words? "not", "never", "don't", "doesn't", "won't", "can't", "shouldn't", "isn't", "aren't", "wasn't", "weren't", "hardly", "barely", "scarcely" — anything else?
- **[TODO: intensifier word list + multipliers]** — "very" (×1.3), "extremely" (×1.5), "really" (×1.2), "absolutely" (×1.5), "so" (×1.2), "quite" (×1.15), "remarkably" (×1.4) — complete list and multiplier values?
- **[TODO: binary name]** — should the binary be called `valence`, `sentiment`, or something else?
- **[TODO: language support]** — English only, or should it support [TODO: other languages]?
- **[TODO: L1/L2 merge strategy validation]** — the merge strategy described above is a starting point. How should we validate which strategy works best? A/B test on real conversations?
