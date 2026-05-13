'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist.',
  params: [
    { name: 'path',    type: 'string', desc: 'Path to write to', required: true },
    { name: 'content', type: 'string', desc: 'Content to write', required: true },
    { name: 'append',  type: 'boolean', desc: 'If true, append instead of overwrite', required: false },
  ],
  handler({ path: filePath, content, append }) {
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (append) {
        fs.appendFileSync(filePath, content, 'utf8');
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      return { exitCode: 0, stdout: `Written to ${filePath}`, stderr: '' };
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err.message };
    }
  },
};
