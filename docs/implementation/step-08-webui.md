# Step 8: WebUI Design

## Objective

Build a browser-based interface for connor-agent. Richer than the TUI —
full memory visualization, emotion timeline charts, multi-session management,
and a polished chat experience.

## Design Principles

- **Data-dense but calm** — information is accessible but not overwhelming
- **Progressive disclosure** — emotion/memory details are one click away, not always visible
- **Real-time updates** — emotion state, tool execution, and memory changes stream live
- **Mobile-responsive** — usable on phone/tablet for on-the-go agent interaction

## Page Structure

```
┌─────────────────────────────────────────────────────┐
│  connor-agent                          [⚙ Settings] │
├──────────┬────────────────────────┬─────────────────┤
│          │                        │                 │
│ Session  │     Chat Area          │  Agent Status   │
│ List     │                        │                 │
│          │  ┌──────────────────┐  │  Emotion        │
│ ├─ Today │  │ user: message    │  │  ████████ 0.72  │
│ ├─ Today │  │                  │  │                 │
│ ├─ Today │  │ connor: response │  │  Motivation     │
│ ├─ Today │  │ [tool: grep ...] │  │  DeepWork       │
│ ├─ Today │  │                  │  │                 │
│ ├─ Today │  └──────────────────┘  │  Recent Memory  │
│          │                        │  • git commit    │
│          │  ┌──────────────────┐  │  • force push    │
│          │  │ Input...         │  │                 │
│          │  └──────────────────┘  │                 │
├──────────┴────────────────────────┴─────────────────┤
│  Memory Browser  |  Tool History  |  Reflection Log  │
└─────────────────────────────────────────────────────┘
```

## View Specifications

### 1. Chat View (center, primary)

The main interaction surface.

- Message bubbles with role distinction (user = right-aligned, agent = left-aligned)
- Tool calls rendered as collapsible cards:
  - Collapsed: `grep "auth" src/` with status icon (✓ spinner or ✗)
  - Expanded: shows stdout preview (first 500 chars) and exit code
  - Failed tools highlighted with red border
- Streaming text with typing indicator (cursor blink during generation)
- Timestamps on hover
- Code blocks with syntax highlighting
- Markdown rendering (links, lists, code, bold, italic)
- Message actions on hover: copy, retry (resend as new prompt), delete

### 2. Session List (left sidebar)

- Chronological list of past sessions
- Each entry shows: first user message (truncated), timestamp, message count
- Active session highlighted
- Click to switch sessions (read-only for past sessions unless resumed)
- Search/filter sessions
- Session actions: rename, delete, export transcript

### 3. Agent Status Panel (right sidebar)

**Emotion Card:**
- 5 mini bar charts with numeric labels
- Color gradient: red (low/critical) → yellow (mid) → green (optimal)
- Tooltip shows last 3 events that changed each dimension
- Click to expand → full emotion timeline chart for current session

**Motivation Card:**
- 4 drive indicators
- Current `BehaviorDirective` shown as a colored badge
- Click to expand → drive history chart

**Recent Memory Card:**
- Last 5 aizo entries touched
- Color-coded by category
- Click any entry → full detail (score, reason, decay curve)
- Click "View All" → opens Memory Browser

### 4. Memory Browser (bottom panel / modal)

- Full aizo database viewer
- Table columns: Category, Item, Score, Effective Weight, Last Seen, Reason
- Sortable by any column
- Filter by category (tabs: All / Preferences / Aversions / Habits / Styles / Taboos)
- Search by keyword
- Click entry → detail view with decay curve visualization
- Actions: edit score, touch (reset decay), delete, add new entry

### 5. Tool History (bottom panel / modal)

- Table: Timestamp, Tool Name, Exit Code, Duration, Truncated Output
- Filter by success/failure
- Click → full stdout/stderr
- Summary stats: success rate, most-used tools, most-failed tools

### 6. Emotion Timeline (modal, accessed from Status Panel)

- Line chart showing 5 emotion dimensions over the current session
- X-axis: event number or timestamp
- Y-axis: 0.0 to 1.0
- Hover to see the event that triggered each change
- Toggle individual dimensions on/off
- Annotations for significant events (task completed, major failure, user praise)

### 7. Reflection Log (bottom panel / modal)

- List of past Reflection Agent runs
- Each entry: timestamp, new memories created, memories confirmed, emotion correction notes
- Click to see full reflection output
- "Trigger Reflection Now" button

### 8. Settings Page

```
General:
  [TODO: settings list]

LLM Provider:
  Provider: [Anthropic ▾]
  Model: [claude-sonnet-4-6-20250514 ▾]
  API Key: [••••••••••••••••]

aizo:
  DB Path: [~/.aizo/preferences.db    ] [Browse]
  Half-life: [30] days
  Floor: [0.10]

Emotion:
  [TODO: emotion-specific settings]

Appearance:
  Theme: [Dark ▾] | [Light]
  Font size: [14px ▾]
```

## Data Flow

```
Browser (WebUI)
    ↕  WebSocket (real-time) + HTTP REST (queries)
connor-agent HTTP Server
    ↕  internal channels
Runtime (emotion, motivation, tools)
    ↕  subprocess
aizo (long-term memory)
```

### WebSocket Events (server → client)

```json
{"type": "message.chunk", "text": "partial response..."}
{"type": "message.complete", "message": {...}}
{"type": "tool.started", "name": "grep", "params": {...}}
{"type": "tool.completed", "name": "grep", "exit_code": 0, "output_preview": "..."}
{"type": "emotion.update", "state": {"energy": 0.72, "focus": 0.55, ...}}
{"type": "motivation.update", "state": {...}, "directive": "DeepWork"}
{"type": "memory.updated", "entry": {...}}
{"type": "reflection.completed", "result": {...}}
```

### REST Endpoints

```
GET    /api/sessions              List sessions
GET    /api/sessions/:id          Get session messages
POST   /api/sessions/:id/message  Send a message (starts streaming via WS)
DELETE /api/sessions/:id          Delete session

GET    /api/memory                List aizo entries (query params: category, search, limit)
POST   /api/memory                Add/update aizo entry
DELETE /api/memory/:id            Remove aizo entry
POST   /api/memory/:id/touch      Reset decay clock

GET    /api/tools                 List available tools
GET    /api/tools/history         Recent tool executions

GET    /api/emotion               Current emotion state
GET    /api/emotion/history       Emotion timeline for session

GET    /api/reflection            Last reflection result
POST   /api/reflection/trigger    Trigger reflection manually

GET    /api/settings              Get settings
PUT    /api/settings              Update settings
```

## Tech Stack Options

**[TODO: choose one stack]**

| Stack | Frontend | Backend | Pros | Cons |
|-------|----------|---------|------|------|
| **Full-stack Rust** | Yew/Leptos + WASM | Actix/Axum embedded in agent | Single binary, no JS | Smaller ecosystem, steeper WASM |
| **Rust backend + React** | React/Vite + TS | Axum/Actix in agent | Mature frontend ecosystem | Two languages, build complexity |
| **Rust backend + HTMX** | HTML + HTMX + Alpine.js | Axum in agent | Minimal JS, server-rendered | Less interactive, no rich charts |
| **Go + Svelte** | SvelteKit | Go HTTP in agent | Fast builds, small bundles | Three languages if agent is Rust |
| **Tauri-style** | React/Svelte | Embedded webview | Desktop-app feel | Complex build, platform-specific |

## Chart Library

For emotion timeline and memory decay visualization:
- **[TODO: chart library choice]** — D3.js (flexible but verbose), Chart.js (simple but limited), Observable Plot (modern, concise), or canvas-based custom rendering?

## Placeholders to Fill

- **[TODO: tech stack choice]** — which frontend + backend stack? See comparison table above.
- **[TODO: WebSocket library for Rust]** — tokio-tungstenite? axum's built-in WS? Something else?
- **[TODO: authentication]** — should the WebUI require authentication? If yes, what method? API key? Password? OAuth? Or localhost-only?
- **[TODO: CORS policy]** — if the WebUI is served separately from the API, what's the CORS configuration? Or is it all served from the same origin?
- **[TODO: port and binding]** — default port? `localhost:9786`? `0.0.0.0` or `127.0.0.1`? Configurable?
- **[TODO: session transcript format]** — JSON, JSONL, Markdown, or plain text? This affects the export feature and interoperability with aizo's `analyze`.
- **[TODO: streaming vs polling for emotion updates]** — WebSocket for all real-time updates, or HTTP polling for non-critical state?
- **[TODO: mobile layout breakpoints]** — at what screen width does the sidebar collapse? How should the chat view adapt to mobile?
- **[TODO: chart library]** — for emotion timeline and memory decay visualization. D3, Chart.js, Observable Plot, or custom?
- **[TODO: settings schema]** — complete list of configurable settings beyond what's listed above.
- **[TODO: theme system]** — CSS variables? How many themes? Should users be able to create custom themes?
