import { execFile } from 'child_process';
import type { Tool } from '../../types';

const grep: Tool = {
  name: 'grep',
  description: 'Search for a pattern in files.',
  params: [
    { name: 'pattern',     type: 'string',  desc: 'Search pattern (regex supported)', required: true },
    { name: 'path',        type: 'string',  desc: 'File or directory to search in', required: true },
    { name: 'recursive',   type: 'boolean', desc: 'Search recursively in directories', required: false },
    { name: 'ignore_case', type: 'boolean', desc: 'Case-insensitive matching', required: false },
  ],
  handler({ pattern, path, recursive, ignore_case }) {
    return new Promise((resolve) => {
      const args = ['-n', '--include=*'];
      if (recursive)   args.push('-r');
      if (ignore_case) args.push('-i');
      args.push(pattern as string, path as string);

      execFile('grep', args, { timeout: 10000 }, (err, stdout, stderr) => {
        const exitCode = err ? ((err as NodeJS.ErrnoException).code === 'ENOENT' ? 1 : (err as NodeJS.ErrnoException & { code: number }).code === 1 ? 0 : 1) : 0;
        const output   = stdout || (exitCode === 0 ? '(no matches)' : '');
        resolve({ exitCode, stdout: output, stderr: stderr || '' });
      });
    });
  },
};

export = grep;
