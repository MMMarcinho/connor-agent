'use strict';

const fs = require('fs');
const MAX_CHARS = 20000;

module.exports = {
  name: 'read_file',
  description: 'Read the contents of a file from disk.',
  params: [
    { name: 'path', type: 'string', desc: 'Absolute or relative path to the file', required: true },
    { name: 'offset', type: 'number', desc: 'Line number to start reading from (1-based)', required: false },
    { name: 'limit', type: 'number', desc: 'Maximum number of lines to read', required: false },
  ],
  handler({ path, offset, limit }) {
    try {
      let content = fs.readFileSync(path, 'utf8');
      if (offset || limit) {
        const lines = content.split('\n');
        const start = offset ? Math.max(0, Number(offset) - 1) : 0;
        const end   = limit ? start + Number(limit) : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS) + `\n[... truncated at ${MAX_CHARS} chars]`;
      }
      return { exitCode: 0, stdout: content, stderr: '' };
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err.message };
    }
  },
};
