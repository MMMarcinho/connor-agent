# Implementation Steps

## Step Documents

0. **[step-00-main-loop.md](step-00-main-loop.md)** — Main Loop + Working Memory *(start here)*
   - `WorkingMemory`: `TaskStack` (depth 8), `EpisodicBuffer` (ring of 50)
   - `Runtime` struct: owns emotion, trajectory, mode tracker, tool registry
   - 14-step `run_turn` with stubs for each module
   - Session init: mode baseline + emotion carry-over (50% regression)
   - 5 placeholders: LLM provider, base system prompt, reflection input, tool complexity filter, emotion serialization

1. **[step-01-aizo-bridge.md](step-01-aizo-bridge.md)** — aizo subprocess wrapper
   - §1.4a: Degraded behavior policy — per-call fallback table + timeouts *(resolved)*
   - §1.5: `--bootstrap` command with `memory-seed` block format *(resolved)*
   - 3 remaining placeholders: binary path, DB strategy, stdin vs file

2. **[step-02-tool-registry.md](step-02-tool-registry.md)** — Tool Registry + Tool Memory
   - 5 placeholders: built-in tool list, sandboxing, output truncation, seed memories, categorization

3. **[step-03-emotion-engine.md](step-03-emotion-engine.md)** — Emotion Engine
   - 5-dim vector (Energy, Focus, Frustration, Novelty, Confidence)
   - `EmotionState.curiosity` renamed to `novelty` *(resolved)*
   - §3.8: Replay/simulation mode for delta calibration *(resolved)*
   - §3.9: Emotional Memory — threshold-triggered aizo write-back
   - §3.10: Emotion-Biased Recall — emotion shapes what the agent retrieves
   - §3.11: Emotional Trajectory — sliding window trend adjusts thresholds
   - Emotion state persistence resolved in step-00 *(resolved)*
   - 4 remaining placeholders: initial state, delta config format, keyword list, L2 merge

4. **[step-04-behavioral-mode.md](step-04-behavioral-mode.md)** — Behavioral Mode *(replaces motivation driver)*
   - 4 modes: PROTECT, CONSERVE, EXPLORE, DELIVER
   - Pure function of emotion state — no separate drive vector
   - Baseline weights stored in aizo, drift via Reflection Agent
   - 4 placeholders: risk keyword list, autonomous phrasing, drift rate, schema validation

5. **[step-05-reflection-agent.md](step-05-reflection-agent.md)** — Reflection Agent
   - Updated `EmotionLogEntry` and `EmotionCorrection` for `novelty` rename *(resolved)*
   - 7 placeholders: LLM provider, tool call limit, correction application, logging, recursion prevention, cron, failure handling

6. **[step-06-valence-scorer.md](step-06-valence-scorer.md)** — Valence Scorer (L2)
   - 8 placeholders: language, dictionary source, maintenance, negation, intensifiers, binary name, language support, merge validation

7. **[step-07-tui.md](step-07-tui.md)** — TUI Design
   - 7 placeholders: framework, colors, polling interval, session log dir, streaming protocol, multi-line UX, SSH compatibility

8. **[step-08-webui.md](step-08-webui.md)** — WebUI Design
   - 11 placeholders: tech stack, WebSocket, auth, CORS, port, transcript format, streaming, mobile, chart library, settings schema, theme

## Placeholder Format

Every open placeholder uses `[TODO: ...]`. Resolved items are struck through in their documents.

Search open placeholders: `grep -rn '\[TODO:' docs/implementation/`

**Total: ~47 open placeholders across 9 documents (11 resolved).**
