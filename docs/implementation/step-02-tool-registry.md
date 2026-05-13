# Step 2: Tool Registry + Tool Memory

## Objective

Build a minimal tool system with two layers:
1. **Tool Registry** — bare function registration (name, schema, handler)
2. **Tool Memory** — auto-growing aizo entries that encode tool knowledge

The Registry stores no usage documentation. All "how to use this tool" knowledge
is in aizo, learned through experience.

## Prerequisites

- Step 1 (aizo bridge) complete

## Implementation

### 2.1 Tool definition

File: `src/tools/mod.rs`

```rust
use std::collections::HashMap;
use std::process::Output;

/// Schema for a single parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSchema {
    pub name: String,
    pub param_type: ParamType,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ParamType {
    String,
    Number,
    Bool,
    Path,
}

/// A tool that the agent can call. No usage docs — that lives in aizo.
#[derive(Clone)]
pub struct Tool {
    pub name: String,
    pub description: String, // one-line, just enough for the LLM to know what it does
    pub params: Vec<ParamSchema>,
    pub handler: fn(HashMap<String, String>) -> Result<ToolOutput, ToolError>,
}

#[derive(Debug)]
pub struct ToolOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum ToolError {
    ExecutionFailed(String),
    InvalidParams(String),
    ToolNotFound,
}
```

### 2.2 Registry

```rust
pub struct ToolRegistry {
    tools: HashMap<String, Tool>,
}

impl ToolRegistry {
    pub fn new(tools: Vec<Tool>) -> Self { /* ... */ }

    pub fn get(&self, name: &str) -> Option<&Tool> { /* ... */ }

    /// Return all tools as a minimal schema block for the LLM system prompt.
    /// Only includes name + params — no usage guidance (that comes from aizo).
    pub fn schema_for_prompt(&self) -> String { /* ... */ }

    /// Execute a tool by name.
    pub fn execute(&self, name: &str, params: HashMap<String, String>)
        -> Result<ToolOutput, ToolError> { /* ... */ }
}
```

### 2.3 Built-in tools

File: `src/tools/builtins/`

Each tool is a standalone file:

```
src/tools/builtins/
├── mod.rs
├── shell.rs       — execute shell commands (sandboxed)
├── read_file.rs   — read file contents
├── write_file.rs  — write/create files
├── edit_file.rs   — search-and-replace in files
├── grep.rs        — search codebase
├── [TODO: add more built-in tools as needed]
```

Example tool registration:

```rust
// src/tools/builtins/read_file.rs
use crate::tools::{Tool, ParamSchema, ParamType, ToolOutput, ToolError};

pub fn tool() -> Tool {
    Tool {
        name: "read_file".into(),
        description: "Read the contents of a file".into(),
        params: vec![
            ParamSchema {
                name: "path".into(),
                param_type: ParamType::Path,
                required: true,
            },
        ],
        handler: |params| {
            let path = params.get("path")
                .ok_or(ToolError::InvalidParams("path is required".into()))?;
            match std::fs::read_to_string(path) {
                Ok(content) => Ok(ToolOutput {
                    exit_code: 0,
                    stdout: content,
                    stderr: String::new(),
                }),
                Err(e) => Ok(ToolOutput {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: e.to_string(),
                }),
            }
        },
    }
}
```

### 2.4 Tool Memory integration

After every tool execution, the Runtime calls:

```rust
// src/tools/memory.rs (or inline in runtime)

/// Record tool execution outcome in aizo.
fn record_tool_outcome(
    tool_name: &str,
    exit_code: i32,
    stdout_preview: &str,  // first ~200 chars
    stderr_preview: &str,  // first ~200 chars
) {
    if exit_code == 0 {
        // Successful use → reinforce or initially learn
        aizo_bridge::add(
            "preference",
            &format!("use {tool_name}"),
            &format!("Successfully used {tool_name}: {stdout_preview}"),
            8.0,     // initial score for a successful tool use
            &[tool_name.to_string()],
        ).ok();
    } else {
        // Failed use → create aversion or lower existing score
        aizo_bridge::add(
            "aversion",
            &format!("{tool_name} failed pattern"),
            &format!("{tool_name} failed: {stderr_preview}"),
            2.0,
            &[tool_name.to_string()],
        ).ok();
    }
}
```

### 2.5 Tool selection

When the LLM needs to choose a tool, the Runtime prepends tool knowledge
from aizo to the system prompt:

```rust
fn tool_context_for_prompt(task_description: &str) -> String {
    // Recall tool-related memories for the current task
    let tool_memories = aizo_bridge::recall(
        &format!("{task_description}"),
        Some("preference")
    ).unwrap_or_default();

    // Also recall aversions (failed patterns to avoid)
    let tool_aversions = aizo_bridge::recall(
        task_description,
        Some("aversion")
    ).unwrap_or_default();

    // Format: "You know these approaches work well: ... Avoid these: ..."
    format_tool_context(&tool_memories, &tool_aversions)
}
```

This is the key difference from OpenClaw/Hermes: the agent doesn't read a
SKILL.md to know what tools to use. It queries its own memory.

## Placeholders to Fill

- **[TODO: complete list of built-in tools]** — beyond shell, read_file, write_file, edit_file, grep, what other built-in tools does connor-agent need?
- **[TODO: sandboxing approach]** — how are shell commands sandboxed? Docker container? chroot? Allowlists? What's the security boundary?
- **[TODO: tool output truncation strategy]** — long tool outputs need to be truncated before being passed to the LLM. What's the character/token limit? How should truncation be indicated?
- **[TODO: initial tool memory seeding]** — on first run, the agent has zero tool memories. Should we seed the aizo DB with a few starter entries for each tool, or let the agent learn from scratch?
- **[TODO: tool categorization for aizo recall]** — when recalling tool knowledge, should tools be tagged with categories (e.g., "filesystem", "network", "git") to improve recall precision?
