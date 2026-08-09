/*
 * Static gate for the iOS security-scoped ZFT2 provider.
 *
 * `Zft2FileProvider` had no iOS implementation at all: the codec, the metadata
 * encoder and the frozen-vector suites were present, but nothing could serve a
 * byte, and F-027 recorded that as `missing`. This is the counterpart of
 * android-saf-provider.test.mjs.
 *
 * There is no Swift toolchain outside the macOS CI runner, so the XCTest suites in
 * ios/Tests run in exactly one place. This file is the cheap half that runs
 * everywhere: it checks that the properties which make the provider safe are
 * still present in the source, because each is a silent security regression rather
 * than a visible failure.
 *
 * The iOS jail differs from Android's in a way worth stating once: SAF addresses
 * documents by opaque id and has no symlinks, so the Android provider resolves by
 * walking children and traversal is unreachable. A security-scoped root is a real
 * directory, so here every path is canonicalised and re-checked for containment.
 * Those are different mechanisms for the same guarantee, and the assertions below
 * are about this one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(MOBILE_ROOT, 'ios', 'Sources', 'ZephyrCore');
const TESTS = path.join(MOBILE_ROOT, 'ios', 'Tests', 'ZephyrCoreTests');

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

/*
 * Strips comments, mirroring swift-symbols.test.mjs.
 *
 * The negative assertions below are about what the code DOES, and these files
 * explain in prose exactly which shapes they avoid and why -- `try?` swallows an
 * escape, `O_TRUNC` discards written bytes, `FileManager` cannot see a symlink.
 * Matching raw source would make those explanations fail the very checks they
 * describe, which teaches the next reader to delete the reasoning to get green.
 */
const codeOf = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const PROVIDER = read(CORE, 'SecurityScopedFileProvider.swift');
const SEAM = read(CORE, 'SecurityScopedFileSystem.swift');
const POSIX = read(CORE, 'PosixSecurityScopedFileSystem.swift');
const GRANTS = read(CORE, 'SecurityScopedGrants.swift');
const VPATH = read(CORE, 'VirtualPath.swift');
const PROTOCOL = read(CORE, 'Zft2FileProvider.swift');
const BOOKMARKS = read(CORE, 'PersistentBookmarkStore.swift');
const ROWS = read(CORE, 'ShareRowStore.swift');
const KV = read(CORE, 'KeyValueStore.swift');

test('the iOS core now has a file provider at all', () => {
  /* F-027 was `missing` because ZephyrCore held the codec and the crypto and
   * nothing that could answer a LIST. */
  for (const name of [
    'Zft2FileProvider.swift',
    'SecurityScopedFileProvider.swift',
    'SecurityScopedFileSystem.swift',
    'PosixSecurityScopedFileSystem.swift',
    'SecurityScopedGrants.swift',
    'VirtualPath.swift',
  ]) {
    assert.ok(fs.existsSync(path.join(CORE, name)), name + ' must exist in ZephyrCore');
  }
});

test('SecurityScopedFileProvider implements the whole provider protocol', () => {
  assert.match(PROVIDER, /public actor SecurityScopedFileProvider: Zft2FileProvider \{/);

  /* Every requirement of the protocol, or the type does not compile. Checked here
   * because nothing outside the macOS runner compiles it. */
  const required = [
    /func list\(path: String\) async throws -> \[Zft2FileStat\]/,
    /func stat\(path: String\) async throws -> Zft2FileStat/,
    /func open\(path: String, mode: String\) async throws -> String/,
    /func read\(handle: String, offset: Int64, length: Int\) async throws -> Data/,
    /func write\(handle: String, offset: Int64, data: Data\) async throws -> Int/,
    /func close\(handle: String\) async throws/,
    /func mkdir\(path: String\) async throws/,
    /func delete\(path: String, recursive: Bool\) async throws/,
    /func rename\(oldPath: String, newPath: String\) async throws/,
    /func truncate\(path: String, size: Int64\) async throws/,
    /func closeAll\(\) async/,
  ];
  for (const pattern of required) {
    assert.match(PROTOCOL, pattern, 'the protocol must declare ' + pattern);
    assert.match(PROVIDER, pattern, 'the provider must implement ' + pattern);
  }
});

test('the jail canonicalises and re-checks containment rather than trusting the string', () => {
  /* The security property on this platform. A link in the MIDDLE of a path is the
   * case a prefix test on the unresolved string misses entirely: with
   * `/root/link -> /etc`, the string `/root/link/passwd` is inside `/root` by any
   * textual measure and resolves to `/etc/passwd`. */
  assert.match(PROVIDER, /private func canonicalHostPath\(for normalized: String\) throws -> String/);
  assert.match(
    PROVIDER,
    /guard VirtualPath\.isWithin\(root: root, candidate: canonical\) else \{/,
    'the containment test must be on the canonical path, not the joined one',
  );
  /* Pinned inside canonicalHostPath itself, and counted.
   *
   * The same refusal appears in canonicalHostPathForMissing, so a file-wide
   * match stayed green when the one in canonicalHostPath was deleted -- the
   * mutation that matters most, because it is the check every existing path
   * flows through. Verified by mutation. */
  const canonicalBody = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('func canonicalHostPath(for'),
    codeOf(PROVIDER).indexOf('func canonicalHostPathForMissing'),
  );
  assert.ok(canonicalBody.length > 0, 'canonicalHostPath must be locatable');
  assert.match(
    canonicalBody,
    /throw Zft2Error\(code: "invalid_path", message: "Path escapes the shared directory"\)/,
    'canonicalHostPath must refuse an escape, not just report it elsewhere',
  );
  const escapeRefusals = (codeOf(PROVIDER).match(/Path escapes the shared directory/g) || []).length;
  assert.equal(
    escapeRefusals,
    2,
    'both the existing-path and the missing-path resolvers must refuse an escape',
  );

  /* A node that does not exist yet still has to have a contained parent chain, or
   * `/root/link/new` would be created under the link's target. */
  assert.match(PROVIDER, /private func canonicalHostPathForMissing\(_ normalized: String\) throws -> String/);
  const missing = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('func canonicalHostPathForMissing'),
  );
  assert.match(
    missing.slice(0, 1200),
    /VirtualPath\.isWithin\(root: root, candidate: ancestor\)/,
    'the deepest existing ancestor must also be checked for containment',
  );

  /* realpath(3) resolves every component. A last-component-only resolution is the
   * shape that misses a link in the middle. */
  assert.match(POSIX, /Darwin\.realpath\(path, nil\)/);
  assert.doesNotMatch(
    codeOf(POSIX),
    /resolvingSymlinksInPath/,
    'URL.resolvingSymlinksInPath does not resolve a path that does not exist and is not equivalent',
  );
});

test('the write path refuses an escape as well as the read path', () => {
  /* `try?` would discard the invalid_path raised by an escape and report whatever
   * the create attempt then failed with. The typed catch keeps the refusal. */
  assert.match(
    PROVIDER,
    /\} catch let failure as Zft2Error where failure\.code == "not_found" \{/,
    'only not_found may mean "absent"',
  );
  const writePath = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('func resolveForWrite'),
    codeOf(PROVIDER).indexOf('func canonicalHostPath('),
  );
  assert.ok(writePath.length > 0, 'resolveForWrite must be locatable');
  assert.doesNotMatch(writePath, /try\?/, 'resolveForWrite must not swallow errors');
  /* The new file is built from the parent's CANONICAL path, so it lands inside the
   * root even when the virtual parent was reached through a contained link. */
  assert.match(writePath, /parent\.hostPath \+ "\/" \+ name/);
});

test('the shared virtual-path rule is ported, not reinvented', () => {
  /* DEVELOPMENT.md 13.4 requires Android and iOS to interpret a virtual path
   * identically. Two ports that disagree are two different jails wearing one
   * specification. */
  /* Each rule is pinned by its CONDITION, not only by its message.
   *
   * Matching the message alone left every guard defeatable by rewriting the
   * condition to `false` while the string stayed in the file, and three such
   * mutations survived before this was tightened. */
  const vpathCode = codeOf(VPATH);

  /* Built from char codes so no backslash literal appears in this file.
   * Expressing `if input.contains("\\\\") {` as a regex through JS, Python and
   * PowerShell escaping is how the first attempt matched nothing. */
  const BACKSLASH = String.fromCharCode(92);
  const BACKSLASH_GUARD = 'if input.contains("' + BACKSLASH + BACKSLASH + '") {';
  const NUL_GUARD = 'if input.contains("' + BACKSLASH + '0") {';
  for (const [condition, message, rule, raw] of [
    [/if segment == "\." \|\| segment == "\.\." \{/, /Relative segments are rejected/, 'dot segments'],
    [BACKSLASH_GUARD, /Backslash is not a path separator/, 'backslashes'],
    [/scalars\.count >= 2, scalars\[1\] == ":"/, /Drive-letter paths are rejected/, 'drive letters'],
    /* Raw source, not stripped: the "//" inside this guard's own string
     * literal looks like a line comment to codeOf(), which would delete the
     * rest of the line before the pattern could match. */
    [/if input\.hasPrefix\("\/\/"\) \{/, /UNC paths are rejected/, 'UNC prefixes', true],
    [NUL_GUARD, /Path contains NUL/, 'NUL bytes'],
    [/scalar\.value < 0x20 \|\| scalar\.value == 0x7f/, /Path contains control characters/, 'control characters'],
    [/if segments\.count > maxDepth \{/, /Path is too deep/, 'the depth bound'],
  ]) {
    const haystack = raw ? VPATH : vpathCode;
    if (typeof condition === 'string') {
      assert.ok(
        haystack.includes(condition),
        'the guard for ' + rule + ' must still be reachable',
      );
    } else {
      assert.match(haystack, condition, 'the guard for ' + rule + ' must still be reachable');
    }
    assert.match(VPATH, message, 'the wire message for ' + rule + ' must be unchanged');
  }

  /* No guard in the jail may be short-circuited to a constant.
   *
   * General rather than per-rule: rewriting a condition to `false` while the
   * message stays in the file is the whole family of mutations that survived
   * the first version of this gate, and a new guard added later gets this
   * protection without anyone remembering to extend a list. */
  assert.doesNotMatch(
    vpathCode,
    /if (false|true) \{|guard (false|true)\b/,
    'a path guard has been short-circuited to a constant',
  );

  /* Same numeric limits as the Kotlin. A port with different bounds accepts frames
   * the other refuses. */
  assert.match(VPATH, /maxSegmentLength = 255/);
  assert.match(VPATH, /maxPathLength = 4096/);
  assert.match(VPATH, /maxDepth = 64/);

  /* Containment must be tested at a segment boundary: a bare hasPrefix says
   * "/shared" is inside "/share". */
  assert.match(
    VPATH,
    /let prefix = root\.hasSuffix\("\/"\) \? root : root \+ "\/"/,
    'containment must only match whole segments',
  );

  /* Bounds are counted in UTF-8 bytes, matching the wire and the Kotlin. Counting
   * Characters would let combining sequences carry several times the bytes. */
  assert.match(VPATH, /input\.utf8\.count > maxPathLength/);
  assert.match(VPATH, /segment\.utf8\.count > maxSegmentLength/);
});

test('the read-only jail is enforced per operation, not just by the dispatcher', () => {
  /* ADR-004: there is no trustworthy single read-only switch at the protocol
   * layer, and a dispatcher refusing write ops is not enough on its own because
   * the JSON-RPC surface reaches this provider too. */
  assert.match(
    PROVIDER,
    /private func requireWritable\(\) throws \{\s*if readOnly \{\s*throw Zft2Error\(code: "read_only"/,
  );
  const code = codeOf(PROVIDER);
  for (const member of ['mkdir', 'delete', 'rename', 'truncate']) {
    const body = code.slice(code.indexOf('public func ' + member + '('));
    assert.match(body.slice(0, 300), /try requireWritable\(\)/, member + '() must refuse a read-only share');
  }
  /* open() and write() check readOnly directly, because they also have to consider
   * the requested mode and the handle's bound mode. */
  assert.match(PROVIDER, /if wantsWrite && readOnly \{/);
});

test('a handle is bound to the mode it was opened with', () => {
  /* DEVELOPMENT.md 13.3. A handle not bound to its mode lets a read-mode handle be
   * written through, so the check is on the stored handle rather than the frame. */
  assert.match(PROVIDER, /let writable: Bool/);
  assert.match(
    PROVIDER,
    /guard open\.writable else \{\s*throw Zft2Error\(code: "read_only", message: "Handle is open for reading"\)/,
  );
});

test('handles are unpredictable rather than sequential', () => {
  /* A guessable sequential handle lets a peer name a file it never opened,
   * including one another operation opened for writing. */
  /* The generator must be the SOURCE of the handle, not merely mentioned.
   *
   * Asserting its presence plus the absence of a counter was too weak: the
   * declaration could stay while the value came from somewhere else. So the
   * random draw itself is pinned, and it must feed the returned text. */
  const handleBody = codeOf(PROVIDER).slice(codeOf(PROVIDER).indexOf('static func newHandle()'));
  assert.ok(handleBody.length > 0, 'newHandle must be locatable');
  assert.match(handleBody.slice(0, 700), /var generator = SystemRandomNumberGenerator\(\)/);
  assert.match(
    handleBody.slice(0, 700),
    /UInt64\.random\(in: UInt64\.min\.\.\.UInt64\.max, using: &generator\)/,
    'the handle bytes must be drawn from the CSPRNG',
  );
  assert.match(PROVIDER, /handleBytes = 16/, '128 bits of entropy');
  assert.doesNotMatch(
    codeOf(PROVIDER),
    /handleSeq|sequence \+= 1|counter \+= 1/,
    'a counter would make handles guessable',
  );
  /* Padded, or a small chunk renders short and the printed handle loses entropy. */
  assert.match(PROVIDER, /leftPadded\(to: 16, with: "0"\)/);
});

test('resource limits bound what a hostile peer can force', () => {
  assert.match(codeOf(PROVIDER), /throw Zft2Error\(code: "too_many_handles"/);
  assert.match(
    PROVIDER,
    /if entries\.count > maxListEntries \{ break \}/,
    'the listing must be bounded while building, not after it is all in memory',
  );

  /* Bounded twice on open: the cheap early rejection, then again after the actor
   * suspends at an await, because two concurrent opens both pass a check made
   * before either inserted. */
  const openBody = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('public func open('),
    codeOf(PROVIDER).indexOf('public func read('),
  );
  const checks = openBody.match(/handles\.count >= maxOpenHandles/g) || [];
  assert.equal(checks.length, 2, 'open() must re-check the handle limit after awaiting');
  assert.match(openBody, /await access\.close\(\)/, 'a descriptor refused after opening must not leak');
});

test('destructive operations refuse the cases that lose data silently', () => {
  const code = codeOf(PROVIDER);
  assert.match(code, /Cannot delete the share root/,
    'deleting the granted root would revoke the share from inside a file operation');
  assert.match(code, /throw Zft2Error\(code: "not_empty"/,
    'a non-recursive delete over a non-empty directory must be refused explicitly');
  assert.match(PROVIDER, /if VirtualPath\.isWithin\(root: from, candidate: to\) \{/,
    'moving a directory into itself detaches the subtree');

  /* rename(2), not FileManager.moveItem: moveItem can fall back to copy-then-
   * delete, and a copy that fails halfway leaves two partial files while the peer
   * believes it moved one. A cross-volume move is refused instead. */
  assert.match(POSIX, /if rename\(absolutePath, destinationPath\) != 0 \{/);
  /* Word-anchored: `removeItem` contains the substring `moveItem`, so a bare
   * /moveItem/ matches the legitimate recursive-delete call instead. */
  assert.doesNotMatch(codeOf(POSIX), /\bmoveItem/, 'a move must not fall back to copy-then-delete');
  assert.match(codeOf(POSIX), /code: "unsupported",\s*message: "Cannot move between volumes"/);
});

test('canWrite is the real platform answer, narrowed by the share', () => {
  /* DEVELOPMENT.md 13.4 forbids a fixed canWrite=true, which the Dart agent ships.
   * The main end reads this field to decide whether to offer a write at all, so
   * advertising true and refusing later is what leaves a half-copied file. */
  assert.match(PROVIDER, /canWrite: info\.canWrite && !readOnly/,
    'a read-only share must advertise canWrite=false even for a writable file');
  assert.match(codeOf(PROVIDER), /throw Zft2Error\(code: "permission_denied", message: "Not writable: "/);

  /* access(2), not the mode bits: mode bits ignore ACLs, a read-only mount and the
   * sandbox itself. */
  assert.match(POSIX, /canRead: access\(absolutePath, R_OK\) == 0/);
  assert.match(POSIX, /canWrite: access\(absolutePath, W_OK\) == 0/);
  assert.doesNotMatch(codeOf(POSIX), /canWrite: true/, 'never a constant');
});

test('a symlink is detected without following it', () => {
  /* lstat, not stat: FileManager.attributesOfItem and stat(2) both follow the final
   * link, so neither can answer "is this node itself a link" -- the question the
   * jail turns on. */
  assert.match(POSIX, /guard lstat\(absolutePath, &status\) == 0 else \{ return nil \}/);
  assert.match(POSIX, /let isSymlink = mode == S_IFLNK/);
  assert.match(SEAM, /public let isSymlink: Bool/, 'the seam must carry the link flag');

  /* And the provider must act on it: an escaping link is dropped from a listing
   * rather than advertised as a file the peer then cannot open. */
  const listBody = codeOf(PROVIDER).slice(
    codeOf(PROVIDER).indexOf('public func list('),
    codeOf(PROVIDER).indexOf('public func stat('),
  );
  assert.match(listBody, /if child\.isSymlink \{/);
  assert.match(listBody, /VirtualPath\.isWithin\(root: fileSystem\.rootPath, candidate: resolved\)/);
});

test('reads and writes are positional so parallel reads cannot corrupt each other', () => {
  /* Reads on one handle stay concurrent (DEVELOPMENT.md 13.3) and share one
   * descriptor, so a shared stream position would interleave readers into each
   * other's data: corruption that looks like a network fault and only appears
   * under parallel readahead. */
  assert.match(POSIX, /pread\(descriptor,/);
  assert.match(POSIX, /pwrite\(descriptor,/);
  assert.doesNotMatch(codeOf(POSIX), /lseek|seek\(toOffset/, 'a seeking descriptor would race itself');

  /* No O_TRUNC. RDPDR delivers a large file as sequential writes on one handle, so
   * truncating on open would discard everything already written at a non-zero
   * offset. Truncation is an explicit operation. */
  assert.match(POSIX, /let flags = write \? O_RDWR : O_RDONLY/);
  assert.doesNotMatch(codeOf(POSIX), /O_TRUNC/);

  /* A zero-byte write is not progress; reporting it as such leaves the file
   * silently short. */
  assert.match(codeOf(POSIX), /throw Zft2Error\(code: "io_error", message: "Write made no progress"\)/);

  /* EINTR is retried rather than surfaced: a signal mid-transfer is not a failure,
   * and reporting one would abort a copy the kernel was willing to continue. */
  /* Counted, not merely present. Every blocking syscall here has to retry, and
   * a single match stayed green when the retry was removed from the read loop
   * while the one in the write loop kept it passing. read, write and truncate
   * are three sites. */
  const eintrRetries = (codeOf(POSIX).match(/errno == EINTR \{ continue \}/g) || []).length;
  assert.equal(
    eintrRetries,
    3,
    'read, write and truncate must each retry on EINTR, saw ' + eintrRetries,
  );
});

test('the security-scoped claim is balanced', () => {
  /* Unlike a SAF grant, a security-scoped URL is not ambiently readable: the claim
   * is reference-counted by the OS. Leaking one keeps a sandbox extension alive
   * after the user stopped the share; releasing one never taken unbalances a claim
   * someone else holds. */
  assert.match(PROVIDER, /private var accessClaims = 0/);
  assert.match(PROVIDER, /accessClaims \+= 1/);
  assert.match(
    PROVIDER,
    /while accessClaims > 0 \{\s*fileSystem\.endAccess\(\)\s*accessClaims -= 1/,
    'closeAll must release every claim it took',
  );
  assert.match(POSIX, /rootURL\.startAccessingSecurityScopedResource\(\)/);
  assert.match(POSIX, /rootURL\.stopAccessingSecurityScopedResource\(\)/);
});

test('platform error text never reaches the peer', () => {
  /* strerror and an NSError description both include the host path, and
   * SHARED_RESOURCE_RESIDENCY.md keeps device paths off the wire. */
  assert.match(POSIX, /static func mapErrno\(_ code: Int32, _ what: String\) -> Zft2Error/);
  assert.match(POSIX, /return Zft2Error\(code: wire, message: what\)/,
    'the wire message must be the caller-supplied text, not the platform message');
  assert.doesNotMatch(codeOf(POSIX), /strerror/);
  assert.doesNotMatch(codeOf(POSIX), /localizedDescription/);
});

test('the grant chain re-derives validity instead of trusting stored state', () => {
  /* A bookmark goes stale when the directory moves and nothing notifies the app. A
   * share whose bookmark is stale must be reported invalid, not served. */
  assert.match(GRANTS, /public func grant\(profileId: String\) -> SecurityScopedGrant\?/);
  assert.match(GRANTS, /grantValid: live != nil && live!\.canRead && !live!\.isStale/,
    'a stale bookmark counts as invalid even though it may still resolve');
  assert.match(GRANTS, /readOnly: stored\.readOnly \|\| live == nil \|\| !\(live\?\.canWrite \?\? false\)/,
    'a downgraded grant must narrow the share and never widen it');
  assert.match(GRANTS, /public func pruneInvalid\(\) -> \[String\]/);

  /* Discarded on revoke, but only when no other profile uses the bookmark: two
   * shares over one directory is legal, and discarding on the first removal would
   * break the second. */
  /* Re-read AFTER the removal, not filtered from a pre-removal snapshot.
   *
   * Both shapes refuse to discard a bookmark another profile uses, but only this
   * one cannot count the row being removed as that other profile -- which would
   * keep every bookmark alive forever and leave the app able to resolve a
   * directory the user removed from its own list. */
  assert.match(GRANTS, /rows\.remove\(profileId: profileId\)/);
  assert.match(
    GRANTS,
    /let stillUsed = rows\.rows\(\)\.contains \{ \$0\.bookmarkId == stored\.bookmarkId \}/,
    'the check must run against the store after the row was removed',
  );
  const revokeBody = codeOf(GRANTS).slice(codeOf(GRANTS).indexOf('func revoke(profileId:'));
  assert.ok(revokeBody.length > 0, 'revoke must be locatable');
  assert.ok(
    revokeBody.indexOf('rows.remove(profileId: profileId)') <
      revokeBody.indexOf('let stillUsed'),
    'the row must be removed before the remaining users are counted',
  );
  assert.match(GRANTS, /bookmarks\.discard\(bookmarkId: stored\.bookmarkId\)/);

  /* Both platforms must label an unnamed share alike, or one product shows two
   * different drive names for the same directory. */
  assert.match(GRANTS, /defaultShareName = "PHONE"/);
});

test('the platform seam keeps the provider logic testable off-device', () => {
  /* The split is why the jail and the read-only rules have XCTest coverage at all.
   * If the provider imported Darwin directly, none of it could be exercised
   * without a device, and nothing in this repository runs one. */
  assert.doesNotMatch(codeOf(PROVIDER), /import Darwin/, 'the provider must not reach the syscalls');
  assert.doesNotMatch(codeOf(PROVIDER), /FileManager/, 'nor the filesystem directly');
  assert.doesNotMatch(codeOf(SEAM), /import Darwin/, 'the seam must stay platform-free');
  assert.match(POSIX, /import Darwin/);
  assert.match(POSIX, /public final class PosixSecurityScopedFileSystem: SecurityScopedFileSystem \{/);
});

test('the XCTest suites cover the attacks DEVELOPMENT.md 19.6 names', () => {
  /* These run only on the macOS runner, so their presence is asserted here. Each
   * corresponds to a listed attack: path traversal, symlink escape, hostile file
   * names, huge directories, handle leaks. */
  const providerTests = read(TESTS, 'SecurityScopedFileProviderTests.swift');
  for (const name of [
    'testTraversalIsRejectedBeforeAnythingIsJoined',
    'testASymlinkOutOfTheRootIsRefusedNotFollowed',
    'testALinkInTheMiddleOfAPathCannotCarryTheResolutionOut',
    'testAContainedSymlinkStillWorks',
    'testCreatingThroughAnEscapingLinkIsRefused',
    'testASiblingOfTheRootIsNotReachableEvenWhenItsNamePrefixMatches',
    'testListSkipsNamesTheWireCouldNotAddress',
    'testListDropsEscapingLinksInsteadOfAdvertisingThem',
    'testListIsBoundedSoAHugeDirectoryCannotExhaustMemory',
    'testEveryMutatingOperationIsRefusedOnAReadOnlyShare',
    'testAHandleOpenedForReadingCannotBeWrittenThrough',
    'testHandlesAreUnpredictable',
    'testHandleCountIsBoundedAndNoDescriptorLeaksWhenRefused',
    'testCloseAllReleasesEveryDescriptorAndClaim',
    'testWriteDoesNotTruncateUnlessAskedTo',
    'testDeleteRefusesANonEmptyDirectoryUnlessRecursive',
  ]) {
    assert.match(providerTests, new RegExp('func ' + name + '\\('), 'missing coverage: ' + name);
  }

  const grantsTests = read(TESTS, 'SecurityScopedGrantsTests.swift');
  for (const name of [
    'testAReadOnlyGrantNarrowsTheShareEvenWhenTheConfigAskedForWrite',
    'testAStaleBookmarkIsReportedInvalidRatherThanMissing',
    'testRevokingOneOfTwoSharesOverTheSameBookmarkKeepsIt',
    'testPruningDropsInvalidSharesAndNamesThem',
    'testContainmentIsPrefixSafeAtASegmentBoundary',
  ]) {
    assert.match(grantsTests, new RegExp('func ' + name + '\\('), 'missing coverage: ' + name);
  }

  /* The fake has to model symlinks, or the escape tests assert nothing. */
  const fakes = read(TESTS, 'FileProviderFakes.swift');
  assert.match(fakes, /func addSymlink\(/, 'the fake filesystem must be able to hold a link');
  assert.match(fakes, /var linkTarget: String\?/);
  assert.match(fakes, /func canonicalPath\(of absolutePath: String\) throws -> String\?/);
});


test('BookmarkStore has a real implementation, not only a test fake', () => {
  /* The gap this closes. BookmarkStore was a protocol with a single implementation
   * in the test target, so SecurityScopedGrants could hold a grant in memory and
   * nothing more: on a device the app forgot every authorised directory on the next
   * launch while the user believed the share was still set up. */
  assert.ok(fs.existsSync(path.join(CORE, 'PersistentBookmarkStore.swift')));
  assert.match(BOOKMARKS, /public final class PersistentBookmarkStore: BookmarkStore \{/);

  /* A bookmark, never a path. A container path changes between installs, an iCloud or
   * external directory can move, and a raw path carries no sandbox extension -- so
   * reading through one fails even where the user granted access. */
  assert.match(BOOKMARKS, /url\.bookmarkData\(/);
  assert.match(BOOKMARKS, /URL\(\s*resolvingBookmarkData: data,/);

  /* .withSecurityScope is macOS-only and throws on iOS, and resolving with different
   * options than were used to mint fails. Both calls must pass []. */
  assert.doesNotMatch(codeOf(BOOKMARKS), /withSecurityScope/);
});

test('a stale bookmark is recorded rather than treated as usable', () => {
  /* A stale bookmark still resolves today, which is exactly the trap: the correct
   * response is to re-create it, and until then the share counts as invalid.
   * DEVELOPMENT.md 13.5 has iOS re-verify before reconnecting. */
  assert.match(BOOKMARKS, /bookmarkDataIsStale: &isStale/);
  assert.match(BOOKMARKS, /staleIds\.insert\(identifier\)/);
  assert.match(BOOKMARKS, /isStale: staleIds\.contains\(identifier\)/);

  /* Resolved eagerly at construction so stored() reports staleness from the first
   * call. Discovering it on the first READ means the remote already opened a folder. */
  assert.match(BOOKMARKS, /private func loadAll\(\)/);

  /* A bookmark that cannot resolve is NOT discarded: a volume can be temporarily
   * absent, and deleting the row would lose a grant the user gets back by
   * reattaching it. It simply does not appear in stored(), which reads as invalid. */
  const resolveBody = codeOf(BOOKMARKS).slice(codeOf(BOOKMARKS).indexOf('func resolveFromStore'));
  assert.ok(resolveBody.length > 0, 'resolveFromStore must be locatable');
  assert.doesNotMatch(resolveBody.slice(0, 900), /discard\(/);
});

test('a bookmark cannot be invented for a URL the user never picked', () => {
  /* persist() confirms an existing row rather than minting. Minting only works while
   * the picker's grant is live, so a persist() that minted would either fail or,
   * worse, appear to authorise a directory the user never handed over. */
  const persistBody = codeOf(BOOKMARKS).slice(
    codeOf(BOOKMARKS).indexOf('public func persist(bookmarkId:'),
    codeOf(BOOKMARKS).indexOf('public func discard('),
  );
  assert.ok(persistBody.length > 0, 'persist must be locatable');
  assert.doesNotMatch(persistBody, /bookmarkData\(/, 'persist must not mint');
  assert.match(persistBody, /guard store\.data\(Self\.dataKey\(bookmarkId\)\) != nil else \{ return nil \}/);

  /* And it cannot widen a read-only bookmark by asking for write. */
  assert.match(persistBody, /canWrite: allowWrite && granted/);
});

test('an authorised directory survives a relaunch on iOS too', () => {
  /* The same guarantee PersistentShareStore gives on Android. Both platforms lost it
   * for different reasons and both needed it written down separately. */
  assert.match(ROWS, /public final class PersistentShareRowStore: ShareRowStore \{/);
  assert.match(ROWS, /public final class InMemoryShareRowStore: ShareRowStore \{/);

  /* Injected, with the in-memory default preserved so the existing lifecycle suites
   * keep working and cannot leak state into each other. */
  assert.match(
    GRANTS,
    /public init\(bookmarks: BookmarkStore, rows: ShareRowStore = InMemoryShareRowStore\(\)\)/,
  );
  assert.match(GRANTS, /rows\.put\(grant\)/, 'authorize must write through');

  /* Validity is re-derived on every read, so persisting false would outlive its cause
   * and leave the share broken after the user re-granted the directory. */
  assert.match(ROWS, /grantValid: true/);
  assert.doesNotMatch(codeOf(ROWS), /grantValid: false/);

  /* A row that lost its write flag reads as read-only: the strictest reading is the
   * safe one. */
  assert.match(ROWS, /readOnly: store\.boolean\(Self\.readOnlyKey\(profileId\), default: true\)/);
});

test('iOS persistence sits behind the same kind of seam Android uses', () => {
  /* UserDefaults is a Foundation singleton whose behaviour depends on a process
   * container, so code written against it directly can only run on a device. Only the
   * macOS runner compiles this tree at all, so the seam is the difference between
   * rules that are tested and rules that are merely written down. */
  assert.match(KV, /public protocol KeyValueStore: AnyObject \{/);
  assert.doesNotMatch(codeOf(ROWS), /UserDefaults/);
  assert.doesNotMatch(codeOf(BOOKMARKS), /UserDefaults/);
  assert.match(KV, /public final class UserDefaultsKeyValueStore: KeyValueStore \{/);

  /* object(forKey:) first: bool(forKey:) cannot tell a stored false from an absent
   * key, and the read-only default depends on that difference. */
  assert.match(KV, /guard defaults\.object\(forKey: key\) != nil else \{ return defaultValue \}/);

  /* An explicit suite, and a failable init rather than a silent fall back to
   * .standard, where rows would be written somewhere the next launch does not look. */
  assert.match(KV, /public convenience init\?\(suiteName: String\)/);
  assert.match(BOOKMARKS, /public static let suiteName = /);
});

test('the per-connection choice is device-local on iOS', () => {
  /* DEVELOPMENT.md 3 and 13.2: a profile id names a bookmark that resolves on exactly
   * one device, so syncing it would hand the other device a row it cannot resolve. */
  assert.match(ROWS, /public final class ConnectionShareChoices \{/);
  assert.match(ROWS, /public func pruneMissing\(knownProfileIds: Set<String>\) -> \[String\]/);

  /* Forgetting a choice must not release the bookmark: other connections may share it.
   *
   * Scoped to the function body rather than a fixed number of characters. A fixed
   * slice ran into the next declaration, whose `@discardableResult` attribute
   * contains the substring "discard", so the assertion failed on an attribute
   * instead of on anything forget() does. */
  const rowsCode = codeOf(ROWS);
  const forgetAt = rowsCode.indexOf('public func forget(connectionId:');
  assert.ok(forgetAt >= 0, 'forget must be locatable');
  const forgetBody = rowsCode.slice(forgetAt, rowsCode.indexOf('\n    }', forgetAt));
  assert.ok(forgetBody.length > 0, 'the forget body must be locatable');
  assert.doesNotMatch(
    forgetBody,
    /discard\(|bookmarkId/,
    'forget must clear the choice without touching the bookmark',
  );
  /* And it does clear the choice, or "ask again" would never happen. */
  assert.match(forgetBody, /writer\.remove\(Self\.key\(connectionId\)\)/);
});

test('revoking re-reads the rows before discarding a bookmark', () => {
  /* Counting remaining users from a pre-removal snapshot would find the row being
   * removed, so no bookmark would ever be discarded and the app would stay able to
   * resolve a directory the user removed from its own list. */
  const revoke = codeOf(GRANTS).slice(codeOf(GRANTS).indexOf('public func revoke(profileId:'));
  assert.ok(revoke.length > 0, 'revoke must be locatable');
  assert.ok(
    revoke.indexOf('rows.remove(profileId: profileId)') < revoke.indexOf('let stillUsed'),
    'the row must be removed before the remaining users are counted',
  );
});

test('the iOS persistence rules have XCTest coverage', () => {
  const suite = read(TESTS, 'PersistentShareRowStoreTests.swift');
  for (const name of [
    'testAnAuthorisedDirectorySurvivesARelaunch',
    'testAReadOnlyShareIsStillReadOnlyAfterARelaunch',
    'testValidityIsNeverPersistedAsFalse',
    'testRevokingRemovesTheRowFromStorageToo',
    'testRevokingOneOfTwoSharesOverOneBookmarkKeepsIt',
    'testARowWhoseBookmarkIdWasLostIsDropped',
    'testARowMissingItsWriteFlagIsAssumedReadOnly',
    'testARowIsWrittenAsOneBatch',
    'testPruningDropsInvalidRowsFromStorage',
    'testTheDefaultStoreIsStillInMemory',
    'testPruningDropsChoicesNamingAProfileThatIsGone',
  ]) {
    assert.match(suite, new RegExp('func ' + name + '\\('), 'missing coverage: ' + name);
  }

  /* The fakes have to model a restart and a re-created bookmark, or none of the
   * persistence tests assert anything. */
  const kvFake = read(TESTS, 'FakeKeyValueStore.swift');
  assert.match(kvFake, /func surviveRestart\(\) -> FakeKeyValueStore/);
  assert.match(read(TESTS, 'FileProviderFakes.swift'), /func refresh\(_ bookmarkId: String\)/);
});
test('the new Swift is ASCII-only', () => {
  /* Not style. Non-ASCII literals have been destroyed repeatedly by a shell
   * boundary in this environment, and a mangled string in a path check is a
   * security change that compiles fine. */
  for (const dir of [CORE, TESTS]) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.swift'))) {
      const source = read(dir, name);
      const offenders = [...source].filter((ch) => ch.codePointAt(0) > 127);
      assert.equal(offenders.length, 0, name + ' contains non-ASCII: ' + offenders.slice(0, 6).join(''));
    }
  }
});
