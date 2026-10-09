import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
const hostDir = path.join(repoRoot, 'editorcore', 'cmd', 'editorcore-host');

// EditorCoreHost is the one text buffer for a test or a page bridge. Each
// call reads the UTF-8 the Go core returns.
export class EditorCoreHost {
  constructor(child) {
    this.child = child;
    this.pending = [];
    this.lines = createInterface({input: child.stdout});
    this.lines.on('line', (line) => {
      const wait = this.pending.shift();
      if (!wait) return;
      try { wait.resolve(JSON.parse(line)); }
      catch (error) { wait.reject(error); }
    });
    child.on('exit', (code) => {
      const error = new Error(`editorcore-host exited ${code}`);
      for (const wait of this.pending.splice(0)) wait.reject(error);
    });
  }

  static async start() {
    const child = spawn('go', ['run', '.'], {cwd: hostDir, stdio: ['pipe', 'pipe', 'pipe']});
    const host = new EditorCoreHost(child);
    return host;
  }

  call(payload) {
    return new Promise((resolve, reject) => {
      this.pending.push({resolve, reject});
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async close() {
    try { await this.call({op: 'shutdown'}); } catch {}
    this.child.stdin.end();
    this.lines.close();
  }
}
