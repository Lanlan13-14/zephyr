// Regression tests for workspace reads and writes across multiple clients.
//
// The workspaces table is keyed (user_id, client_id, workspace_id), so one
// workspaceId legitimately has one row per client -- that is how a desktop and a
// phone keep separate tab sets under the same id.
//
// Two methods ignored client_id and filtered on user_id alone:
//
//   get()/restore() -- with two rows present SQLite was free to return either,
//   so the read was non-deterministic and could hand one device the other
//   device's workspace state. Measured against the pre-fix code: get() returned
//   the desktop row while the newest row was mobile.
//
//   put() -- worse, because it writes. The expectedRevision guard and the next
//   revision were both computed from whichever row came back first, so a desktop
//   client at revision 1 sending expectedRevision 1 could be compared against a
//   mobile row at revision 7 and handed a 409 it had no way to resolve.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const state = { dirs: [] };

/**
 * A service over its own empty database.
 *
 * Each write test needs a clean table: the revision assertions are about what a
 * single client row does, and a row left behind by an earlier test would change
 * the starting revision and make a pass meaningless.
 */
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zephyr-ws-scope-"));
  state.dirs.push(dir);
  process.env.ZEPHYR_DATA_DIR = dir;
  process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = "1";

  const storage = state.req(path.join(root, "storage.js"));
  storage.init({ hashPassword: (pw) => "h:" + pw });
  const db = storage.rawDb();
  db.prepare("DELETE FROM workspaces").run();
  return { svc: new state.WorkspaceService(db, { resources: null }), db, storage };
}

test("load the service under test", async () => {
  state.req = (await import("node:module")).createRequire(import.meta.url);
  ({ WorkspaceService: state.WorkspaceService } = state.req(path.join(root, "workspace-service.js")));
  assert.equal(typeof state.WorkspaceService, "function");
});

test("a client-scoped read returns that client's row, never another device's", () => {
  const { svc, db } = fresh();
  const insert = db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("ws-1", "u1", "desktop", "Desktop copy", JSON.stringify({ tabs: [{ connectionId: "c-desk" }] }), 1, 1000);
  insert.run("ws-1", "u1", "mobile", "Mobile copy", JSON.stringify({ tabs: [{ connectionId: "c-mob" }] }), 2, 2000);

  const desktop = svc.get("u1", "ws-1", { clientId: "desktop" });
  assert.equal(desktop.clientId, "desktop");
  assert.equal(desktop.name, "Desktop copy");
  assert.equal(desktop.state.tabs[0].connectionId, "c-desk");

  const mobile = svc.get("u1", "ws-1", { clientId: "mobile" });
  assert.equal(mobile.clientId, "mobile");
  assert.equal(mobile.name, "Mobile copy");
  assert.equal(mobile.state.tabs[0].connectionId, "c-mob");
});

test("an unscoped read is deterministic and picks the newest row", () => {
  /* Deterministic matters more than which row wins: a read that varies between
   * calls makes "restore my workspace" a coin flip. Newest-wins is the only
   * defensible choice for a caller that did not name a client. */
  const { svc, db } = fresh();
  const insert = db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("ws-1", "u1", "desktop", "Desktop copy", JSON.stringify({ tabs: [] }), 1, 1000);
  insert.run("ws-1", "u1", "mobile", "Mobile copy", JSON.stringify({ tabs: [] }), 2, 2000);

  const seen = new Set();
  for (let i = 0; i < 25; i += 1) seen.add(svc.get("u1", "ws-1").clientId);
  assert.equal(seen.size, 1, "an unscoped read must not vary between calls, saw: " + [...seen].join(","));
  assert.equal([...seen][0], "mobile", "the newest row must win an unscoped read");
});

test("a scope that does not exist is a 404, not a fallback to another client", () => {
  /* Falling back would be worse than failing: the caller asked for this
   * device's workspace and would silently receive another device's tabs. */
  const { svc, db } = fresh();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("ws-1", "u1", "desktop", "Desktop copy", JSON.stringify({ tabs: [] }), 1, 1000);

  assert.throws(
    () => svc.get("u1", "ws-1", { clientId: "tablet" }),
    (err) => err.code === "workspace_not_found",
    "a missing client scope must not resolve to a different client's row",
  );
});

test("list stays client-scoped", () => {
  const { svc, db } = fresh();
  const insert = db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("ws-1", "u1", "desktop", "Desktop copy", JSON.stringify({ tabs: [] }), 1, 1000);
  insert.run("ws-1", "u1", "mobile", "Mobile copy", JSON.stringify({ tabs: [] }), 2, 2000);

  assert.equal(svc.list("u1").length, 2, "both client rows must be listed when no client is named");
  const mobileOnly = svc.list("u1", { clientId: "mobile" });
  assert.equal(mobileOnly.length, 1);
  assert.equal(mobileOnly[0].clientId, "mobile");
});

test("put compares expectedRevision against this client row, not another device", () => {
  const { svc, db } = fresh();
  const insert = db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Same workspaceId on two devices, deliberately at different revisions. Both
  // rows are legitimate: the primary key is (user_id, client_id, workspace_id).
  insert.run("ws-1", "u1", "desktop", "Desktop", JSON.stringify({ tabs: [] }), 1, 1000);
  insert.run("ws-1", "u1", "mobile", "Mobile", JSON.stringify({ tabs: [] }), 7, 2000);

  /* The desktop row is at revision 1, so a desktop write declaring
   * expectedRevision 1 must be accepted. Before the fix the guard compared
   * against the mobile row at revision 7 and rejected an honest client. */
  const saved = svc.put({ userId: "u1" }, {
    workspaceId: "ws-1",
    clientId: "desktop",
    name: "Desktop v2",
    state: { tabs: [] },
    expectedRevision: 1,
  });
  assert.equal(saved.revision, 2, "the desktop row must advance from its own revision");

  // The other device's row is untouched, including its revision.
  const mobile = svc.get("u1", "ws-1", { clientId: "mobile" });
  assert.equal(mobile.revision, 7, "another client row must not be renumbered");
  assert.equal(mobile.name, "Mobile");
});

test("a genuinely stale expectedRevision is still refused", () => {
  const { svc, db } = fresh();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, user_id, client_id, name, state_json, revision, updated_at)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("ws-1", "u1", "desktop", "Desktop", JSON.stringify({ tabs: [] }), 5, 1000);

  // Scoping the read must not weaken the conflict check itself.
  assert.throws(
    () => svc.put({ userId: "u1" }, {
      workspaceId: "ws-1",
      clientId: "desktop",
      name: "stale write",
      state: { tabs: [] },
      expectedRevision: 2,
    }),
    (err) => err.code === "workspace_revision_conflict",
    "a stale revision must still conflict",
  );
});

test("two devices can hold the same workspaceId without colliding", () => {
  const { svc } = fresh();
  const a = svc.put({ userId: "u1" }, {
    workspaceId: "ws-shared",
    clientId: "desktop",
    name: "Desktop",
    state: { tabs: [{ connectionId: "c-desk" }] },
  });
  const b = svc.put({ userId: "u1" }, {
    workspaceId: "ws-shared",
    clientId: "mobile",
    name: "Mobile",
    state: { tabs: [{ connectionId: "c-mob" }] },
  });
  // Each device starts its own revision sequence at 1.
  assert.equal(a.revision, 1);
  assert.equal(b.revision, 1, "a second device must not inherit the first row revision");

  assert.equal(svc.get("u1", "ws-shared", { clientId: "desktop" }).name, "Desktop");
  assert.equal(svc.get("u1", "ws-shared", { clientId: "mobile" }).name, "Mobile");
});

test("stop", () => {
  // The SQLite handle can outlive close() on Windows; a leftover temp dir is not
  // worth failing the suite over.
  for (const dir of state.dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
