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
}
```

### 1.5 Integration test

Write a test that:
1. Calls `aizo add` to insert a test entry
2. Calls `aizo recall` to retrieve it
3. Calls `aizo touch` to reset its decay clock
4. Calls `aizo remove` to clean up (or use a temporary DB file)

## Placeholders to Fill

- **[TODO: aizo binary name and expected path]** — is the binary called `aizo`? Where will it be installed in production?
- **[TODO: database strategy]** — one global DB at `~/.aizo/preferences.db`, or per-project DBs? If per-project, what's the naming convention?
- **[TODO: aizo analyze — temp file or stdin?]** — `aizo analyze` takes either a file path or stdin. Which approach should the bridge use for passing session text?
- **[TODO: error on missing aizo]** — should the agent refuse to start if aizo is not found, or run with degraded memory capabilities?
