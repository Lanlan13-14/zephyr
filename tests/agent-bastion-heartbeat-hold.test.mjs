import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAgentManager } = require('../file-agent-manager.js');

// The heartbeat constants are fixed inside the module, so the test drives the
// registered connection's timer indirectly: it rewinds lastSeenAt past the
// 45s window and waits one real 15s tick. That is slow on purpose. A fake
// timer would not run the timer the module actually scheduled.
const HEARTBEAT_WINDOW_MS = 15000 * 3;

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    // Record the close without emitting it. Emitting would run the manager's
    // own close handler and unregister the agent for a second reason, which
    // hides whether the heartbeat timer itself made the decision.
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }
}

function tempTokenFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-agent-heartbeat-'));
  return path.join(directory, 'agent-tokens.json');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(manager, token) {
  const socket = new FakeWebSocket();
  manager.handleConnection(socket);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'hello',
    protocolVersion: 2,
    token,
    deviceId: 'bastion-box',
    deviceName: 'bastion-box',
    capabilities: { read: true, bastion: true },
    share: { name: 'bastion-box', readOnly: true },
  })));
  await wait(0);
  const ack = socket.sent.map((value) => JSON.parse(String(value))).find((value) => value.type === 'hello_ack');
  assert.equal(ack?.ok, true);
  return { socket, agentId: ack.agentId };
}

test('an agent relaying a bastion tunnel survives a silent heartbeat socket', async () => {
  const manager = new FileAgentManager({ tokenFile: tempTokenFile(), log() {} });
  const record = manager.createToken({ userId: 'user-1', username: 'owner' }, 'bastion box');
  const { agentId } = await connect(manager, record.token);
  const conn = manager.agents.get(agentId);

  assert.equal(manager.notifyBastionActivity(agentId, { event: 'open', target: '10.0.0.5:3389' }), true);
  assert.equal(manager.hasActiveBastion(agentId), true);

  // The heartbeat socket has been silent well past the timeout. Without the
  // exemption the next tick unregisters the agent and the RDP dies with it.
  conn.lastSeenAt = Date.now() - (HEARTBEAT_WINDOW_MS + 5000);
  await wait(16000);
  assert.equal(manager.agents.has(agentId), true, 'agent was dropped while a bastion tunnel was open');

  // Traffic on the relay refreshes liveness on its own.
  conn.lastSeenAt = Date.now() - (HEARTBEAT_WINDOW_MS + 5000);
  assert.equal(manager.notifyBastionActivity(agentId, { event: 'data', bytes: 4096 }), true);
  assert.ok(Date.now() - conn.lastSeenAt < 5000, 'relay traffic did not refresh lastSeenAt');

  // Once the relay ends, silence means what it used to: the agent is gone.
  assert.equal(manager.notifyBastionActivity(agentId, { event: 'close' }), true);
  assert.equal(manager.hasActiveBastion(agentId), false);
  conn.lastSeenAt = Date.now() - (HEARTBEAT_WINDOW_MS + 5000);
  await wait(16000);
  assert.equal(manager.agents.has(agentId), false, 'agent survived a silent heartbeat with no relay open');
});
