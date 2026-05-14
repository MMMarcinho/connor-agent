import type { Tool, ToolResult, ToolPolicy } from '../types';

const COMPLEX_TOOLS = new Set(['shell']);
const MAX_OUTPUT    = 8000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  isComplex(name: string): boolean {
    return COMPLEX_TOOLS.has(name);
  }

  schemaForPrompt(policy: ToolPolicy = {}): object[] {
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
              description: p.desc ?? '',
              ...(p.enum ? { enum: p.enum } : {}),
            }])
          ),
          required: t.params.filter(p => p.required !== false).map(p => p.name),
        },
      }));
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { exitCode: 1, stdout: '', stderr: `Unknown tool: ${name}` };

    try {
      const result = await tool.handler(params);
      if (result.stdout.length > MAX_OUTPUT) {
        result.stdout = result.stdout.slice(0, MAX_OUTPUT) + `\n[... truncated at ${MAX_OUTPUT} chars]`;
      }
      return result;
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: (err as Error).message };
    }
  }
}
