'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const hostDir = path.join(__dirname, 'editorcore', 'cmd', 'editorcore-host');

// One process owns every desktop document. Requests are serialized on its
// stdin so responses stay in order. The buffer is the Go document, not a
// string kept here.
function createEditorCoreBridge() {
  let child = null;
  let queue = Promise.resolve();
  const pending = [];

  function ensure() {
    if (child && !child.killed) return child;
    const hostBinary = process.env.ZEPHYR_EDITORCORE_HOST || path.join(hostDir, 'editorcore-host');
    child = spawn(hostBinary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const wait = pending.shift();
      if (!wait) return;
      try { wait.resolve(JSON.parse(line)); }
      catch (error) { wait.reject(error); }
    });
    child.on('exit', () => {
      const error = new Error('editorcore-host exited');
      while (pending.length) pending.shift().reject(error);
      child = null;
    });
    return child;
  }

  function call(payload) {
    const run = queue.then(() => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      ensure().stdin.write(`${JSON.stringify(payload)}\n`);
    }));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function close() {
    if (!child) return;
    try { child.stdin.write('{"op":"shutdown"}\n'); } catch {}
    child.stdin.end();
  }

  return { call, close };
}

function mountEditorCore(app, requireUser) {
  const bridge = createEditorCoreBridge();
  app.post('/api/editorcore', requireUser, async (req, res) => {
    try {
      const response = await bridge.call(req.body || {});
      res.json(response);
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message || 'editorcore unavailable' });
    }
  });
  return bridge;
}

module.exports = { createEditorCoreBridge, mountEditorCore };
