import { execFile } from 'child_process';
import type { Tool } from '../../types';

const BLOCKED: RegExp[] = [
  /\brm\s+-rf?\b/, /\bdrop\s+(table|database)\b/i, /\bformat\b.*\bdisk\b/i,
  /\bshutdown\b/, /\breboot\b/, /\bmkfs\b/, /\bdd\s+if=/,
  />\s*\/dev\/(sd|hd|nvme)/, /\bchmod\s+777\b/, /:\(\)\{:\|:&\};:/,
];

function isBlocked(cmd: string): boolean {
  return BLOCKED.some(re => re.test(cmd));
}

const shell: Tool = {
  name: 'shell',
  description: 'Execute a shell command. Destructive commands (rm -rf, format, shutdown, etc.) are blocked.',
  params: [
    { name: 'command', type: 'string', desc: 'Shell command to run', required: true },
    { name: 'timeout', type: 'number', desc: 'Timeout in ms (default 30000)', required: false },
  ],
  handler({ command, timeout = 30000 }) {
    return new Promise((resolve) => {
      if (isBlocked(command as string)) {
        return resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'Blocked: this command matches a safety rule and will not be executed.',
        });
      }

      execFile('bash', ['-c', command as string], { timeout: Number(timeout) }, (err, stdout, stderr) => {
        if (err?.killed) {
          return resolve({ exitCode: 124, stdout, stderr: `Command timed out after ${timeout}ms` });
        }
        resolve({
          exitCode: err ? ((err as NodeJS.ErrnoException).code as unknown as number || 1) : 0,
          stdout:   stdout  || '',
          stderr:   stderr || '',
        });
      });
    });
  },
};

export = shell;
