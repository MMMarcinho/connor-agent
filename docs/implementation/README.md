# Implementation Steps

## Step Documents

1. **[step-01-aizo-bridge.md](step-01-aizo-bridge.md)** — aizo subprocess wrapper
   - 4 placeholders: binary path, DB strategy, stdin vs file, error handling policy

2. **[step-02-tool-registry.md](step-02-tool-registry.md)** — Tool Registry + Tool Memory
   - 5 placeholders: built-in tool list, sandboxing approach, output truncation, seed memories, tool categorization

3. **[step-03-emotion-engine.md](step-03-emotion-engine.md)** — Emotion Engine (L1)
   - 6 placeholders: initial state, delta calibration, decay timer, keyword list expansion, state persistence, L2 integration point

4. **[step-04-motivation-driver.md](step-04-motivation-driver.md)** — Motivation Driver
   - 5 placeholders: directive-to-prompt mapping, autonomous actions, baseline drift rate, risk keywords, uncertainty detection

5. **[step-05-reflection-agent.md](step-05-reflection-agent.md)** — Reflection Agent
   - 7 placeholders: LLM provider, tool call limit, correction application, logging, recursion prevention, cron integration, failure handling

6. **[step-06-valence-scorer.md](step-06-valence-scorer.md)** — Valence Scorer (L2)
   - 8 placeholders: language choice, dictionary source, maintenance plan, negation list, intensifier values, binary name, language support, merge validation

7. **[step-07-tui.md](step-07-tui.md)** — TUI Design
   - 7 placeholders: framework choice, color scheme, polling interval, session log dir, streaming protocol, multi-line UX, SSH compatibility

8. **[step-08-webui.md](step-08-webui.md)** — WebUI Design
   - 11 placeholders: tech stack, WebSocket library, authentication, CORS, port/binding, transcript format, streaming vs polling, mobile breakpoints, chart library, settings schema, theme system

## Placeholder Format

Every placeholder uses the format `[TODO: question or description]`.

Search all files with: `grep -rn '\[TODO:' docs/implementation/`

**Total: 58 placeholders across 8 documents.**
