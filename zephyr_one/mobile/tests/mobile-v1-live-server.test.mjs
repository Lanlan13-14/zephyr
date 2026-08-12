import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  freeLoopbackPorts,
  startChildOnLoopback,
  stopChild,
  waitForChildHttp,
} from "./mobile-v1-live-server.mjs";

test("loopback allocation returns distinct HTTP and AI ports", async () => {
  const ports = await freeLoopbackPorts(2);
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0], ports[1]);
  for (const port of ports) assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
});

test("live-server wait fails immediately with child exit diagnostics", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "console.error('linux-startup-canary'); process.exit(7)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const startedAt = Date.now();
  await assert.rejects(
    waitForChildHttp({
      child,
      url: `http://127.0.0.1:${(await freeLoopbackPorts(1))[0]}/healthz`,
      log: () => output,
      budgetMs: 60_000,
    }),
    (error) => {
      assert.match(error.message, /code=7/);
      assert.match(error.message, /linux-startup-canary/);
      assert.match(error.message, /platform=.*node=v/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000, "a dead child must not consume the health timeout");
});

test("stop waits for child exit and escalates when SIGTERM is ignored", async () => {
  const ignoresTerm = process.platform === "win32"
    ? "setInterval(() => {}, 1000); console.log('ready')"
    : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')";
  const child = spawn(process.execPath, ["-e", ignoresTerm], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });

  const result = await stopChild(child, { gracefulMs: 100, forceMs: 2_000 });
  assert.ok(child.exitCode !== null || child.signalCode !== null, "stop must reap the child before resolving");
  if (process.platform !== "win32") assert.equal(result.escalated, true);
});

test("start retries a bind failure with a new distinct port pair", async () => {
  let spawnCount = 0;
  let output = "";
  const started = await startChildOnLoopback({
    healthPath: "/healthz",
    budgetMs: 5_000,
    log: () => output,
    spawnChild: ({ httpPort, aiPort }) => {
      spawnCount += 1;
      const script = spawnCount === 1
        ? "console.error('listen EADDRINUSE 127.0.0.1'); process.exit(1)"
        : `require('node:http').createServer((q,r)=>{r.end('ok')}).listen(${httpPort},'127.0.0.1');`;
      assert.notEqual(httpPort, aiPort);
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      return child;
    },
  });
  assert.equal(spawnCount, 2);
  await stopChild(started.child, { gracefulMs: 100, forceMs: 2_000 });
});

test("an earlier bind error cannot turn a later non-bind failure into another retry", async () => {
  let spawnCount = 0;
  let output = "";
  await assert.rejects(
    startChildOnLoopback({
      healthPath: "/healthz",
      budgetMs: 5_000,
      log: () => output,
      spawnChild: () => {
        spawnCount += 1;
        const message = spawnCount === 1
          ? "listen EADDRINUSE 127.0.0.1"
          : "configuration invalid for this server";
        const child = spawn(
          process.execPath,
          ["-e", `console.error(${JSON.stringify(message)}); process.exit(1)`],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.on("data", (chunk) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk) => { output += chunk.toString(); });
        return child;
      },
    }),
    /configuration invalid/,
  );
  assert.equal(spawnCount, 2, "the second attempt's non-bind failure must stop retries");
});
