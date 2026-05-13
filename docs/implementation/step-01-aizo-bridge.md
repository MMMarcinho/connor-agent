# Step 1: aizo Bridge

## Objective

Establish communication between connor-agent and the aizo long-term memory engine.
aizo is an independent Rust binary that connor-agent calls as a subprocess. This
step creates a thin wrapper that makes aizo operations feel like native function calls.

## Prerequisites

- aizo binary installed at `[TODO: path to aizo binary, e.g. /usr/local/bin/aizo]`
- `ANTHROPIC_API_KEY` or `AIZO_API_KEY` configured (needed only for `aizo analyze`)
- aizo database initialized: `aizo info`

## Implementation

### 1.1 Create the aizo_bridge module

File: `src/aizo_bridge/mod.rs`

The module wraps five aizo CLI commands as functions. Each function constructs
a shell command, executes it via subprocess, and parses the JSON output.

```rust
// src/aizo_bridge/mod.rs

use std::process::Command;
use serde::{Deserialize, Serialize};

/// Path to the aizo binary.
/// [TODO: confirm the binary name — is it "aizo" or something else?]
const AIZO_BIN: &str = "aizo";

/// Optional: per-project database path.
/// [TODO: decide — use default ~/.aizo/preferences.db or a project-specific one?]
/// Set via env var AIZO_DB_PATH or passed as --db flag.
const AIZO_DB_PATH: Option<&str> = None;
// const AIZO_DB_PATH: Option<&str> = Some("./connor-memory.db");

fn aizo_cmd() -> Command {
    let mut cmd = Command::new(AIZO_BIN);
    cmd.arg("--json"); // always request JSON output
    if let Some(db) = AIZO_DB_PATH {
        cmd.arg("--db").arg(db);
    }
    cmd
}
```

### 1.2 Core operations

Five functions, each mapping to one aizo CLI command:

```rust
/// Recall preferences matching a keyword, sorted by effective weight.
/// Maps to: aizo recall <query> [--type category] [--json]
pub fn recall(query: &str, category: Option<&str>) -> Result<Vec<MemoryEntry>> {
    let mut cmd = aizo_cmd();
    cmd.arg("recall").arg(query).arg("--json");
    if let Some(cat) = category {
        cmd.arg("--type").arg(cat);
    }
    // aizo recall with --json returns an array of entries
    let output = cmd.output()?;
    // ... parse JSON
}

/// Add or update a preference entry.
/// Maps to: aizo add <item> <reason> [--score N] [--type cat] [--keywords ...]
pub fn add(
    category: &str,
    item: &str,
    reason: &str,
    score: f64,
    keywords: &[String],
) -> Result<()> {
    // ...
}

/// Refresh the decay clock without changing score.
/// Maps to: aizo touch <category> <item>
pub fn touch(category: &str, item: &str) -> Result<bool> {
    // ...
}

/// Get top-N entries by effective weight.
/// Maps to: aizo top <N> [--type category] [--json]
pub fn top(n: usize, category: Option<&str>) -> Result<Vec<MemoryEntry>> {
    // ...
}

/// Analyze session text with the flash LLM and update preferences.
/// Maps to: aizo analyze [file]   OR   echo <text> | aizo analyze
pub fn analyze(session_text: &str) -> Result<Vec<AnalyzedEntry>> {
    // ...
}
```

### 1.3 Data types

```rust
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MemoryEntry {
    pub id: i64,
    pub category: String,       // preference | aversion | habit | style | taboo
    pub item: String,
    pub reason: String,
    pub keywords: Vec<String>,
    pub base_score: f64,        // 0.0–10.0
    pub source: String,         // "analysis" | "manual"
    pub added_at: String,
    pub last_seen: String,
    pub score_exponent: f64,    // α, computed by aizo
    pub decay_coefficient: f64, // d(t), computed by aizo
    pub effective_weight: f64,  // w = s · d(t)^α, computed by aizo
}

#[derive(Debug, Deserialize)]
pub struct AnalyzedEntry {
    pub category: String,
    pub item: String,
    pub reason: String,
    pub keywords: Vec<String>,
    pub base_score: f64,
}
```

### 1.4 Error handling

All functions return `Result<T, AizoBridgeError>`. Wrap subprocess errors
(exit code ≠ 0, JSON parse failures, aizo not found) into a unified error type:

```rust
#[derive(Debug)]
pub enum AizoBridgeError {
    AizoNotFound(String),
    BadExit { code: i32, stderr: String },
    JsonParse(String),
    EmptyResult,
    Timeout,
}
```

### 1.4a Degraded Behavior Policy

Every aizo call in the main loop must have a defined fallback so that a memory
failure never crashes the agent or blocks a turn. The policy:

| Call site | On failure | Side-effect |
|-----------|-----------|-------------|
| `recall` in step 4 | Return empty `Vec` | Fire `DetectedEvent::AizoRecallEmpty` (raises Novelty — appropriate: "I don't remember anything right now") |
| `add` after tool success/failure | Log to stderr, silently drop | No emotion change — memory recording is best-effort |
| `touch` during Reflection | Log to stderr, silently drop | No impact on current session |
| `top` during session init | Return empty `Vec` | Agent starts with no pre-loaded memory; first recall will fire `AizoRecallEmpty` |
| `analyze` in Reflection Agent | Log error, return `EmptyResult` | Reflection completes with zero new memories; triggers `ReflectionCompleted` anyway (for energy recovery) |
| aizo binary not found at startup | Print warning to stderr, set `AIZO_DEGRADED=true` | Agent runs with no long-term memory; all `recall` calls return empty |

**Subprocess timeout**: all aizo calls must be wrapped in a timeout to prevent
the main loop from blocking indefinitely.

```rust
use std::time::Duration;

const AIZO_RECALL_TIMEOUT: Duration = Duration::from_millis(2000);
const AIZO_ADD_TIMEOUT: Duration    = Duration::from_millis(1000);
const AIZO_ANALYZE_TIMEOUT: Duration = Duration::from_secs(30); // LLM call inside

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, AizoBridgeError> {
    // Spawn, wait with timeout, kill if exceeded
    let mut child = cmd.spawn().map_err(|e| AizoBridgeError::AizoNotFound(e.to_string()))?;
    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            // collect output
            todo!()
        }
        Ok(None) => {
            child.kill().ok();
            Err(AizoBridgeError::Timeout)
        }
        Err(e) => Err(AizoBridgeError::BadExit { code: -1, stderr: e.to_string() }),
    }
}
```

The `AizoBridgeError::Timeout` case is treated identically to `EmptyResult` by
all callers: degrade gracefully, never panic.

### 1.5 MEMORY.md Bootstrap

MEMORY.md is the sole configuration file — a human-readable snapshot of `aizo show`
output. A fresh aizo database has no SOUL entries, no personality traits, and no
tool knowledge. The bootstrap command reads MEMORY.md and bulk-inserts the seed
entries into aizo.

#### 1.5a Seed block format

MEMORY.md is prose for humans but contains machine-readable seed blocks using a
fenced code block with language tag `memory-seed`. Each block holds one or more
entries separated by `---`:

~~~markdown
```memory-seed
category: preference
item: always run tests before committing
reason: core safety habit, prevents broken commits
score: 10
keywords: tests, commit, safety, git

---

category: taboo
item: never force push to main
reason: destroys shared history, hard constraint
score: 0
keywords: git, push, force, main, destructive
```
~~~

Fields: `category` (preference | aversion | habit | style | taboo), `item`
(≤10 words), `reason` (one sentence), `score` (0.0–10.0), `keywords`
(comma-separated).

#### 1.5b Bootstrap command

```
connor-agent --bootstrap [MEMORY.md path, default: ./MEMORY.md]
```

Implementation:

```rust
pub fn bootstrap_from_memory_md(path: &str) -> Result<usize, BootstrapError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| BootstrapError::FileNotFound(e.to_string()))?;

    let entries = parse_seed_blocks(&content)?;
    let count = entries.len();

    for entry in entries {
        crate::aizo_bridge::add(
            &entry.category,
            &entry.item,
            &entry.reason,
            entry.score,
            &entry.keywords,
        ).map_err(|e| BootstrapError::AizoError(format!("{e:?}")))?;
    }

    println!("Bootstrapped {count} memory entries from {path}");
    Ok(count)
}

fn parse_seed_blocks(content: &str) -> Result<Vec<SeedEntry>, BootstrapError> {
    // Extract all ```memory-seed ... ``` blocks
    // Split each block on "---"
    // Parse each entry with the key: value format
    // Return error if any required field is missing
    todo!()
}

#[derive(Debug)]
pub struct SeedEntry {
    pub category: String,
    pub item: String,
    pub reason: String,
    pub score: f64,
    pub keywords: Vec<String>,
}

#[derive(Debug)]
pub enum BootstrapError {
    FileNotFound(String),
    ParseError { line: usize, message: String },
    AizoError(String),
}
```

Bootstrap is idempotent: re-running it on the same MEMORY.md applies aizo's
score-smoothing merge (`new = old × 0.4 + incoming × 0.6`), so score=10 entries
stay at 10, and nothing is accidentally overwritten.

### 1.6 Integration test

Write a test that:
1. Calls `aizo add` to insert a test entry
2. Calls `aizo recall` to retrieve it
3. Calls `aizo touch` to reset its decay clock
4. Calls `aizo remove` to clean up (or use a temporary DB file)

## Placeholders to Fill

- **[TODO: aizo binary name and expected path]** — is the binary called `aizo`? Where will it be installed in production?
- **[TODO: database strategy]** — one global DB at `~/.aizo/preferences.db`, or per-project DBs? If per-project, what's the naming convention?
- **[TODO: aizo analyze — temp file or stdin?]** — `aizo analyze` takes either a file path or stdin. Which approach should the bridge use for passing session text?
- ~~**[TODO: error on missing aizo]**~~ — **resolved in §1.4a**: agent starts in degraded mode (no memory) with a stderr warning rather than refusing to start.
