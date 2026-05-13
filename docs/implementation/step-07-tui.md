# Step 7: TUI Design

## Objective

Build a terminal-based interface for interacting with connor-agent. Fast, keyboard-driven, minimal dependencies. Shows the agent's internal state (emotions, drives, memory) without leaving the terminal.

## Design Principles

- **Keybind-driven** — everything has a shortcut, no mouse required
- **Split panels** — chat, memory, status visible simultaneously
- **Minimal rendering** — no heavy UI framework, direct terminal escape codes or lightweight TUI library
- **Human-like transparency** — the user can "see" the agent's emotional state and what it's remembering

## Layout

```
┌─────────────────────────────────────┬──────────────────────┐
│                                     │   Emotion Bar         │
│                                     │   E: ██████░░ 0.72   │
│        Chat Panel                   │   F: ████░░░░ 0.55   │
│        (primary, scrollable)         │   R: ██░░░░░░ 0.18   │
│                                     │   C: ████████ 0.85   │
│   > user: fix the bug in auth       │   N: █████░░░ 0.60   │
│                                     │                       │
│   connor: Let me look at that...    │   Motivation          │
│   connor: [tool: grep "auth"]       │   Cur: ██████░░ 0.7   │
│   connor: Found the issue in        │   Mas: ████░░░░ 0.5   │
│           src/auth/login.rs         │   Uti: ████████ 0.9   │
│                                     │   Con: ██░░░░░░ 0.2   │
│                                     │                       │
│                                     │   Behavior: DeepWork  │
│                                     ├──────────────────────┤
│                                     │   Recent Memory       │
│                                     │   + git commit --amend│
│                                     │   - force push (taboo)│
│                                     │   ...                 │
├─────────────────────────────────────┴──────────────────────┤
│   > _                                                       │
│   Input Bar                                                 │
└────────────────────────────────────────────────────────────┘
```

## Panel Specifications

### Chat Panel (left, ~70% width)

- Scrollable message history with user/agent roles clearly distinguished
- Tool calls shown inline with distinct style (dimmed, prefix `[tool:]`)
- Tool outputs collapsed by default, expandable with a keybind
- Streaming text support (characters appear as LLM generates them)
- Timestamps on hover or toggle
- Message selection for copy/reply

### Status Panel (right, ~30% width)

**Emotion Bar:**
- 5 horizontal bar charts, one per dimension
- Color-coded: Energy (yellow), Focus (blue), Frustration (red), Curiosity (green), Confidence (purple)
- Numeric value displayed next to each bar
- Updates in real-time as the agent works

**Motivation Display:**
- 4 mini bars for the drives
- Current `BehaviorDirective` shown as a label below the bars

**Recent Memory:**
- Last 5 aizo entries that were queried or updated
- Color-coded by category (preference=green, aversion=red, taboo=bold red, habit=dim, style=blue)
- Press a key to expand into full memory browser

### Input Bar (bottom, full width)

- Multi-line input support via keybind toggle
- Command prefix support: `/memory`, `/emotion`, `/reflect`, `/help`
- History navigation (up/down arrows)
- Auto-complete for commands and file paths

### Popups and Overlays

- **Memory Browser** (`Ctrl+m`): full-screen scrollable list of all aizo entries, filterable by category and search
- **Tool History** (`Ctrl+t`): list of recent tool calls with exit codes and truncated output
- **Reflection Status** (`Ctrl+r`): shows last reflection result, trigger manual reflection
- **Emotion Inspector** (`Ctrl+e`): detailed view of emotion delta history for current session

## Keybindings

```
Ctrl+c         Quit
Ctrl+m         Toggle Memory Browser
Ctrl+t         Toggle Tool History
Ctrl+r         Show Reflection Status
Ctrl+e         Toggle Emotion Inspector
Ctrl+s         Toggle Status Panel (full-width chat)
Ctrl+l         Clear chat display (session continues)
Ctrl+p         Previous command in history
Ctrl+n         Next command in history
Tab            Auto-complete
Shift+Enter    Multi-line input
Enter          Send message
```

## Command Prefixes

```
/memory [query]     Query aizo memory
/memory add ...     Add memory entry manually
/memory top [N]     Show top N memories
/emotion            Show detailed emotion state
/emotion reset      Reset emotion to defaults
/reflect            Trigger reflection manually
/reflect status     Show last reflection result
/tools              List available tools
/tools recall [q]   Recall tool memories for query
/help               Show help
/quit               Exit
```

## TUI Framework Options

**[TODO: choose one]**

| Option | Pros | Cons |
|--------|------|------|
| **Ratatui** (Rust) | Fast, mature, same stack as agent | More verbose layout code |
| **Bubble Tea** (Go) | Eloquent Elm-like architecture | Different language stack |
| **Textual** (Python) | Rich widgets, rapid dev | Python dependency, slower |
| **Raw ANSI codes** | Zero dependencies, total control | Labor-intensive to build |
| **ncurses via C FFI** | Battle-tested, universal | Complex C interop |

## Session Management

- Each session gets a unique ID (timestamp-based)
- Session transcript auto-saved to `[TODO: session log directory]`
- On quit: option to run Reflection Agent immediately or defer to cron
- On start: load previous emotion/motivation baselines from aizo

## Placeholders to Fill

- **[TODO: TUI framework choice]** — Ratatui (Rust), Bubble Tea (Go), Textual (Python), raw ANSI, or other?
- **[TODO: color scheme]** — light theme, dark theme, or both? Default colors for each emotion dimension?
- **[TODO: polling interval for emotion updates]** — how often should the TUI refresh the emotion/motivation bars during active work? Every 500ms? Every tool call? On-demand only?
- **[TODO: session log directory]** — where are session transcripts stored? `~/.connor/sessions/`? Project-local `.connor/sessions/`?
- **[TODO: streaming text protocol]** — how does the TUI receive streaming text from the Runtime? Unix socket? stdout pipe? Shared memory? The Runtime needs a streaming output channel.
- **[TODO: multi-line input UX]** — when the user presses Shift+Enter for multi-line, how is the input visually distinguished from chat history? Indentation? Border? Different background?
- **[TODO: mobile/SSH compatibility]** — should the TUI work over SSH connections with limited terminal capabilities? mosh support?
