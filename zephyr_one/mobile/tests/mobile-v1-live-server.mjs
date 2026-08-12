import net from "node:net";
import {
  createSecureTestDataDir,
  removeSecureTestDataDir,
} from "../../../tests/helpers/secure-data-dir.mjs";

export { createSecureTestDataDir, removeSecureTestDataDir };

export async function freeLoopbackPorts(count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("port count must be a positive integer");
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
      });
      reservations.push(server);
    }
    const ports = reservations.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback reservation has no TCP address");
      return address.port;
    });
    if (new Set(ports).size !== ports.length) throw new Error("loopback reservations were not distinct");
    return ports;
  } finally {
    await Promise.all(reservations.map(closeServer));
  }
}

export async function startChildOnLoopback({
  spawnChild,
  healthPath,
  log,
  accept,
  budgetMs = 60_000,
  attempts = 3,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [httpPort, aiPort] = await freeLoopbackPorts(2);
    const child = spawnChild({ httpPort, aiPort, attempt });
    let attemptLog = "";
    const captureAttemptLog = (chunk) => { attemptLog += chunk.toString(); };
    child.stdout?.on("data", captureAttemptLog);
    child.stderr?.on("data", captureAttemptLog);
    const detachAttemptLog = () => {
      child.stdout?.removeListener("data", captureAttemptLog);
      child.stderr?.removeListener("data", captureAttemptLog);
    };
    const childClosed = new Promise((resolve) => child.once("close", resolve));
    try {
      const response = await waitForChildHttp({
        child,
        url: `http://127.0.0.1:${httpPort}${healthPath}`,
        log,
        budgetMs,
        accept,
      });
      detachAttemptLog();
      return { child, httpPort, aiPort, response };
    } catch (error) {
      try {
        await stopChild(child);
      } catch (stopError) {
        detachAttemptLog();
        throw new AggregateError([error, stopError], "server startup failed and its child could not be reaped");
      }
      await waitForClose(childClosed, 1_000);
      detachAttemptLog();
      lastError = error;
      if (attempt === attempts || !isRetryableBindFailure(attemptLog)) throw error;
    }
  }
  throw lastError;
}

export async function waitForChildHttp({ child, url, log, budgetMs = 60_000, accept }) {
  let spawnError = null;
  const onError = (error) => { spawnError = error; };
  child.once("error", onError);
  const deadline = Date.now() + budgetMs;

  try {
    while (Date.now() < deadline) {
      if (spawnError) throw startupError(`spawn error: ${spawnError.message}`, child, log);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw startupError(
          `exited before health check (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
          child,
          log,
        );
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (accept ? accept(response) : response.status > 0) return response;
      } catch (error) {
        if (error?.name !== "AbortError" && error?.name !== "TimeoutError" && error?.cause?.code !== "ECONNREFUSED") {
          // A transient transport error remains retryable, but retain it if the
          // child exits on the next iteration through its captured server log.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw startupError(`did not answer ${url} within ${budgetMs}ms`, child, log);
  } finally {
    child.removeListener("error", onError);
  }
}

export async function stopChild(child, { gracefulMs = 5_000, forceMs = 5_000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return { alreadyStopped: true, escalated: false };
  }

  try { child.kill("SIGTERM"); } catch {}
  if (await waitForExit(child, gracefulMs)) {
    return { alreadyStopped: false, escalated: false };
  }

  try { child.kill("SIGKILL"); } catch {}
  if (await waitForExit(child, forceMs)) {
    return { alreadyStopped: false, escalated: true };
  }
  throw new Error(`child pid=${child.pid} did not exit after SIGTERM and SIGKILL`);
}

function isRetryableBindFailure(attemptLog) {
  return /listen E(?:ADDRINUSE|ACCES)\b/.test(attemptLog);
}

function readLog(log) {
  return String(typeof log === "function" ? log() : log || "");
}

async function waitForClose(closed, timeoutMs) {
  let timer = null;
  await Promise.race([
    closed,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function startupError(reason, child, log) {
  const output = readLog(log).slice(-6_000);
  return new Error(
    `server ${reason}\nplatform=${process.platform} node=${process.version} pid=${child.pid ?? "unknown"}`
      + `\n--- server output ---\n${output || "(no output captured)"}`,
  );
}
