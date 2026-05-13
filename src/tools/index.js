'use strict';

const COMPLEX_TOOLS = new Set(['shell']);
const MAX_OUTPUT = 8000; // characters before truncation

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    this.tools.set(tool.name, tool);
  }

  get(name) { return this.tools.get(name) || null; }

  isComplex(name) { return COMPLEX_TOOLS.has(name); }

  // Returns array of tool definitions in Anthropic API format
  schemaForPrompt(policy = {}) {
    return [...this.tools.values()]
      .filter(t => !policy.avoidComplex || !COMPLEX_TOOLS.has(t.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties: Object.fromEntries(
            t.params.map(p => [p.name, {
              type: p.type,
              description: p.desc || '',
              ...(p.enum ? { enum: p.enum } : {}),
            }])
          ),
          required: t.params.filter(p => p.required !== false).map(p => p.name),
        },
      }));
  }

  async execute(name, params) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { exitCode: 1, stdout: '', stderr: `Unknown tool: ${name}` };
    }
    try {
      const result = await tool.handler(params);
      // Truncate large outputs
      if (result.stdout && result.stdout.length > MAX_OUTPUT) {
        result.stdout = result.stdout.slice(0, MAX_OUTPUT) + `\n[... truncated at ${MAX_OUTPUT} chars]`;
      }
      return result;
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err.message };
    }
  }
}

module.exports = { ToolRegistry };
