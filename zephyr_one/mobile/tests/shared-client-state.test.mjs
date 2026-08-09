/*
 * Static gate for the shared-to-me client state layers (F-036, F-040).
 *
 * The server halves of both rows have been implemented and tested for a while: `GET /shared`,
 * `GET /shared/{type}/{id}` and `POST /shared/note/{id}/invoke` all work, and
 * tests/mobile-v1-shared.test.mjs covers them. What was `missing` is the client: nothing on the
 * device projected a shared list or rendered a shared note body, so the endpoints were unreachable.
 *
 * There is no Android SDK, no Gradle and no kotlinc on a developer machine here, so the JVM tests in
 * feature-connections and feature-notes run only in CI. This file is the half that runs everywhere,
 * and it deliberately targets the residency rules rather than the rendering: every one of them
 * fails SILENTLY. A shared row written to the Room mirror still shows correctly. A note body kept in
 * a SavedStateHandle still displays. A save that drops expectedRevision still saves -- it just
 * overwrites an edit the user never saw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(MOBILE_ROOT, 'android');

const CONNECTIONS_MAIN = path.join(
  ANDROID, 'feature-connections', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'connections',
);
const CONNECTIONS_TEST = path.join(
  ANDROID, 'feature-connections', 'src', 'test', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'connections',
);
const NOTES_MAIN = path.join(
  ANDROID, 'feature-notes', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'notes',
);
const NOTES_TEST = path.join(
  ANDROID, 'feature-notes', 'src', 'test', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'notes',
);
const DATA = path.join(
  ANDROID, 'core-data', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'data', 'repository',
);
/* The seam that joins the client to the store. Its absence is what made both rows unreachable. */
const SYNC_MAIN = path.join(
  ANDROID, 'core-sync', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'sync',
);
const SYNC_TEST = path.join(
  ANDROID, 'core-sync', 'src', 'test', 'kotlin', 'one', 'zephyr', 'mobile', 'sync',
);
/* The wiring lives in :app, and that is the half that was missing before. */
const APP = path.join(
  ANDROID, 'app', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'app',
);

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

/*
 * Strips comments, mirroring android-saf-provider.test.mjs.
 *
 * The negative assertions below are about what the code DOES, and these files explain in prose
 * exactly which shapes they avoid -- "a data class would print every field", "no DAO accepts this".
 * Matching raw source would make those explanations fail the checks they describe, teaching the next
 * reader to delete the reasoning to get green.
 */
const codeOf = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const LIST_STATES = read(CONNECTIONS_MAIN, 'SharedResourceListStates.kt');
const VIEWER = read(NOTES_MAIN, 'SharedNoteViewerStates.kt');
const STORE = read(DATA, 'SharedResourceStore.kt');
const COORDINATOR = read(SYNC_MAIN, 'SharedResourceCoordinator.kt');
const CONTAINER = read(path.join(APP, 'di'), 'AccountContainer.kt');

test('the shared list treats offline as terminal, never as a cache', () => {
  assert.match(LIST_STATES, /object SharedResourceListStates \{/);

  /* The single rule that separates these screens from the owned ones. Owned rows have a Room
   * mirror, so offline shows the cache with its age; shared rows have none, so anything rendered
   * offline could only have come from a copy this device is not allowed to keep
   * (SHARED_RESOURCE_RESIDENCY.md 2-3).
   *
   * Asserted on BOTH layers. Checking only the list is what let a mutation swapping the viewer's
   * OfflineNoCache for OfflineWithCache survive: the viewer was covered for revocation and for the
   * no-store body, but nothing said its offline branch had to be terminal too. */
  for (const [name, source] of [['list', LIST_STATES], ['viewer', VIEWER]]) {
    assert.match(
      source,
      /if \(!online\) return PageState\.OfflineNoCache/,
      name + ': offline must be terminal',
    );
    assert.doesNotMatch(
      codeOf(source),
      /OfflineWithCache/,
      name + ': a shared resource has no cache to fall back on',
    );
  }

  /* And no lastSyncedAt parameter: an age would imply a cache exists. */
  assert.doesNotMatch(codeOf(LIST_STATES), /lastSyncedAt/);
});

test('offline is decided before any fetch error', () => {
  /* Ordering, not presence. A failed fetch while offline is not a server error: the cause is known,
   * and "check your connection" is actionable where a request id is not. */
  const code = codeOf(LIST_STATES);
  const offlineAt = code.indexOf('if (!online)');
  const errorAt = code.indexOf('if (error != null)');
  assert.ok(offlineAt >= 0 && errorAt >= 0, 'both branches must exist');
  assert.ok(offlineAt < errorAt, 'offline must outrank a transport error');
});

test('a revoked grant is terminal rather than retryable', () => {
  /* Retry on a revoked grant invites the user to hammer an endpoint that will keep answering 404.
   * dismissesSharedResource is the model-level predicate for shared_grant_revoked/expired.
   *
   * Scoped to the derive() body rather than matched against the whole file. The viewer names the
   * same predicate twice -- once here and once in classifySaveFailure() -- so a file-wide match
   * was satisfied by the save path while the branch that actually closes the screen was gone.
   * That mutation survived until this assertion was narrowed. */
  for (const [name, source] of [['list', LIST_STATES], ['viewer', VIEWER]]) {
    const code = codeOf(source);
    const start = code.indexOf('fun derive(');
    assert.ok(start >= 0, name + ' must expose derive()');
    /* Ends at the next top-level `fun `, which is the following declaration. */
    const rest = code.slice(start + 'fun derive('.length);
    const nextFun = rest.indexOf('\n    fun ');
    const deriveBody = nextFun === -1 ? rest : rest.slice(0, nextFun);

    assert.match(
      deriveBody,
      /if \(error\.dismissesSharedResource\) return PageState\.NotFoundOrRevoked/,
      name + ': derive() itself must treat a vanished grant as terminal',
    );
  }
});

test('a shared row never claims a pending write or a conflict', () => {
  /* Both describe a local write queue, and a shared resource has none: every write goes straight to
   * the owner's main end through invoke. A banner here would describe state that cannot exist. */
  for (const source of [LIST_STATES, VIEWER]) {
    assert.doesNotMatch(codeOf(source), /pendingSync = true/);
    assert.doesNotMatch(codeOf(source), /conflict = true/);
    assert.doesNotMatch(codeOf(source), /savingLocal = true/);
  }
});

test('shared search runs locally so the term never reaches the owner server', () => {
  /* A server-side query would put the owner's resource names, and whatever the user typed, into
   * request logs on the main end. The list is bounded by what one owner shared. */
  assert.match(LIST_STATES, /fun filter\(resources: List<SharedResourceSummary>, query: String\)/);

  /* Naming the fields, not just the call. `contains(needle, ignoreCase = true)` matched whatever
   * the lambda searched, so replacing `item ->` with `_ ->` -- a filter that matches nothing and
   * turns the search box into a silent empty list -- passed the earlier assertion. */
  /* The lambda parameter has to be bound, not discarded. Gutting it to `_ ->` leaves the body
   * referencing an undefined `item`, which kotlinc rejects -- but Kotlin does not compile on a
   * developer machine here, and being the check that runs everywhere is this file's entire job. */
  assert.match(
    LIST_STATES,
    /return resources\.filter \{ item ->/,
    'the filter must bind its element, or nothing is searched',
  );
  assert.match(
    LIST_STATES,
    /item\.displayName\.contains\(needle, ignoreCase = true\)/,
    'search must match the resource name',
  );
  assert.match(
    LIST_STATES,
    /item\.ownerLabel\.contains\(needle, ignoreCase = true\)/,
    'search must match the owner label',
  );
});

test('the shared note body is not a mirror type and cannot be persisted', () => {
  /* The type-system half of the residency rule. Reusing the mirrored Note type is what would make an
   * accidental dao.upsert(note) compile; a separate class means no DAO, entity or serializer accepts
   * this value at all. */
  assert.match(VIEWER, /^class SharedNoteBody\(/m, 'must be its own type, not the mirrored Note');
  assert.doesNotMatch(
    codeOf(VIEWER),
    /data class SharedNoteBody/,
    'a data class would print every field in toString',
  );

  /* Not @Serializable: a serializer is the shortest path to a disk write, a SavedStateHandle
   * round-trip or a log line. */
  const beforeBody = codeOf(VIEWER).slice(0, codeOf(VIEWER).indexOf('class SharedNoteBody'));
  assert.doesNotMatch(beforeBody, /@Serializable\s*$/, 'the body must not be serializable');
  assert.doesNotMatch(codeOf(VIEWER), /import kotlinx\.serialization/);

  /* An explicit redacted toString. This is the assertion that catches the real leak route: an
   * exception message or crash report that interpolates the body. */
  assert.match(VIEWER, /override fun toString\(\)/);
  const toStringBody = VIEWER.slice(VIEWER.indexOf('override fun toString()'));
  const firstLine = toStringBody.slice(0, toStringBody.indexOf('\n'));
  assert.doesNotMatch(firstLine, /content/, 'toString must not include the content');
  assert.doesNotMatch(firstLine, /\btitle\b/, 'toString must not include the title');
});

test('the shared note body never reaches Room, preferences or a file', () => {
  /* Structural: core-data has no DAO for shared data at all, and SharedResourceStore holds nothing
   * across process death. If either changes, the residency rule stops being enforced by the shape of
   * the code and starts depending on nobody calling the wrong method. */
  assert.match(STORE, /class SharedResourceStore \{/);
  assert.doesNotMatch(codeOf(STORE), /@Dao|@Entity|RoomDatabase|SharedPreferences|DataStore/);

  for (const source of [VIEWER, LIST_STATES]) {
    assert.doesNotMatch(codeOf(source), /SharedPreferences|DataStore|@Dao|@Entity/);
    /* SavedStateHandle survives process death, which is precisely what a no-store body must not do. */
    assert.doesNotMatch(codeOf(source), /SavedStateHandle/);
    assert.doesNotMatch(codeOf(source), /\bFile\(|FileOutputStream|openFileOutput/);
  }
});

test('editing a shared note requires an explicit edit grant', () => {
  /* Sharing implies discover/view/use/observe and nothing else, so a shared note is read-only unless
   * the owner granted edit deliberately. Offering an editor without it lets the user type a change
   * the server then refuses, losing the work. */
  assert.match(VIEWER, /fun canEdit\(capabilities: CapabilitySet\): Boolean = capabilities\.canEdit/);
  assert.match(LIST_STATES, /fun canEditContent\(summary: SharedResourceSummary\): Boolean =\s*\n?\s*Capability\.EDIT in summary\.capabilities/);
});

test('an update always carries the revision the text was read at', () => {
  /* The guard the server enforces with `revision_required`. Sending the freshest known revision
   * instead would make every save succeed, including one that silently overwrites an owner edit the
   * user never saw -- which is the entire failure expectedRevision exists to prevent. */
  /* End-anchored. Without the anchor `= edit.baselineRevision + 1` also matched, which is
   * precisely the regression the guard exists to stop: any arithmetic on the baseline reports a
   * revision the user never read, so the server accepts a write over an unseen owner edit. */
  assert.match(
    VIEWER,
    /fun expectedRevisionFor\(edit: SharedNoteEdit\): Long = edit\.baselineRevision\s*$/m,
    'expectedRevision must be the baseline verbatim, with no adjustment',
  );
  assert.match(VIEWER, /val baselineRevision: Long/);
  assert.match(VIEWER, /const val CODE_REVISION_CONFLICT/);
});

test('a revision conflict hands the editor text back', () => {
  /* For a shared note there is no local draft, so discarding the text on a 409 loses work the user
   * cannot recover from anywhere. The conflict case must carry it. */
  assert.match(VIEWER, /data class Conflict\(val serverRevision: Long, val localTitle: String, val localContent: String\)/);
  assert.match(VIEWER, /SharedNoteSaveOutcome\.Conflict\(serverRevision, editorTitle, editorContent\)/);
});

test('the wire operation names match the server', () => {
  /* mobile-v1-shared.js dispatches on the literal strings `read` and `update`, and answers
   * `unsupported_scope` for anything else. A typo here is a runtime-only failure. */
  assert.match(VIEWER, /const val OPERATION_READ = "read"/);
  assert.match(VIEWER, /const val OPERATION_UPDATE = "update"/);
  assert.match(VIEWER, /const val CODE_UNSUPPORTED_SCOPE = "unsupported_scope"/);

  const server = fs.readFileSync(path.join(MOBILE_ROOT, '..', '..', 'mobile-v1-shared.js'), 'utf8');
  assert.match(server, /operation === 'read'/, 'the server must still accept read');
  assert.match(server, /operation === 'update'/, 'the server must still accept update');
  assert.match(server, /'revision_required'/);
});

test('both state layers have JVM coverage for the rules that fail silently', () => {
  const listTest = read(CONNECTIONS_TEST, 'SharedResourceListStatesTest.kt');
  const viewerTest = read(NOTES_TEST, 'SharedNoteViewerStatesTest.kt');

  for (const name of [
    'offline is terminal and never shows a cached list',
    'offline outranks a transport error',
    'a revoked grant is terminal rather than retryable',
    'an empty search result is a filter outcome not an empty share set',
    'content never claims a pending write or a conflict',
    'edit is never implied by sharing',
  ]) {
    assert.ok(listTest.includes(name), 'missing list coverage: ' + name);
  }

  for (const name of [
    'the body never prints its own content',
    'offline is terminal',
    'a 404 reads as revoked rather than as a retryable failure',
    'revocation outranks a permission problem',
    'editing requires an explicit edit grant',
    'a revision conflict preserves the editor text',
    'expectedRevision is the baseline the edit started from',
  ]) {
    assert.ok(viewerTest.includes(name), 'missing viewer coverage: ' + name);
  }
});

test('the client is actually reachable from the store', () => {
  /* The bug this whole file exists around. `SharedResourceClient` was constructed in
   * AccountContainer and never called; `SharedResourceStore.replace()` had no caller anywhere in
   * the tree. Both halves shipped, tested, and dead -- the same shape as
   * `driveProfileProvider = { null }` before the SAF picker was wired. Nothing failed at runtime
   * to say so: the list simply rendered empty forever. */
  assert.match(COORDINATOR, /class SharedResourceCoordinator\(/);
  assert.match(COORDINATOR, /store\.replace\(/, 'the coordinator must fill the store');

  /* Scoped to refresh(). `client.list()` also appears in ApiSharedResourceFetcher's own
   * override, so a file-wide match stayed green while refresh() stopped calling the API
   * altogether -- reintroducing the empty-store bug this class exists to fix. */
  const refreshAt = codeOf(COORDINATOR).indexOf('suspend fun refresh()');
  assert.ok(refreshAt >= 0, 'refresh() must exist');
  const refreshBody = codeOf(COORDINATOR).slice(refreshAt, codeOf(COORDINATOR).indexOf('suspend fun refreshOne'));
  assert.match(refreshBody, /client\.list\(\)/, 'refresh() itself must call the API');
  assert.match(refreshBody, /store\.replace\(/, 'refresh() itself must fill the store');

  /* And it must be constructed, or it is dead code in exactly the same way. */
  assert.match(
    CONTAINER,
    /val sharedResourceCoordinator: SharedResourceCoordinator = SharedResourceCoordinator\(/,
    'AccountContainer must construct the coordinator',
  );
  assert.match(
    CONTAINER,
    /client = ApiSharedResourceFetcher\(sharedResourceClient\)/,
    'the coordinator must be handed the real client',
  );
  assert.match(CONTAINER, /store = sharedResources/);
});

test('the coordinator is testable without an HTTP stack', () => {
  /* SharedResourceClient is a final class over a final MobileApiClient, so depending on it
   * directly would make every residency assertion require a real socket. core-sync already solves
   * this with SyncTransport + MobileApiTransport; this follows it rather than inventing a second
   * convention. */
  assert.match(COORDINATOR, /interface SharedResourceFetcher \{/);
  assert.match(
    COORDINATOR,
    /class ApiSharedResourceFetcher\(private val client: SharedResourceClient\) : SharedResourceFetcher/,
  );
  assert.match(COORDINATOR, /private val client: SharedResourceFetcher,/);
});

test('a refresh replaces the list rather than merging into it', () => {
  /* A row the server stopped returning has had its grant withdrawn, so it must leave the device on
   * the same round. A merge would keep a revoked resource on screen indefinitely, which is the
   * residency violation this coordinator exists to avoid. */
  const code = codeOf(COORDINATOR);
  assert.match(code, /store\.replace\(rows, now\)/);

  /* Expiry applied on the same pass: expiresAt is a deadline, not a delete, and the server is not
   * obliged to have filtered a grant that lapsed while the response was in flight. */
  assert.match(code, /store\.purgeExpired\(now\)/);
});

test('a transient failure keeps the list but a revocation clears it', () => {
  /* The distinction that matters on failure. A 503 is not evidence the user lost access, so wiping
   * the list would make a flaky network look like a revocation. */
  const code = codeOf(COORDINATOR);
  assert.match(code, /if \(result\.error\.dismissesSharedResource\) \{\s*store\.clear\(\)/);
});

test('clearing resets the loaded flag, not just the rows', () => {
  /* Leaving hasLoaded true makes the next screen claim "nobody has shared anything with you" --
   * a false statement about the new account rather than a stale one about the old. */
  const code = codeOf(COORDINATOR);
  const clearAt = code.indexOf('fun clear()');
  assert.ok(clearAt >= 0, 'clear() must exist');
  const body = code.slice(clearAt, clearAt + 320);
  assert.match(body, /store\.clear\(\)/);
  assert.match(body, /loaded\.value = false/, 'clear() must reset hasLoaded');

  /* And the purge paths must go through the coordinator, or they clear the store while leaving
   * hasLoaded true -- the exact stale-claim bug above. */
  assert.match(CONTAINER, /sharedResourceCoordinator\.clear\(\)/);
  assert.doesNotMatch(
    codeOf(CONTAINER),
    /sharedResources\.clear\(\)/,
    'purge must route through the coordinator, not the bare store',
  );
});

test('the shared endpoint never carries an endpoint into the store', () => {
  /* GET /shared/{type}/{id} may enrich its response with host, port and username. Dropping them at
   * the mapping boundary is what makes it impossible to render them later:
   * SHARED_RESOURCE_RESIDENCY.md 2 forbids storing the endpoint of a shared resource, and
   * SharedResourceSummary has no field for one. */
  const mapAt = codeOf(COORDINATOR).indexOf('fun toSummary(');
  assert.ok(mapAt >= 0, 'toSummary must exist');
  const mapper = codeOf(COORDINATOR).slice(mapAt, codeOf(COORDINATOR).indexOf('}', mapAt));
  for (const field of ['host', 'port', 'username']) {
    assert.ok(!mapper.includes(field), 'toSummary must not carry ' + field + ' into the store');
  }

  /* The stronger guarantee, and the one worth pinning: SharedResource -- the network domain type
   * the mapper reads from -- has no endpoint fields at all, even though
   * SharedResourceSummaryDto does carry host/port/username for the detail response. The endpoint
   * is dropped at the DTO-to-domain boundary, so no mapper downstream can carry it even by
   * accident. Asserting only on the mapper was weaker than the code actually is. */
  const client = fs.readFileSync(
    path.join(
      ANDROID, 'core-network', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'network',
      'SharedResourceClient.kt',
    ),
    'utf8',
  );
  const domainAt = client.indexOf('data class SharedResource(');
  assert.ok(domainAt >= 0, 'SharedResource must exist');
  const domain = client.slice(domainAt, client.indexOf(')', client.indexOf('protocol', domainAt)));
  for (const field of ['val host', 'val port', 'val username']) {
    assert.ok(!domain.includes(field), 'SharedResource must not declare ' + field);
  }

  const storeCode = codeOf(STORE);
  for (const field of ['val host', 'val port', 'val username']) {
    assert.ok(!storeCode.includes(field), 'SharedResourceSummary must not declare ' + field);
  }
});

test('the coordinator has JVM coverage for each failure path', () => {
  const suite = read(SYNC_TEST, 'SharedResourceCoordinatorTest.kt');
  for (const name of [
    'a successful refresh fills the store and marks it loaded',
    'the owner display name becomes the owner label',
    'a refresh replaces rather than merges',
    'an expired grant is dropped on the same pass',
    'a retryable failure keeps the rows already held',
    'a revocation clears the list',
    'a 404 on detail removes the row immediately',
    'clear resets the loaded flag so the next screen shows a spinner',
  ]) {
    assert.ok(suite.includes(name), 'missing coordinator coverage: ' + name);
  }
});

test('the new Kotlin is ASCII-only', () => {
  /* Same rule as the provider gates. A non-ASCII literal mangled at a shell boundary still compiles,
   * and a corrupted wire constant fails only at runtime against a real server. */
  for (const [dir, name] of [
    [CONNECTIONS_MAIN, 'SharedResourceListStates.kt'],
    [NOTES_MAIN, 'SharedNoteViewerStates.kt'],
    [CONNECTIONS_TEST, 'SharedResourceListStatesTest.kt'],
    [NOTES_TEST, 'SharedNoteViewerStatesTest.kt'],
    [SYNC_MAIN, 'SharedResourceCoordinator.kt'],
    [SYNC_TEST, 'SharedResourceCoordinatorTest.kt'],
  ]) {
    const source = read(dir, name);
    const bad = [...source].filter((ch) => ch.codePointAt(0) > 127);
    assert.equal(bad.length, 0, name + ' contains non-ASCII: ' + bad.join(''));
  }
});
