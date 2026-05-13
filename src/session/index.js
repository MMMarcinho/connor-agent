'use strict';

const fs   = require('fs');
const path = require('path');

// ── SessionLogger ─────────────────────────────────────────────────────────────
//
// Writes three files per session under <sessions_dir>/<YYYY-MM-DD>/<id>/:
//   transcript.md   human-readable turn-by-turn log
//   events.jsonl    machine-readable event stream (for --replay)
//   summary.json    metadata snapshot written on session end

class SessionLogger {
  constructor(sessionsDir) {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    const id   = `${date}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;

    this.sessionId  = id;
    this.sessionDir = path.join(sessionsDir, id);
    this.startedAt  = now;
    this.turnCount  = 0;
    this.toolCalls  = 0;
    this.tasks      = [];

    this._transcriptPath = path.join(this.sessionDir, 'transcript.md');
    this._eventsPath     = path.join(this.sessionDir, 'events.jsonl');
    this._summaryPath    = path.join(this.sessionDir, 'summary.json');

    fs.mkdirSync(this.sessionDir, { recursive: true });

    // Write transcript header
    this._appendTranscript(
      `# Session ${id}\n\nStarted: ${now.toISOString()}\n\n---\n\n`
    );
  }

  // ── Turn logging ────────────────────────────────────────────────────────────

  logTurn(userMessage, assistantResponse, emotionSnapshot) {
    this.turnCount++;
    const ts = new Date().toISOString();

    // Transcript entry
    const bar = this._emotionBar(emotionSnapshot);
    const md =
      `## Turn ${this.turnCount} — ${ts}\n\n` +
      `**User:** ${userMessage}\n\n` +
      `**Connor:** ${assistantResponse}\n\n` +
      (bar ? `*Emotion: ${bar}*\n\n` : '') +
      `---\n\n`;
    this._appendTranscript(md);

    // Event
    this._appendEvent({
      type: 'Turn',
      turn: this.turnCount,
      timestamp: ts,
      user: userMessage.slice(0, 200),
      emotion: emotionSnapshot || null,
    });
  }

  // ── Tool event logging ──────────────────────────────────────────────────────

  logToolCall(toolName, exitCode, emotionSnapshot) {
    this.toolCalls++;
    this._appendEvent({
      type: exitCode === 0 ? 'ToolSuccess' : 'ToolFailure',
      timestamp: new Date().toISOString(),
      tool: toolName,
      exitCode,
      emotion: emotionSnapshot || null,
    });
  }

  // ── Task logging ────────────────────────────────────────────────────────────

  logTaskStart(id, description) {
    this.tasks.push({ id, description, startedAt: new Date().toISOString() });
    this._appendEvent({
      type: 'TaskStart',
      timestamp: new Date().toISOString(),
      taskId: id,
      description,
    });
  }

  logTaskComplete(id) {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.completedAt = new Date().toISOString();
    this._appendEvent({
      type: 'TaskComplete',
      timestamp: new Date().toISOString(),
      taskId: id,
    });
  }

  // ── Arbitrary events for --replay ──────────────────────────────────────────

  logEvent(event) {
    this._appendEvent({ timestamp: new Date().toISOString(), ...event });
  }

  // ── Session end ─────────────────────────────────────────────────────────────

  end(finalEmotionSnapshot) {
    const endedAt = new Date();
    const summary = {
      sessionId:    this.sessionId,
      startedAt:    this.startedAt.toISOString(),
      endedAt:      endedAt.toISOString(),
      durationMs:   endedAt - this.startedAt,
      turns:        this.turnCount,
      toolCalls:    this.toolCalls,
      tasks:        this.tasks,
      finalEmotion: finalEmotionSnapshot || null,
    };
    try {
      fs.writeFileSync(this._summaryPath, JSON.stringify(summary, null, 2));
    } catch {}

    // Append footer to transcript
    this._appendTranscript(
      `## Session End — ${endedAt.toISOString()}\n\n` +
      `Turns: ${this.turnCount} | Tool calls: ${this.toolCalls} | ` +
      `Duration: ${Math.round(summary.durationMs / 1000)}s\n`
    );
  }

  get eventsPath() { return this._eventsPath; }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _appendTranscript(text) {
    try { fs.appendFileSync(this._transcriptPath, text); } catch {}
  }

  _appendEvent(obj) {
    try {
      fs.appendFileSync(this._eventsPath, JSON.stringify(obj) + '\n');
    } catch {}
  }

  _emotionBar(snap) {
    if (!snap) return '';
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '?');
    return `E:${fmt(snap.energy)} Fo:${fmt(snap.focus)} Fr:${fmt(snap.frustration)} N:${fmt(snap.novelty)} Co:${fmt(snap.confidence)}`;
  }
}

module.exports = { SessionLogger };
