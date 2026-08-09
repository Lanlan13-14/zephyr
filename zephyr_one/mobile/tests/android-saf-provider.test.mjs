/*
 * Static gate for the Android SAF file-sync provider.
 *
 * `Zft2FileProvider` had no implementation anywhere in the tree. The dispatcher, the session, the
 * path jail and the foreground service were all present and unit-tested, but nothing could serve a
 * byte: FileBridgeForegroundService showed a notification for a share that could not answer a single
 * LIST. DEVELOPMENT.md 2.2 records it as M3's open blocker, and it is why F-026 was `missing`.
 *
 * There is no Android SDK, no Gradle and no kotlinc on a developer machine here, so the Kotlin unit
 * tests in feature-file-sync run only in CI. This file is the cheap half that runs everywhere: it
 * checks that the properties which make the provider safe are still present in the source, because
 * each of them is a silent security regression rather than a visible failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_ROOT = path.join(MOBILE_ROOT, 'android', 'feature-file-sync');
const MAIN = path.join(MODULE_ROOT, 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'filesync');
const TEST = path.join(MODULE_ROOT, 'src', 'test', 'kotlin', 'one', 'zephyr', 'mobile', 'feature', 'filesync');

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

/*
 * Strips comments, mirroring kotlin-symbols.test.mjs.
 *
 * The negative assertions below are about what the code DOES, and these files explain in prose
 * exactly which shapes they avoid and why -- `"rwt"` truncates, `DocumentFile` costs a query per
 * child. Matching raw source made those explanations fail the very checks they describe, which
 * would have taught the next reader to delete the reasoning to get green.
 */
const codeOf = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const PROVIDER = read(MAIN, 'SafZft2FileProvider.kt');
const TREE = read(MAIN, 'SafDocumentTree.kt');
const RESOLVER = read(MAIN, 'ContentResolverDocumentTree.kt');
const GRANTS = read(MAIN, 'SafShareGrants.kt');

test('the module is no longer an empty declared dependency', () => {
  /* :app depends on :feature-file-sync, so an empty module is a dependency that contributes
   * nothing. settings.gradle.kts included it and build.gradle.kts already listed documentfile,
   * which is how it was clear the module was intended to hold exactly this. */
  const sources = fs.readdirSync(MAIN).filter((name) => name.endsWith('.kt'));
  assert.ok(sources.length >= 4, 'expected the provider, the seam and the grant chain, saw ' + sources.join(', '));

  const settings = fs.readFileSync(path.join(MOBILE_ROOT, 'android', 'settings.gradle.kts'), 'utf8');
  assert.match(settings, /include\(":feature-file-sync"\)/);
});

test('SafZft2FileProvider actually implements the ZFT2 provider interface', () => {
  assert.match(PROVIDER, /class SafZft2FileProvider\([\s\S]*?\) : Zft2FileProvider \{/);

  /* Every member of Zft2FileProvider must be overridden, or the class does not compile. Checked
   * here because nothing on a developer machine compiles it. */
  for (const member of [
    'list', 'stat', 'open', 'read', 'write', 'close',
    'mkdir', 'delete', 'rename', 'truncate', 'closeAll',
  ]) {
    assert.match(
      PROVIDER,
      new RegExp('override suspend fun ' + member + '\\('),
      member + '() must be overridden',
    );
  }
});

test('path resolution walks real children instead of building document ids', () => {
  /* The security property. SAF has no path lookup, and a child document id CAN be built by string
   * concatenation -- which is exactly what makes it dangerous, because the id then encodes an
   * unverified path. Resolving by walking means traversal is unreachable rather than blocked by a
   * check that could be forgotten: `..` is not a name any child has. */
  assert.match(PROVIDER, /private suspend fun resolveExisting\(path: String\): Resolved/);
  assert.match(PROVIDER, /childNamed\(current\.documentId, component\)/,
    'each component must be resolved as a real child of the previous document');
  assert.match(PROVIDER, /tree\.children\(parentId\)\.firstOrNull \{ it\.name == name \}/,
    'child lookup must be an exact name match');

  /* The provider must never assemble a document id from a path. buildDocumentUriUsingTree with a
   * derived id is the shape that escapes, and it belongs only in the platform file. */
  assert.doesNotMatch(codeOf(PROVIDER), /buildDocumentUriUsingTree/,
    'the provider must not construct document URIs; that is the platform layer');
  assert.doesNotMatch(codeOf(PROVIDER), /documentId \+ ["'/]/,
    'a document id must never be built by concatenation');
});

test('the virtual path validator still runs before resolution', () => {
  /* Both layers are kept. The walk is what confines; normalize() is what gives the peer a precise
   * invalid_path instead of a confusing not_found, and it is the shared rule iOS must match. */
  assert.match(PROVIDER, /import one\.zephyr\.mobile\.protocol\.zft2\.VirtualPath/);

  /* Pinned inside resolveExisting specifically, not just counted across the file.
   *
   * A count is too weak: deleting the normalise from resolveExisting -- the one function every
   * path flows through -- left the other call sites intact and the count still passed. Verified by
   * mutation. */
  const resolveBody = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('private suspend fun resolveExisting('),
    codeOf(PROVIDER).indexOf('private suspend fun openOrCreateForWrite('),
  );
  assert.ok(resolveBody.length > 0, 'resolveExisting must be locatable');
  assert.match(
    resolveBody,
    /val normalized = VirtualPath\.normalize\(path\)/,
    'resolveExisting must validate before it walks; it is the funnel every path passes through',
  );

  /* And every other path-taking entry point normalises too, so a new one cannot skip it. */
  const normalizeCalls = codeOf(PROVIDER).match(/VirtualPath\.normalize\(/g) || [];
  assert.ok(normalizeCalls.length >= 6, 'every path-taking entry point must normalise, saw ' + normalizeCalls.length);
});

test('the read-only jail is enforced per operation, not just by the dispatcher', () => {
  /* ADR-004: there is no trustworthy single read-only switch at the protocol layer. Zft2Dispatcher
   * refusing write ops is not enough on its own, because the JSON-RPC surface reaches this provider
   * too and a future caller could reach it directly. */
  assert.match(PROVIDER, /private fun requireWritable\(\) \{\s*if \(readOnly\) throw Zft2Exception\("read_only"/);
  for (const member of ['mkdir', 'delete', 'rename', 'truncate']) {
    const body = PROVIDER.slice(PROVIDER.indexOf('override suspend fun ' + member + '('));
    assert.match(body.slice(0, 400), /requireWritable\(\)/, member + '() must refuse a read-only share');
  }
  assert.match(PROVIDER, /if \(readOnly\) throw Zft2Exception\("read_only", "Share is read-only"\)/);
});

test('a handle is bound to the mode it was opened with', () => {
  /* DEVELOPMENT.md 13.3. A handle not bound to its mode lets a read-mode handle be written through,
   * so the check is on the stored handle rather than on the incoming frame. */
  assert.match(PROVIDER, /val writable: Boolean/);
  assert.match(
    PROVIDER,
    /if \(!open\.writable\) throw Zft2Exception\("read_only", "Handle is open for reading"\)/,
    'write() must refuse a handle opened for reading',
  );
});

test('handles are unpredictable rather than sequential', () => {
  /* A guessable sequential handle lets a peer read a document it never opened -- including one
   * another operation opened for writing. */
  assert.match(PROVIDER, /import java\.security\.SecureRandom/);
  assert.match(PROVIDER, /random: SecureRandom = SecureRandom\(\)/);
  assert.match(PROVIDER, /random\.nextBytes\(bytes\)/);
  assert.match(PROVIDER, /HANDLE_BYTES = 16/, '128 bits of entropy');
  assert.doesNotMatch(codeOf(PROVIDER), /handleSeq|\+\+sequence|counter\+\+/,
    'a counter would make handles guessable');
});

test('resource limits bound what a hostile peer can force', () => {
  /* DEVELOPMENT.md 13.4 requires bounded handles and listing sizes. */
  assert.match(PROVIDER, /too_many_handles/);
  assert.match(PROVIDER, /if \(entries\.size > maxListEntries\) break/,
    'the listing must be bounded while building, not after it is all in memory');

  /* Bounded twice on open: the cheap early rejection, then again under the lock. Two concurrent
   * opens both pass a check made before either inserted. */
  const openBody = PROVIDER.slice(
    PROVIDER.indexOf('override suspend fun open('),
    PROVIDER.indexOf('override suspend fun read('),
  );
  const checks = openBody.match(/handles\.size >= maxOpenHandles/g) || [];
  assert.equal(checks.length, 2, 'open() must re-check the handle limit under the lock');
  assert.match(openBody, /access\.close\(\)/, 'a descriptor refused under the lock must not leak');
});

test('destructive operations refuse the cases that lose data silently', () => {
  assert.match(PROVIDER, /Cannot delete the share root/,
    'deleting the granted root would revoke the share from inside a file operation');
  assert.match(PROVIDER, /throw Zft2Exception\("not_empty"/,
    'SAF deletes a tree unconditionally, so a non-recursive request must be refused explicitly');
  assert.match(PROVIDER, /if \(VirtualPath\.isWithin\(from, to\)\)/,
    'moving a directory into itself detaches the subtree');
  assert.match(PROVIDER, /throw Zft2Exception\("unsupported", "This directory does not support moving files"\)/,
    'a move must not be emulated with copy-then-delete');
});

test('canWrite is the real platform answer, narrowed by the share', () => {
  /* DEVELOPMENT.md 13.4 forbids a fixed canWrite=true, which the Dart agent does. The main end reads
   * this field to decide whether to offer a write at all, so advertising true and refusing later is
   * what leaves a half-copied file on the Windows side. */
  assert.match(PROVIDER, /canWrite = canWrite && !readOnly/,
    'a read-only share must advertise canWrite=false even for a writable document');
  assert.match(PROVIDER, /throw Zft2Exception\("permission_denied", "Not writable: "/,
    'the platform answer must override the config');

  assert.match(RESOLVER, /FLAG_SUPPORTS_WRITE/);
  assert.match(RESOLVER, /FLAG_DIR_SUPPORTS_CREATE/);
  assert.match(RESOLVER, /canWrite = if \(isDirectory\) supportsCreate else supportsWrite/,
    'canWrite must be derived from the provider flags, not assumed');
  assert.doesNotMatch(codeOf(RESOLVER), /canWrite = true/, 'never a constant');
});

test('reads and writes are positional so parallel reads cannot corrupt each other', () => {
  /* Reads on one handle stay concurrent (DEVELOPMENT.md 13.3) and both directions share one file
   * descriptor, so a shared stream position would interleave readers into each other's data:
   * corruption that looks like a network fault and only appears under parallel readahead. */
  assert.match(RESOLVER, /Os\.pread\(/);
  assert.match(RESOLVER, /Os\.pwrite\(/);
  assert.doesNotMatch(codeOf(RESOLVER), /\.seek\(|setPosition/, 'a seeking descriptor would race itself');

  /* "rw", never "rwt": rwt truncates on open, and a WRITE at a non-zero offset -- how RDPDR delivers
   * a large file -- would discard everything already written. */
  assert.match(RESOLVER, /val mode = if \(write\) "rw" else "r"/);
  assert.doesNotMatch(codeOf(RESOLVER), /"rwt"/, 'rwt truncates on open');

  /* A zero-byte write is not progress; reporting it as such leaves the file silently short. */
  assert.match(RESOLVER, /if \(count <= 0\) throw Zft2Exception\("io_error", "Write made no progress"\)/);
});

test('a listing is one cursor rather than one query per child', () => {
  /* DocumentFile.listFiles() issues a query per child to read each display name, so a directory of
   * 2000 files costs 2000 Binder round trips. LIST is what Windows Explorer issues on every
   * navigation, so this is the whole cost of browsing. */
  assert.match(RESOLVER, /private val PROJECTION = arrayOf\(/);
  assert.match(RESOLVER, /COLUMN_DOCUMENT_ID/);
  assert.match(RESOLVER, /COLUMN_DISPLAY_NAME/);
  assert.match(RESOLVER, /COLUMN_FLAGS/);
  assert.doesNotMatch(codeOf(RESOLVER), /DocumentFile/, 'DocumentFile would reintroduce the per-child query');
});

test('platform error text never reaches the peer', () => {
  /* ErrnoException.getMessage() includes the host path, and SHARED_RESOURCE_RESIDENCY.md keeps
   * device paths out of anything the peer or a notification can see. */
  assert.match(RESOLVER, /private fun Throwable\.toZft2\(what: String\): Zft2Exception/);
  assert.match(RESOLVER, /return Zft2Exception\(code, what\)/,
    'the wire message must be the caller-supplied text, not the platform message');
  assert.doesNotMatch(codeOf(RESOLVER), /Zft2Exception\([^)]*failure\.message/);
  assert.doesNotMatch(codeOf(RESOLVER), /Zft2Exception\([^)]*localizedMessage/);
});

test('the grant chain re-derives validity instead of trusting stored state', () => {
  /* A SAF grant is revocable system state and nothing notifies the app when it goes. A share whose
   * grant vanished must be reported invalid, not served as an empty directory. */
  assert.match(GRANTS, /fun grant\(profileId: String\): SafShareGrant\?/);
  assert.match(GRANTS, /grantValid = live != null && live\.canRead/);
  assert.match(GRANTS, /readOnly = stored\.readOnly \|\| live == null \|\| !live\.canWrite/,
    'a downgraded grant must narrow the share and never widen it');
  assert.match(GRANTS, /fun pruneRevoked\(\): List<String>/);

  /* Releasing on revoke, but only when no other profile still uses the tree: multiple profiles over
   * one directory is legal, and releasing on the first removal would break the second. */
  assert.match(GRANTS, /if \(store\.values\.none \{ it\.treeUri == stored\.treeUri \}\)/);
  assert.match(GRANTS, /permissions\.releasePersistable\(stored\.treeUri\)/);
});

test('the platform seam keeps the provider logic testable off-device', () => {
  /* The split is why the jail and the read-only rules have JVM unit tests at all. If the provider
   * imported ContentResolver directly, none of it could be exercised without an emulator, and
   * nothing in this repository runs an emulator. */
  assert.doesNotMatch(codeOf(PROVIDER), /import android\./, 'the provider must not depend on the Android SDK');
  assert.doesNotMatch(codeOf(TREE), /import android\./, 'the seam must stay platform-free');
  assert.match(RESOLVER, /import android\.provider\.DocumentsContract/);
  assert.match(RESOLVER, /\) : SafDocumentTree \{/);
});

test('the Kotlin unit tests cover the attacks DEVELOPMENT.md 19.6 names', () => {
  /* These run in CI only, so their presence is asserted here. Each corresponds to a listed attack:
   * path traversal, hostile file names, huge directories, handle leaks. */
  const providerTest = read(TEST, 'SafZft2FileProviderTest.kt');
  for (const name of [
    'traversalCannotEscapeTheGrantedTree',
    'aSiblingOfTheRootIsNotReachableEvenWhenItsNamePrefixMatches',
    'aDocumentIdIsNeverAcceptedAsAPath',
    'listSkipsNamesTheWireCouldNotAddress',
    'listIsBoundedSoAHugeDirectoryCannotExhaustMemory',
    'everyMutatingOperationIsRefusedOnAReadOnlyShare',
    'aHandleOpenedForReadingCannotBeWrittenThrough',
    'handlesAreUnpredictable',
    'handleCountIsBoundedAndTheDescriptorIsNotLeakedWhenRefused',
    'closeAllReleasesEveryDescriptor',
    'writeDoesNotTruncateUnlessAskedTo',
    'deleteRefusesANonEmptyDirectoryUnlessRecursive',
  ]) {
    assert.match(providerTest, new RegExp('fun ' + name + '\\('), 'missing coverage: ' + name);
  }

  const grantsTest = read(TEST, 'SafShareGrantsTest.kt');
  for (const name of [
    'aReadOnlyGrantNarrowsTheShareEvenWhenTheConfigAskedForWrite',
    'revokedOutsideTheAppTheShareIsReportedInvalidRatherThanMissing',
    'revokingOneOfTwoSharesOverTheSameTreeKeepsTheGrant',
    'pruningDropsRevokedSharesAndNamesThem',
  ]) {
    assert.match(grantsTest, new RegExp('fun ' + name + '\\('), 'missing coverage: ' + name);
  }
});

test('the new Kotlin is ASCII-only', () => {
  /* Not style. Non-ASCII literals have been destroyed three times by a shell boundary in this
   * environment, and a mangled string in a path check is a security change that compiles fine. */
  for (const dir of [MAIN, TEST]) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.kt'))) {
      const source = read(dir, name);
      const offenders = [...source].filter((ch) => ch.codePointAt(0) > 127);
      assert.equal(offenders.length, 0, name + ' contains non-ASCII: ' + offenders.slice(0, 6).join(''));
    }
  }
});
