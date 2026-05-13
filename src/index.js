#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');

const { ToolRegistry } = require('./tools');
const { Runtime } = require('./runtime');

// ── Built-in tools ───────────────────────────────────────────────────────────

function buildToolRegistry() {
  const registry = new ToolRegistry();
  const builtinsDir = path.join(__dirname, 'tools', 'builtins');
  for (const file of fs.readdirSync(builtinsDir).filter(f => f.endsWith('.js'))) {
    registry.register(require(path.join(builtinsDir, file)));
  }
  return registry;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(memoryPath) {
  const aizo = require('./aizo_bridge');
  const content = fs.readFileSync(memoryPath, 'utf8');
  const blocks = [];
  const blockRe = /```memory-seed\n([\s\S]*?)```/g;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    for (const chunk of m[1].split(/^---$/m)) {
      const entry = {};
      for (const line of chunk.trim().split('\n')) {
        const [key, ...rest] = line.split(':');
        if (key && rest.length) {
          entry[key.trim()] = rest.join(':').trim();
        }
      }
      if (entry.category && entry.item) {
        entry.keywords = entry.keywords ? entry.keywords.split(',').map(s => s.trim()) : [];
        entry.score    = parseFloat(entry.score) || 5;
        blocks.push(entry);
      }
    }
  }
  if (blocks.length === 0) {
    console.log('No memory-seed blocks found in MEMORY.md');
    return;
  }
  for (const e of blocks) {
    await aizo.add(e.category, e.item, e.reason || '', e.score, e.keywords);
    console.log(`  + [${e.category} ${e.score}] ${e.item}`);
  }
  console.log(`\nBootstrapped ${blocks.length} memory entries.`);
}

// ── Replay mode ───────────────────────────────────────────────────────────────

function replay(eventsPath) {
  const { EmotionState, EmotionTrajectory } = require('./runtime/emotion');
  const content = fs.readFileSync(eventsPath, 'utf8');
  const lines   = content.trim().split('\n').filter(Boolean);

  const state = new EmotionState();
  const traj  = new EmotionTrajectory();

  const header = ['Step', 'Event', 'Energy', 'Focus', 'Frust.', 'Novelty', 'Conf.'];
  const fmt = (v) => String(v).padEnd(12);
  console.log(header.map(fmt).join(''));
  console.log('-'.repeat(header.length * 12));
  console.log(['0', '(initial)', state.energy, state.focus, state.frustration, state.novelty, state.confidence]
    .map((v, i) => i > 1 ? v.toFixed(3) : String(v)).map(fmt).join(''));

  lines.forEach((line, i) => {
    let raw;
    try { raw = JSON.parse(line); } catch { return; }
    state.processEvent(raw);
    traj.push(state.snapshot());
    const row = [
      i + 1, raw.type || raw.event || '?',
      state.energy, state.focus, state.frustration, state.novelty, state.confidence,
    ];
    console.log(row.map((v, j) => j > 1 ? v.toFixed(3) : String(v)).map(fmt).join(''));
  });

  console.log(`\nFinal — flow state: ${traj.isFlowState()}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--bootstrap') {
    const memPath = args[1] || path.join(process.cwd(), 'MEMORY.md');
    await bootstrap(memPath);
    return;
  }

  if (args[0] === '--replay') {
    const evPath = args[1];
    if (!evPath) { console.error('Usage: --replay <events.jsonl>'); process.exit(1); }
    replay(evPath);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set.');
    process.exit(1);
  }

  const registry = buildToolRegistry();
  const runtime  = new Runtime(registry);

  console.log('connor-agent initializing...');
  await runtime.initialize();
  console.log('Ready. Type your message, /status, /task <desc>, /done, /reset, or /quit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input === '/quit' || input === '/exit') {
      console.log('Goodbye.');
      rl.close();
      process.exit(0);
    }

    if (input === '/status') {
      console.log('\n' + runtime.emotionSummary() + '\n');
      rl.prompt();
      return;
    }

    if (input.startsWith('/task ')) {
      const desc = input.slice(6).trim();
      const id = runtime.memory.taskStack.push(desc);
      runtime.memory.activeContext = desc;
      console.log(`Task #${id} started: ${desc}`);
      rl.prompt();
      return;
    }

    if (input === '/done') {
      const task = runtime.memory.taskStack.active();
      if (!task) { console.log('No active task.'); }
      else {
        runtime.memory.taskStack.complete(task.id);
        runtime.emotion.processEvent({ type: 'TaskCompleted' });
        console.log(`Task #${task.id} completed.`);
      }
      rl.prompt();
      return;
    }

    if (input === '/reset') {
      runtime.conversationHistory = [];
      console.log('Conversation history cleared.');
      rl.prompt();
      return;
    }

    // Normal message
    try {
      process.stdout.write('connor> ');
      const response = await runtime.runTurn(input);
      console.log(response + '\n');
    } catch (err) {
      console.error(`\nError: ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nSession ended.');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
