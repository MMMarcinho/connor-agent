# connor-agent Design Spec

A cyber bionic Agent with human-like thinking and logical reasoning.
connor-agent models human cognition along three core dimensions: **memory with
forgetting curves**, **dynamic emotional states**, and **memory-driven tool learning**.

---

## 1. Design Philosophy

### 1.1 Unified Memory Model

Everything is memory. Personality traits, tool knowledge, user preferences, and
habits all live in one system backed by [aizo](https://github.com/mmmarcinho/aizo).
The only distinction between a "soul-level" trait and a "forgettable habit" is
the **score** assigned to the memory entry.

| Score | Persistence | Analogy |
|-------|------------|---------|
| 10 | Never decays (α = 0) | Core identity, SOUL |
| 7–9 | Slow decay | Deep expertise, confirmed preferences |
| 4–6 | Moderate decay | Habits, emerging patterns |
| 0–3 | Full decay | Aversions, hard limits |

### 1.2 Configuration Minimalism

One file: **MEMORY.md** — a human-readable snapshot of `aizo show` output.
The agent does not read it; it queries aizo directly. The `--bootstrap` command
seeds the aizo DB from MEMORY.md on first run.

| Traditional file | connor-agent equivalent |
|-----------------|------------------------|
| SOUL.md | aizo score=10 (never decays) |
| IDENTITY.md / USER.md | aizo preference/style entries |
| CLAUDE.md / AGENTS.md | Not needed — agent learns from experience |
| SKILL.md | Tool Registry + aizo tool memory (auto-growing) |

---

## 2. Overall Architecture

```
Input (user msg / tool output / cron)
       │
       ▼
┌──────────────────────────────┐
│  Sensory Buffer              │  ← raw input, pre-attention
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Attention Gate              │  ← modulated by Emotion Engine
│  (Focus + Novelty decide     │
│   what enters working memory)│
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐     ┌─────────────────────┐
│  Working Memory              │◄────│  Emotion Engine     │
│  - Emotion state vector      │     │  (5-dim + trajectory│
│  - Task stack                │     │   + emotional memory│
│  - Episodic buffer           │     │   + biased recall)  │
│  - aizo recall results       │     └────────┬────────────┘
│  - Active context            │              │
└──────────┬───────────────────┘     ┌────────┴────────────┐
           │                         │  Behavioral Mode     │
           ▼                         │  (emotion-derived)   │
┌──────────────────────────────┐     └────────┬────────────┘
│  LLM Call                    │◄─────────────┘
│  (system prompt modulated    │    emotion state + mode
│   by emotion + mode)         │    shape every instruction
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Tool Execution              │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐     ┌──────────────────────────┐
│  Output + Event Recording    │────▶│  Reflection Agent        │
│  (emotion updated + written  │     │  (background, async,     │
│   back to aizo as needed)    │     │   memory consolidation)  │
└──────────────────────────────┘     └──────────┬───────────────┘
                                                │
                                                ▼
                                     ┌──────────────────────────┐
                                     │  aizo SQLite             │
                                     │  (long-term memory,      │
                                     │   decay curves)          │
                                     └──────────────────────────┘
```

---

## 3. Emotion Engine

### 3.1 Emotion State Vector

Five dimensions, each 0.0–1.0. The runtime modulates system instructions and
aizo recall queries based on the current state before every LLM call.

| Dimension | Effect on Behavior | Rises When | Falls When |
|-----------|-------------------|------------|------------|
| **Energy** | Response length, tool complexity | Session start, idle recovery | Long sessions, complex tools |
| **Focus** | Attention depth, detail level | Clear goal, steady progress | Task switches, tangents |
| **Frustration** | Conservatism, help-seeking | Consecutive failures | Task success, positive feedback |
| **Novelty** | Explore vs exploit balance | aizo no-match, new task type | Routine tasks, low energy |
| **Confidence** | Decisiveness, verification need | Tool success, strong aizo match | New tools, recent failures |

Each dimension has event-driven delta rules and natural decay toward baseline.
Exact values are in the implementation docs (step-03). All values clamped to [0, 1].
The emotion state is **frozen into a snapshot** at system-prompt assembly time —
tool results affect the *next* call, not the current one, mirroring human temporal experience.

### 3.2 Detection Layers

**L1 — Code signals** (<1 ms): tool exit codes, consecutive failure counters,
aizo recall hit counts, explicit user keywords ("perfect", "wrong"), idle time.

**L2 — Valence scorer** (<5 ms): ~3,000-word dictionary, scores user messages
±1.0. Zero LLM overhead. Cannot detect sarcasm.

**L3 — Reflection layer** (background, async LLM): full session arc analysis.
Detects slow patterns L1/L2 miss. Produces retrospective corrections applied
at the start of the next session.

### 3.3 Runtime Modulation

**System prompt injection** — short directives prepended before each LLM call:

| Condition | Instruction Added |
|-----------|-----------------|
| Energy < 0.3 | "Be concise. Skip explanations." |
| Frustration > 0.6 | "If uncertain, ask for clarification first." |
| Novelty > 0.7 | "Consider whether a better approach exists." |
| Confidence < 0.3 | "Double-check every assumption before acting." |
| Focus < 0.4 | "Re-read the current goal before each action." |

**Tool policy** — adjusts which tools the agent is willing to use:

| State | Tool Policy Effect |
|-------|-------------------|
| Energy < 0.3 or Frustration > 0.7 | Avoid complex tools (docker, kubectl) |
| Frustration > 0.5 | Prefer highest aizo-weight tools (familiar, safe) |
| Novelty > 0.6 and Energy > 0.4 | Allow exploration of low-weight tools |
| Confidence < 0.3 | Insert verification step between tool calls |
| Focus < 0.4 | Reduce parallel tool calls |

### 3.4 Emotional Memory

When an emotion dimension crosses a significant threshold **in an identifiable
context**, the runtime writes an emotional tag back to aizo. The agent remembers
not just what worked, but how specific situations felt.

**Write conditions:**

| Trigger | aizo Write |
|---------|-----------|
| Frustration > 0.7 during tool X | `aizo add aversion "tool-X emotionally taxing" score=3` |
| Confidence > 0.8 at task completion | `aizo add preference "task-<type> confidence builder" score=7` |
| 3+ consecutive failures with same tool | `aizo add aversion "tool-X repeated failure pattern" score=2` |
| User positive feedback after novel approach | `aizo add preference "approach-<type> user-validated" score=8` |

**Read effect:** on the next encounter with a similar context, these entries
surface during aizo recall (step 4) and **pre-load the emotion state as a prior**
before the task begins. A tool that felt frustrating before approaches that turn
with caution already loaded — without the agent needing to fail again first.

### 3.5 Emotion-Biased Recall

The aizo recall query (main loop step 4) is shaped by current emotion state.
Emotion does not just change *how* the agent acts — it changes *what* it remembers.

| State | Recall Modification |
|-------|-------------------|
| Frustration > 0.6 | Append "safe reliable" to query; also pull taboo entries |
| Novelty > 0.7 | Include low-weight entries (exploring unfamiliar ground) |
| Confidence < 0.3 | Restrict to entries with effective_weight ≥ 7 only |
| Energy < 0.3 | Cap results at top-5 (reduce cognitive load) |

This creates a feedback loop: emotional state shapes memory retrieval, which
shapes behavior, which generates new emotional signals, which update memory.

### 3.6 Emotional Trajectory

A sliding window of the last **5 emotion snapshots** tracks trend direction
(rising / stable / falling) per dimension. Trend modifies the modulation thresholds:

- Frustration 0.5 **rising** → triggers caution instructions at the same threshold
  as frustration 0.65 stable
- Confidence 0.4 **rising** → agent acts more decisively than 0.4 falling
- Novelty rising + Confidence rising simultaneously → **flow state**: relax all
  modifiers and allow deeper exploration

Trajectory is computed in-memory only, resets at session end. No aizo overhead.

---

## 4. Behavioral Mode

The Behavioral Mode is derived directly from the emotion state each turn. It
replaces a separate drive-tracking system with a single, emotion-grounded mode
selection that produces the same range of behaviors with far less complexity.

### 4.1 Mode Selection

```
if risk signal OR taboo matched in current context  →  PROTECT
elif Energy < 0.3  OR  Frustration > 0.7           →  CONSERVE
elif Novelty > 0.6 AND Confidence > 0.5            →  EXPLORE
else                                                →  DELIVER
```

| Mode | What the Agent Does |
|------|---------------------|
| **PROTECT** | Warns user, blocks high-risk action, requires explicit confirmation. Safety always wins. |
| **CONSERVE** | Minimal steps, familiar tools only, defers complex decisions. |
| **EXPLORE** | Tries novel tools, investigates root causes, suggests alternatives. |
| **DELIVER** | Efficient execution focused on the stated goal. Default mode. |

The mode produces an additional system prompt directive injected alongside the
emotion modifiers (step 7).

### 4.2 Mode Baselines

The default mode weights (how naturally the agent leans toward each mode at
rest) are stored in aizo as preference entries with score 7–9. A naturally
inquisitive agent has a high-weight EXPLORE baseline. Baselines drift slowly
through Reflection Agent updates — analogous to personality change over time.

### 4.3 Autonomous Behavior

When EXPLORE mode is sustained for 3+ consecutive turns AND Energy > 0.4:

- Suggest proactively: "I noticed X, want me to investigate?"
- Optionally trigger an early Reflection Agent run

PROTECT always overrides autonomous behavior. High-risk operations always
require explicit user confirmation regardless of mode.

---

## 5. Long-Term Memory (aizo)

Decay formula: `w = s · [φ + (1−φ) · e^(−λt)]^((10−s)/10)`

**Memory categories:**

| Category | Meaning | Score Range |
|----------|---------|------------|
| preference | Validated tools / strategies | 7–9 |
| aversion | Failed approaches, avoid | 1–3 |
| habit | Behavioral patterns | 4–6 |
| style | Communication preferences | 7–8 |
| taboo | Hard constraints, SOUL entries | 0–2 or 10 |

**SOUL without SOUL.md:** core personality traits use score=10. At score=10,
α=0 and d(t)^0 ≡ 1 — these entries never decay. Mathematically equivalent to
a hand-written SOUL file, but stored in the same DB as all other memories.

**Score smoothing on merge:** `new = old × 0.4 + incoming × 0.6` — prevents
a single event from overwriting accumulated evidence.

**MEMORY.md** is the sole configuration file: a human-readable snapshot of
`aizo show` output. The agent never reads it; it queries aizo directly.
Run `--bootstrap` to seed the DB from MEMORY.md's `memory-seed` blocks.

---

## 6. Tool System

### 6.1 Two-Layer Architecture

**Tool Registry** — bare function registry (name, parameter schema, handler).
No usage docs, no examples. All "how to use" knowledge lives in aizo.

**Tool Memory** — aizo entries about tools, growing organically:

```
aizo recall "git commit"
→ [preference 8.2] "git commit --amend is safer than reset+commit"
→ [aversion  2.1] "git push --force broke main 3 times"
→ [habit     6.5] "always git diff --stat before committing"
→ [taboo     0.1] "never force push to main under any circumstances"
```

### 6.2 Tool Learning Loop

```
Try tool → Success → aizo add preference  (score smoothing upward)
Try tool → Failure → aizo add aversion   (score smoothing downward)
Long disuse        → decay pulls weight toward floor
Frequent use       → touch resets decay clock, weight stays high
```

First use of a new tool: neutral score 5.0. Success and failure push it up or down.
Long-unused tools naturally decay below recall threshold — organic forgetting.

---

## 7. Reflection Agent

Runs in a forked background thread. Never blocks the user. Analogous to sleep-phase
memory consolidation.

**Triggers** (any one): idle > 10 min, OR 15 cumulative tool calls since last
reflection, OR daily cron.

**Responsibilities:**

1. Scan episodic buffer → extract tool patterns and user preferences → `aizo add`
2. `aizo touch` entries confirmed in this session (reset decay clock)
3. Analyze full session emotional arc (L3) → produce retrospective emotion corrections
4. Update behavioral mode baselines in aizo

**Constraints:** max 8 internal tool calls, output never shown to user,
writes directly to aizo DB. Reflection does not trigger another reflection.

---

## 8. Agent Main Loop

```
 1. Input          ← user message / cron / tool callback
 2. L1 + L2        → emotion signals: exit codes, keywords, valence score
 3. Attention Gate → emotion state filters what enters working memory
 4. aizo recall    → retrieve memories, query modified by emotion state (§3.5)
 5. Emotion Update → apply L1/L2 deltas + memory events; update trajectory (§3.6)
 6. Mode Select    → derive behavioral mode from updated emotion state (§4.1)
 7. Prompt Build   → base + emotion modifiers (§3.3) + mode directive + aizo results
 8. LLM Call       → generate response or tool call
 9. Tool Execute   → capture exit code, stdout, stderr
10. Emotion Delta  → update vector from tool result; update trajectory window
11. Emotion Write  → if threshold crossed in context → aizo add emotional tag (§3.4)
12. Episode Write  → record event to episodic buffer
13. Output         → respond to user
14. Reflection?    → if trigger met → fork Reflection Agent (non-blocking)
```

---

## 9. Implementation Priority

1. **aizo bridge** — all memory operations depend on this
2. **Tool Registry + Tool Memory** — execute tools + record outcomes to aizo
3. **Emotion Engine** — L1 signals, trajectory window, emotional memory write-back,
   emotion-biased recall
4. **Behavioral Mode** — mode selection from emotion state (no separate tracking)
5. **Reflection Agent** — background consolidation (depends on prior modules)
6. **Valence Scorer** — L2 detection, embeddable at any stage
