# Implementation Steps

## Step Documents

0. **[step-00-main-loop.md](step-00-main-loop.md)** — Main Loop Skeleton + Working Memory *(start here)*
   - Defines `WorkingMemory` data structures: `TaskStack`, `EpisodicBuffer`, `WorkingMemory`
   - Full `Runtime` struct wiring all modules together
   - 14-step main loop with stub implementations for each module
   - Session initialization sequence (emotion carry-over, motivation baseline load)
   - 5 placeholders: LLM call impl, base system prompt, reflection input builder, tool complexity filter, emotion carry-over format

1. **[step-01-aizo-bridge.md](step-01-aizo-bridge.md)** — aizo subprocess wrapper
   - §1.4a: Degraded behavior policy — per-call fallback table + subprocess timeout *(resolved)*
   - §1.5: MEMORY.md bootstrap command (`--bootstrap`) with `memory-seed` block format *(resolved)*
   - 3 remaining placeholders: binary path, DB strategy, stdin vs file

2. **[step-02-tool-registry.md](step-02-tool-registry.md)** — Tool Registry + Tool Memory
   - 5 placeholders: built-in tool list, sandboxing approach, output truncation, seed memories, tool categorization

3. **[step-03-emotion-engine.md](step-03-emotion-engine.md)** — Emotion Engine (L1)
   - `EmotionState.curiosity` renamed to `novelty` (distinct from `MotivationState.curiosity`)
   - §3.8: Replay/simulation mode for calibrating delta values *(resolved)*
   - Emotion state persistence resolved in step-00 §D *(resolved)*
   - 4 remaining placeholders: initial state, delta calibration config, keyword list, L2 integration

4. **[step-04-motivation-driver.md](step-04-motivation-driver.md)** — Motivation Driver
   - 5 placeholders: directive-to-prompt mapping, autonomous actions, baseline drift rate, risk keywords, uncertainty detection

5. **[step-05-reflection-agent.md](step-05-reflection-agent.md)** — Reflection Agent
   - `EmotionLogEntry` and `EmotionCorrection` updated for `novelty` rename
   - 7 placeholders: LLM provider, tool call limit, correction application, logging, recursion prevention, cron integration, failure handling

6. **[step-06-valence-scorer.md](step-06-valence-scorer.md)** — Valence Scorer (L2)
   - 8 placeholders: language choice, dictionary source, maintenance plan, negation list, intensifier values, binary name, language support, merge validation

7. **[step-07-tui.md](step-07-tui.md)** — TUI Design
   - 7 placeholders: framework choice, color scheme, polling interval, session log dir, streaming protocol, multi-line UX, SSH compatibility

8. **[step-08-webui.md](step-08-webui.md)** — WebUI Design
   - 11 placeholders: tech stack, WebSocket library, authentication, CORS, port/binding, transcript format, streaming vs polling, mobile breakpoints, chart library, settings schema, theme system

## Placeholder Format

Every placeholder uses the format `[TODO: question or description]`.
Resolved items are marked ~~strikethrough~~ in their respective step documents.

Search open placeholders: `grep -rn '\[TODO:' docs/implementation/`

**Total: ~63 placeholders across 9 documents (5 resolved).**
