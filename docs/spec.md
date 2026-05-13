# connor-agent Design Spec

A cyber bionic Agent with human-like thinking and logical reasoning capabilities.
Unlike OpenClaw and Hermes-Agent, connor-agent models human cognition along multiple
dimensions: memory with forgetting curves, dynamic emotional states, intrinsic
motivation, and memory-driven tool learning.

---

## 1. Design Philosophy

### 1.1 Unified Memory Model

Everything is memory. Personality traits, tool knowledge, user preferences, and
learned habits all live in one memory system backed by [aizo](https://github.com/mmmarcinho/aizo).
The only distinction between a "soul-level" trait and a "forgettable habit" is
the **score** assigned to the memory entry.

| Score | Persistence | Analogy |
|-------|------------|---------|
| 10 | Never decays (α = 0, d(t)^0 ≡ 1) | Core identity, SOUL |
| 7–9 | Slow decay — strong but malleable | Deep expertise, confirmed preferences |
| 4–6 | Moderate decay — fades with disuse | Habits, emerging patterns |
| 0–3 | Full decay — or explicitly taboo | Aversions, hard limits |

### 1.2 Configuration Minimalism

OpenClaw and Hermes-Agent define agent behavior through multiple markdown files:
SOUL.md, IDENTITY.md, USER.md, CLAUDE.md, AGENTS.md, SKILL.md, MEMORY.md.

connor-agent collapses all of these into **one file: MEMORY.md**, which is a
human-readable snapshot of the aizo database (`aizo show` output). The agent
does not read MEMORY.md — it queries aizo directly via `aizo recall`.

The mapping:

| Traditional file | connor-agent equivalent |
|-----------------|------------------------|
| SOUL.md | aizo entries with score=10 (never decays) |
| IDENTITY.md | aizo score=10 preference entries |
| USER.md | aizo preference/aversion/style entries extracted from interaction |
| CLAUDE.md / AGENTS.md | Not needed — agent learns from experience |
| SKILL.md | Tool Registry (bare functions) + aizo tool memory (auto-growing) |
| MEMORY.md | **Kept** — human-readable snapshot, not read by the agent |

### 1.3 Cognitive Realism

connor-agent simulates a human-like cognitive architecture with three memory stages
(sensory → working → long-term), a dynamic emotion system that modulates decision
quality, and an intrinsic motivation system that drives autonomous behavior.

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
│  (Focus + Curiosity decide   │
│   what enters working memory)│
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐     ┌─────────────────┐
│  Working Memory Ring         │◄────│  Emotion Engine │
│  - Emotion state vector      │     │  (5-dim vector) │
│  - Task stack                │     └────────┬────────┘
│  - Episodic buffer           │              │
│  - aizo recall results       │     ┌────────┴────────┐
│  - Active context            │     │ Motivation Driver│
└──────────┬───────────────────┘     │ (4-drive model)  │
           │                         └────────┬────────┘
           ▼                                  │
┌──────────────────────────────┐              │
│  LLM Call                    │◄─────────────┘
│  (system prompt modulated    │    emotion + motivation
│   by emotion + motivation)   │    affect system instructions
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Tool Execution              │
│  (if LLM chose tool)         │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐     ┌──────────────────────────┐
│  Output + Event Recording    │────▶│  Reflection Agent        │
│  (emotion/motivation updated)│     │  (background, forked,    │
└──────────────────────────────┘     │   async consolidation)   │
                                     └──────────┬───────────────┘
                                                │
                                                ▼
                                     ┌──────────────────────────┐
                                     │  aizo SQLite             │
                                     │  (long-term memory,      │
                                     │   with decay curves)     │
                                     └──────────────────────────┘
```

## 3. Working Memory & Emotion Engine

### 3.1 Emotion State Vector

Five dimensions, each 0.0–1.0, managed by the Runtime process (not injected
into the LLM context). The Runtime modulates system instructions based on
current emotion state before each LLM call.

| Dimension | Effect on Behavior | Rises When | Falls When |
|-----------|-------------------|------------|------------|
| **Energy** | Response length, tool complexity | Session start, rest recovery | Long sessions, complex tasks, retries |
| **Focus** | Attention allocation, detail level | Clear goal, steady progress | Context switches, irrelevant outputs |
| **Frustration** | Conservatism, asking-for-help tendency | Consecutive failures, dead ends | Task success, positive user feedback |
| **Curiosity** | Explore vs exploit balance | Novel tasks, aizo no-match | Routine tasks, low energy |
| **Confidence** | Decisiveness, verification need | Successful tool calls, strong aizo match | New tools, weak aizo match, recent failures |

### 3.2 Three-Layer Detection System

Emotion deltas are driven by a three-layer detection architecture. Only the
third layer involves an LLM, and it runs asynchronously.

**L1 — Signal Layer** (realtime, <1ms, pure code):
- Tool exit codes (0 = success, ≠0 = failure)
- Consecutive failure/success counters
- aizo recall result counts and weight thresholds
- Explicit user keywords ("perfect", "exactly", "no don't", "wrong", "bad")
- Session duration and idle time

**L2 — Valence Layer** (realtime, <5ms, word-list lookup):
- A pre-compiled ~3,000 word valence dictionary
- Scores user messages for positive/negative emotional charge
- Zero LLM overhead, pure table lookup + weighted average
- Detects explicit praise/criticism; cannot detect sarcasm

**L3 — Reflection Layer** (background, >10s latency, LLM):
- Full session arc analysis for complex emotional assessment
- Detects patterns L1/L2 miss (persistence on wrong approach, ignoring subtle cues)
- Produces "retrospective" emotional corrections (like human evening reflection)

### 3.3 Delta Rules

Each dimension has concrete event → delta mappings. All values are clamped to [0, 1].

**Energy** (consumption model, no auto-regression):
- -0.03 per LLM call
- -0.01 per simple tool call (read, grep, ls)
- -0.05 per complex tool call (docker, kubectl, long script)
- +0.20 on explicit rest / idle > 5min
- +0.15 after each Reflection Agent completion

**Focus** (task-anchored):
- +0.05 per step with clear goal and successful progress
- -0.08 per tool output irrelevant to current goal (detected via L3 only)
- -0.10 on task/subtask switch
- +0.02 per step when >10 steps without context switch

**Frustration** (failure-accumulating, decays to baseline at 5%/min):
- +0.12 per tool failure (exit ≠ 0)
- +0.20 additional when same tool fails 3+ consecutive times
- -0.25 on task completion success
- -0.15 on positive user feedback (L1 keyword or L2 valence > 0.5)

**Curiosity** (novelty-driven, decays to baseline at 5%/min):
- +0.20 when aizo recall returns 0 results (completely novel)
- -0.10 when aizo recall returns ≥5 strong matches (routine)
- -0.30 override when Energy < 0.3 (tired → less curious)

**Confidence** (evidence-driven, no auto-regression):
- +0.08 when aizo recall average weight ≥ 7
- +0.05 per step for 5+ consecutive successful steps
- -0.10 per tool failure or aizo recall no-match

### 3.4 Runtime Modulation

The emotion state affects behavior through system instruction injection (not
by modifying the LLM, but by prepending short directives before each call):

| Condition | System Instruction Modifier |
|-----------|---------------------------|
| Energy < 0.3 | "Be concise. Skip explanations." |
| Frustration > 0.6 | "If uncertain, ask for clarification first." |
| Curiosity > 0.7 | "Consider alternative approaches." |
| Confidence < 0.3 | "Double-check your assumptions before acting." |
| Focus < 0.4 | "Re-read the current goal before taking action." |

And on tool selection:
- Low Energy → avoid complex tools (docker, kubectl, long-running ops)
- High Frustration → prefer tools with highest aizo weight (familiar, safe)
- High Curiosity → allow exploration of low-weight but relevant tools
- Low Confidence → insert verification steps between tool calls
- Low Focus → reduce parallel tool calls

---

## 4. Motivation System

### 4.1 Four-Drive Model

Four intrinsic drives, each 0.0–1.0, determine what the agent "wants" to do.
Emotions are input to motivation; motivation is output that shapes behavior.

| Drive | Drives What Behavior | Rises When | Falls When |
|-------|---------------------|------------|------------|
| **Curiosity** | Explore new patterns, try new tools, suggest improvements | Novel tasks, aizo no-match, fresh session | Routine tasks, high frustration |
| **Mastery** | Pursue high-quality solutions, find root causes, self-correct | Task success, positive feedback, strong aizo match | Repeated failures, trivial tasks |
| **Utility** | Anticipate unstated needs, provide extra context, protect user from errors | Risk keywords detected, user uncertainty signals, taboo match | User says "just do X", high frustration |
| **Conservation** | Choose minimal-step solutions, merge tool calls, skip non-essential checks | Low energy, familiar simple tasks, user wants speed | High-risk operations, user praised thoroughness |

### 4.2 Drive Conflict Resolution

When drives compete, the strongest combination wins:

| Scenario | Curiosity | Mastery | Utility | Conservation | Result |
|----------|-----------|---------|---------|-------------|--------|
| Fix a bug | 0.4 | **0.8** | 0.5 | 0.3 | Deep root-cause fix, not patch |
| "How do I do X?" | **0.7** | 0.6 | **0.7** | 0.2 | Answer + suggest better alternatives |
| Low energy, refactor needed | 0.1 | 0.3 | 0.4 | **0.9** | Minimal safe change, mark TODO |
| Safety risk detected | 0.1 | 0.2 | **0.95** | **0.0 forced** | Block and warn, ignore conservation |

### 4.3 Drive Regulation (Auto-Regulation)

Same event-driven delta mechanism as emotions, using code-detectable triggers:

Curiosity:
- +0.25 aizo recall returns 0 results
- -0.15 aizo recall ≥ 5 strong matches
- -0.08 per round for 3+ rounds of same operation type
- Override to -0.30 when Frustration > 0.6

Mastery:
- +0.03 per successful tool call
- +0.15 per positive user feedback (L2 valence > 0.5)
- +0.20 per complex task completion
- -0.10 when Energy < 0.2

Utility:
- +0.40 risk keywords detected (rm -rf, DROP, force push, etc.)
- +0.15 user uncertainty signals ("maybe", "?", "I think")
- +0.35 aizo taboo entry matches current context
- -0.20 user explicitly says "just do X"

Conservation:
- +0.25 when Energy < 0.3
- +0.15 when Frustration > 0.5
- +0.15 when task matches aizo habit category (familiar routine)
- -0.20 when user praised previous deep work
- Forced to 0 when safety risk is present

### 4.4 Motivation Baseline Storage

Drive baselines (the resting values drives regress toward during idle time) are
themselves stored in aizo as preference entries with score 7–9. This means:

- A naturally "curious" agent has a high-baseline Curiosity entry in aizo
- Baseline drifts slowly through Reflection Agent updates (like personality change)
- Current drive values are ephemeral (in working memory); baselines are persistent (in aizo)

### 4.5 Emotion Snapshot Mechanism

When the Runtime assembles the system prompt (main loop step 7), it captures a
**frozen snapshot** of the emotion state vector. This snapshot stays static for
the duration of that LLM call — the LLM sees one consistent emotional frame.

Emotion deltas from the LLM's own tool executions are applied AFTER the call
completes (step 10), affecting the NEXT call. This is analogous to human
experience: you don't feel the emotional effect of your own action until after
you've done it.

### 4.6 Autonomous Behavior

When Curiosity + Utility > 1.5 AND Energy > 0.4, the agent may proactively:
- Organize or improve recently touched code (Mastery-driven)
- Suggest "I noticed X, want me to look?" (Utility-driven)
- Run Reflection Agent to analyze recent sessions (Curiosity-driven)
- Trigger via cron timer (similar to OpenClaw HEARTBEAT+CRON)

Hard constraints always apply: taboos win, high-risk operations require user confirmation.

---

## 5. Long-Term Memory (aizo Integration)

connor-agent uses [aizo](https://github.com/mmmarcinho/aizo) as its long-term
memory engine. aizo provides:

- **Score-modulated exponential decay**: w = s · [φ + (1−φ) · e^(−λt)]^((10−s)/10)
- **Five memory categories**: preference, aversion, habit, style, taboo
- **Score smoothing on merge**: new = old × 0.4 + incoming × 0.6 (confirmation bias)
- **Touch mechanism**: reset decay clock without changing score
- **CLI subprocess interface**: agents call `aizo recall`, `aizo add`, `aizo top`, etc.
- **SQLite + WAL**: local, fast, no server needed

### 5.1 Memory Categories in connor-agent

| Category | Meaning in connor-agent | Typical Score Range |
|----------|------------------------|---------------------|
| preference | Validated tools/strategies/methods | 7–9 |
| aversion | Failed approaches, paths to avoid | 1–3 |
| habit | Behavioral patterns, workflow inertia | 4–6 |
| style | Communication style preferences | 7–8 |
| taboo | Hard constraints, safety rules, SOUL | 0–2 |

### 5.2 SOUL Without SOUL.md

Core personality traits are stored as preference entries with score=10.
At score=10, α=0 and d(t)^0 ≡ 1, so these memories never decay — they are
mathematically equivalent to a hand-written SOUL file, but live in the same
database as all other memories and can be updated through the same mechanisms.

### 5.3 aizo Bridge Module

A thin wrapper in connor-agent that calls aizo as a subprocess:

```
connor-agent/src/aizo_bridge/
├── recall(query, category?) → Vec<MemoryEntry>
├── add(category, item, reason, score)
├── touch(category, item)
├── top(n, category?) → Vec<MemoryEntry>
└── analyze(session_text) → ExtractionResult
```

### 5.4 MEMORY.md

The sole configuration file. A human-readable snapshot of `aizo show` output,
formatted as prose. The agent does NOT read this file — it queries aizo directly.
MEMORY.md exists for the human to inspect, edit, or bootstrap initial memories.

---

## 6. Tool System

### 6.1 Two-Layer Architecture

**Tool Registry** — bare function registry. Contains only:
- name (e.g., `git_commit`)
- parameter schema (name + type)
- handler function pointer

No usage documentation, no examples, no "when to use" guidance. All of that
lives in aizo.

**Tool Memory** — aizo entries about tools. Grows organically through use:
```
aizo recall "git commit"
→ [preference 8.2] "git commit --amend is safer than reset+commit"
→ [aversion  2.1] "git push --force broke main 3 times"
→ [habit     6.5] "always git diff --stat before committing"
→ [taboo     0.1] "never force push to main under any circumstances"
```

### 6.2 Tool Learning Loop

```
Try tool → Success → aizo add preference "tool_name" "+score smoothing"
Try tool → Failure → aizo add aversion  "tool_name"  "-score smoothing"
Long disuse      → decay curve pulls weight toward floor
Frequent use     → touch resets decay clock, weight stays high
```

### 6.3 Tool Discovery

The agent discovers available tools by querying memory, not reading config:
- `aizo top 20 --type preference` → currently most-familiar tools
- If returns few results → Curiosity rises → agent may browse the Registry
  (but the Registry only has schemas, not "how to use")
- First use of a new tool → initial score 5.0 (neutral) → success/failure
  pushes it up or down

### 6.4 Comparison with Hermes-Agent Skills

| | Hermes-Agent | connor-agent |
|---|---|---|
| Tool definition | SKILL.md directory | Registry (bare function) |
| Tool knowledge | SKILL.md hand-written steps + pitfalls | aizo memory (auto-growing) |
| How agent learns | Read docs → follow steps | Try → fail/succeed → memory solidifies |
| Pitfalls source | Review Agent appends to SKILL.md | aizo aversion entries (auto-decay) |
| Can it "forget"? | No, SKILL.md is permanent | Yes, long-unused skills decay to floor |

---

## 7. Reflection Agent

Analogous to human sleep: daytime experiences are consolidated, strengthened,
or pruned during offline periods. Runs in background, never blocks the user.

### 7.1 Responsibilities

| Role | Analogy | Action |
|------|---------|--------|
| Memory consolidation | Sleep: hippocampus → neocortex | Scan episodic buffer → extract tool patterns and user preferences → `aizo add` |
| Decay clock refresh | Rehearsal strengthens memory | `aizo touch` entries that appeared in recent sessions |
| Deep emotion assessment (L3) | "In hindsight, I was too stubborn" | Analyze full session arc → retrospective emotion corrections |
| Motivation baseline update | Personality drift over time | Adjust drive baselines based on accumulated experience |

### 7.2 Trigger Conditions

Any one of:
- Session end / idle > 10 minutes
- 15 cumulative tool calls since last reflection
- Cron schedule (e.g., daily at midnight, similar to OpenClaw HEARTBEAT)

### 7.3 Isolation Constraints

- Forked process/thread, stdout → /dev/null (never interrupts user)
- Independent LLM call with its own context window
- Max 8 internal tool calls (budget limit)
- Nudge counters disabled (no recursive reflection)
- Output writes directly to aizo DB, never announced to user

### 7.4 Prompt Structure

```
System: "You are a background memory consolidation agent. Review the session and identify:
1. Tool patterns worth remembering (successes and failures)
2. User preferences demonstrated (explicit or implicit)
3. Emotional signals from the interaction arc
Output JSON only. If nothing is worth saving, return empty."

User: <full session transcript>
      <current aizo top 20>
      <emotion state log from this session>
```

---

## 8. Valence Scorer (L2)

A lightweight, standalone word-list sentiment scorer for real-time user message
emotion detection. Zero LLM overhead, pure table lookup.

### 8.1 Design

- Pre-compiled ~3,000 word-to-valence dictionary
- Valence range: -1.0 (strongly negative) to +1.0 (strongly positive)
- Algorithm: tokenize → lookup → weighted average (with negation handling)
- Compiled as independent binary, callable as subprocess (same pattern as aizo)
- <5ms per message

### 8.2 Output

```
valence("perfect, exactly what I wanted") → +0.85
valence("this is wrong, stop doing that") → -0.70
valence("move the button 5px left")      → ±0.05 (neutral)
```

### 8.3 Limitations

- Cannot detect sarcasm or irony
- Domain-specific vocabulary needs manual extension
- Only scores valence (positive/negative), not complex emotions
- Word list needs periodic maintenance

---

## 9. Agent Main Loop

```
 1. Input                  ← user message / cron trigger / tool callback
 2. L1 + L2 Detection      → extract exit codes, keywords, valence scores
 3. Attention Gate          → emotion state filters what enters working memory
 4. aizo recall             → retrieve relevant long-term memories
 5. Emotion State Read      → current 5-dim emotion vector
 6. Motivation Compute      → 4-drive strength + conflict resolution
 7. System Prompt Assembly  → base prompt + emotion modifiers + aizo results
 8. LLM Call                → generate response / tool selection
 9. Tool Execution           → capture exit code, stdout, stderr
10. Emotion Delta            → update emotion vector based on step 9 results
11. Motivation Delta         → update drive strengths based on emotion changes
12. Episodic Buffer Write    → record event (success/failure/surprise)
13. Output                   → send response to user
14. Reflection Check         → if trigger met → fork Reflection Agent (non-blocking)
```

---

## 10. Project Structure

```
connor-agent/
├── MEMORY.md                 ← sole config file (human-readable aizo snapshot)
├── src/
│   ├── main.rs               ← entry point, CLI parsing
│   ├── runtime/
│   │   ├── mod.rs             ← main loop orchestration
│   │   ├── emotion.rs         ← emotion engine (5-dim vector + delta rules)
│   │   └── motivation.rs      ← motivation driver (4-drive + conflict resolution)
│   ├── tools/
│   │   ├── mod.rs             ← Tool Registry (bare function registration)
│   │   └── builtins/          ← built-in tool implementations
│   ├── reflection/
│   │   └── mod.rs             ← Reflection Agent (fork + consolidate)
│   ├── valence/
│   │   └── mod.rs             ← L2 valence scorer (word-list lookup)
│   └── aizo_bridge/
│       └── mod.rs             ← aizo subprocess wrapper
├── Cargo.toml
└── .gitignore
```

External dependencies:
- **aizo** — long-term memory engine (independent binary, already built)
- **LLM API** — reasoning engine (Anthropic / OpenAI-compatible)

---

## 11. Comparison with Existing Frameworks

| Dimension | OpenClaw | Hermes-Agent | connor-agent |
|-----------|----------|-------------|-------------|
| Memory model | 4-layer (session → daily → MEMORY.md → vector) | 3-layer (hot/cold/retrieval) + bounded text | **Unified aizo DB + forgetting curves** |
| Forgetting | Manual curation only | Character limit forces curation | **Score-modulated exponential decay** |
| Personality | SOUL.md (hand-written) | MEMORY.md + USER.md (hand-written) | **aizo score=10 entries (never decays)** |
| Tool system | Skill directory + SKILL.md | SKILL.md (auto-generated by Review Agent) | **Registry bare functions + aizo memory auto-growth** |
| Emotion/personality | None | None | **5-dim emotion vector + 4-drive motivation** |
| Config files | 6+ .md files | 4+ .md files | **1 file: MEMORY.md** |
| Self-reflection | No independent system | Nudge Engine (background fork) | **Reflection Agent (L3 + memory consolidation)** |
| Agent learning | Skills are hand-written, updated manually | Skills auto-generated from experience | **All knowledge lives in aizo, auto-decays and auto-reinforces** |

---

## 12. Implementation Priority

1. **aizo bridge** — aizo is already built. Establish connor-agent ↔ aizo communication first.
2. **Tool Registry + Tool Memory** — minimum viable: execute tools + auto-record success/failure to aizo.
3. **Emotion Engine** — L1 signal layer first (exit codes, counters). L2 valence scorer later.
4. **Motivation Driver** — add drive conflict resolution on top of Emotion Engine.
5. **Reflection Agent** — background consolidation, last to add (depends on prior modules maturing).
6. **Valence Scorer** — standalone micro-project, can be inserted at any stage.
