/*
 * Static resolution gate for the iOS tree.
 *
 * `swift build` needs a Swift toolchain, which exists only on the macOS CI
 * runner, so on every other machine the Swift in this repository is unverified
 * text. That is precisely the situation the Android tree was in before
 * zephyr-one-mobile.yml existed, and it let four symbols sit in the tree that
 * were referenced but never declared -- each a hard compile error the moment a
 * build was attempted.
 *
 * This is not a substitute for compiling. It answers the cheap questions a
 * compiler answers first: does the package manifest describe directories that
 * actually exist, does every target have sources, and does every type the code
 * references exist somewhere in the tree? Those are the failures that ship when
 * nobody has run a compiler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IOS_ROOT = path.join(MOBILE_ROOT, 'ios');

function swiftFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.build' || entry.name === 'build') continue;
      out.push(...swiftFiles(full));
    } else if (entry.name.endsWith('.swift')) {
      out.push(full);
    }
  }
  return out;
}

/* Strips comments and string literals so a name inside prose is never counted as
 * a reference. The multiline-literal pattern is built with `new RegExp` rather
 * than written inline purely so this file does not contain a bare triple quote. */
const MULTILINE_STRING = new RegExp('"{3}[\\s\\S]*?"{3}', 'g');

function stripNoise(source) {
  return stripComments(source)
    .replace(MULTILINE_STRING, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/* Comments only, string literals preserved.
 *
 * Needed separately from stripNoise() because the wire-protocol error codes are
 * string literals: an assertion about the order in which `decode` reports
 * `truncated_header` versus `bad_magic` has to see those strings, while still
 * ignoring the doc comment above the function that names them in prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

const MANIFEST = fs.readFileSync(path.join(IOS_ROOT, 'Package.swift'), 'utf8');

/* SwiftPM convention, not a choice this repo makes: a target's sources live in
 * Sources/<target> and a test target's in Tests/<target>. A manifest naming a
 * target with no such directory fails at resolution, before any type checking. */
const TARGET_DIRS = {
  ZephyrContracts: path.join(IOS_ROOT, 'Sources', 'ZephyrContracts'),
  ZephyrCore: path.join(IOS_ROOT, 'Sources', 'ZephyrCore'),
  ZephyrUI: path.join(IOS_ROOT, 'Sources', 'ZephyrUI'),
  ZephyrCoreTests: path.join(IOS_ROOT, 'Tests', 'ZephyrCoreTests'),
  ZephyrUITests: path.join(IOS_ROOT, 'Tests', 'ZephyrUITests'),
};

const parsed = swiftFiles(IOS_ROOT).map((file) => ({
  file,
  rel: path.relative(MOBILE_ROOT, file).split(path.sep).join('/'),
  clean: stripNoise(fs.readFileSync(file, 'utf8')),
}));

/** Every top-level type declared in the tree. */
const declared = new Set();
const DECL = /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+|final\s+|open\s+|indirect\s+)*(?:struct|class|enum|protocol|actor|extension|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/;
for (const { clean } of parsed) {
  for (const line of clean.split(/\r?\n/)) {
    const match = line.match(DECL);
    if (match) declared.add(match[1]);
  }
}

test('the iOS package is a real SwiftPM package', () => {
  /* The manifest is what turns this directory from loose text into something a
   * compiler can be pointed at. Before it existed, mobile/ios held six generated
   * files and no way to build them. */
  assert.ok(fs.existsSync(path.join(IOS_ROOT, 'Package.swift')), 'Package.swift must exist');
  assert.match(MANIFEST, /swift-tools-version:\s*5\.\d+/, 'a tools version is required');
  assert.match(MANIFEST, /name:\s*"ZephyrOne"/);
  assert.match(MANIFEST, /\.macOS\(/, 'swift test builds for the host; macOS must be declared');
  assert.match(MANIFEST, /\.iOS\(/, 'iOS is the product target');
});

test('every target the manifest declares has sources on disk', () => {
  for (const [target, dir] of Object.entries(TARGET_DIRS)) {
    assert.match(MANIFEST, new RegExp('name:\\s*"' + target + '"'), target + ' must be declared');
    assert.ok(fs.existsSync(dir), target + ' is declared but ' + dir + ' does not exist');
    assert.ok(swiftFiles(dir).length > 0, target + ' has no Swift sources');
  }
});

test('the native crypto and encrypted database dependencies are supply-chain pinned', () => {
  /* iOS 15 CryptoKit has no ML-KEM implementation, and system SQLite has no
   * page encryption. Both reviewed binary packages are pinned to immutable
   * manifest commits whose binary targets carry XCFramework checksums. */
  const packages = [...MANIFEST.matchAll(/\.package\(/g)];
  assert.equal(packages.length, 2, 'only the audited ML-KEM and SQLCipher packages are allowed');
  assert.match(
    MANIFEST,
    /url:\s*"https:\/\/github\.com\/krzyzanowskim\/OpenSSL-Package\.git"[\s\S]*revision:\s*"0b0cc7392a4ff6a798c9ed8f4981f1c1bbcb4722"/,
  );
  assert.match(MANIFEST, /\.product\(name:\s*"OpenSSL",\s*package:\s*"OpenSSL-Package"\)/);
  assert.match(
    MANIFEST,
    /6c4b064d12b8de2ae77ac59fbcbbd1c20b4fecfb7fc50b8ab326347c52ecbf0c/,
    'the reviewed XCFramework checksum must remain documented beside the pin',
  );
  assert.match(
    MANIFEST,
    /url:\s*"https:\/\/github\.com\/zhuorantan\/SQLiteCipher\.git"[\s\S]*revision:\s*"70589046bd800e3db5c0155a558a9bc7a9f260ef"/,
  );
  assert.match(MANIFEST, /\.product\(name:\s*"SQLiteCipher",\s*package:\s*"SQLiteCipher"\)/);
  assert.match(
    MANIFEST,
    /cb13b28fecf0d651a451d29545f4904af7c2781e9774c1d4da2cd442126f420b/,
    'the reviewed SQLCipher XCFramework checksum must remain documented beside the pin',
  );
  assert.match(MANIFEST, /f0b61023394fbcf3c52877f4bef371c32f4098704668a5986992bcad8ce31c03/);
  assert.doesNotMatch(MANIFEST, /linkedLibrary\("sqlite3"\)/, 'system SQLite must not back the mirror');
  assert.doesNotMatch(MANIFEST, /\bfrom:\s*"/, 'crypto dependencies must not use a version range');

  const notices = fs.readFileSync(path.join(IOS_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /SQLCipher 4\.10\.0/);
  assert.match(notices, /SQLite 3\.50\.4/);
  assert.match(notices, /cb13b28fecf0d651a451d29545f4904af7c2781e9774c1d4da2cd442126f420b/);
  assert.match(notices, /f0b61023394fbcf3c52877f4bef371c32f4098704668a5986992bcad8ce31c03/);
  assert.match(notices, /Copyright \(c\) 2025, ZETETIC LLC/);
});

test('the iOS sync mirror is SQLCipher keyed, owner-migrated, and lifecycle-erased', () => {
  const repository = fs.readFileSync(
    path.join(TARGET_DIRS.ZephyrCore, 'SQLiteSyncRepository.swift'),
    'utf8',
  );
  const keyStore = fs.readFileSync(
    path.join(TARGET_DIRS.ZephyrCore, 'KeychainSyncDatabaseKeyStore.swift'),
    'utf8',
  );
  const binding = fs.readFileSync(
    path.join(TARGET_DIRS.ZephyrCore, 'MobileBindingCoordinator.swift'),
    'utf8',
  );
  const repositoryTests = fs.readFileSync(
    path.join(TARGET_DIRS.ZephyrCoreTests, 'SQLiteSyncRepositoryTests.swift'),
    'utf8',
  );
  const keyTests = fs.readFileSync(
    path.join(TARGET_DIRS.ZephyrCoreTests, 'KeychainSyncDatabaseKeyStoreTests.swift'),
    'utf8',
  );

  assert.match(repository, /import SQLCipher/);
  assert.doesNotMatch(repository, /import SQLite3/);
  assert.match(repository, /PRAGMA key =/);
  assert.match(repository, /PRAGMA cipher_integrity_check/);
  assert.match(repository, /SQLite format 3\\u\{0\}/);
  assert.match(repository, /FileProtectionType\.complete/);
  assert.doesNotMatch(repository, /completeUntilFirstUserAuthentication/);

  for (const component of ['serverID', 'accountID', 'deviceID', 'generation']) {
    assert.match(keyStore, new RegExp('public let ' + component + ': String'));
  }
  assert.match(keyStore, /keyByteCount = 32/);
  assert.match(keyStore, /whenUnlockedThisDeviceOnly/);
  assert.match(keyStore, /addGenericPasswordIfAbsent/);

  assert.match(repository, /SELECT server_id, account_id, device_id, generation FROM sync_state/);
  assert.match(repository, /\.migrating/);
  assert.doesNotMatch(repository, /PRAGMA rekey =/);
  assert.match(repository, /ATTACH DATABASE \? AS encrypted KEY \?/);
  assert.match(repository, /SELECT sqlcipher_export\('encrypted'\)/);
  assert.match(
    repository,
    /SQLiteDatabase\(url: stagingURL, key: key, createNew: false\)/,
    'validated migration staging must be reopened without CREATE',
  );
  assert.match(
    repository,
    /requireEncryptedHeader\(at: stagingURL\)[\s\S]{0,160}hooks\(\.encryptedCopyReady\)/,
    'the encrypted staging header must be verified before any crash hook can promote it',
  );
  assert.match(repository, /encryptedCopyReady/);
  assert.match(repository, /beforePromotion/);

  const checkpoint = repository.indexOf('PRAGMA wal_checkpoint(TRUNCATE)');
  const fileDelete = repository.indexOf('removeDatabaseArtifacts(at: databaseURL)');
  const keyDelete = repository.indexOf('keyStore.deleteKey(for: keyScope)');
  assert.ok(checkpoint >= 0 && checkpoint < fileDelete && fileDelete < keyDelete);
  assert.match(
    binding,
    /prepared\.credentials\.terminateLease\(cleanupLease\)[\s\S]{0,1600}try await prepared\.cleanupFailedRuntimeCreation\(cleanupIdentity\)/,
    'the terminal credential tombstone must gate exact-identity partial database cleanup',
  );

  for (const phrase of ['WrongKey', 'CrashRetryable', 'Sidecars', 'UnprovenOwner']) {
    assert.match(repositoryTests, new RegExp(phrase));
  }
  for (const phrase of ['IndependentUnlockedOnlyKey', 'DuplicateInsert', 'GenerationScoped']) {
    assert.match(keyTests, new RegExp(phrase));
  }
});

test('the hand-written core is separate from the generated contracts', () => {
  /* Two targets rather than one, so a codegen change that breaks compilation
   * fails in ZephyrContracts rather than somewhere inside application code. */
  const generated = swiftFiles(TARGET_DIRS.ZephyrContracts);
  assert.ok(generated.length >= 6, 'expected the six generated contract files');
  for (const file of generated) {
    assert.match(
      fs.readFileSync(file, 'utf8'),
      /GENERATED FILE - DO NOT EDIT/,
      path.basename(file) + ' must stay generated',
    );
  }

  const core = swiftFiles(TARGET_DIRS.ZephyrCore);
  const names = core.map((f) => path.basename(f));
  for (const expected of ['MobileAad.swift', 'Zft2Codec.swift', 'Zft2Meta.swift']) {
    assert.ok(names.includes(expected), expected + ' must exist in ZephyrCore');
  }
  for (const file of core) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /GENERATED FILE/,
      path.basename(file) + ' is hand-written and must not claim to be generated',
    );
  }
});

test('every type the Swift references is declared somewhere in the tree', () => {
  /* The Android equivalent of this test is what caught ZephyrOneRoot,
   * AccountContainer, ZephyrApplication and SecretStore.SecretScope. The same
   * class of error is possible here and would surface only on the macOS runner. */
  /* Names that come from the platform or the toolchain rather than from this
   * tree. An explicit list, not a heuristic: a pattern such as "starts with
   * XCT" would also swallow a genuinely missing type, and the whole point is to
   * find those. */
  const PLATFORM = new Set([
    // modules
    'Foundation', 'CryptoKit', 'Security', 'SQLCipher', 'Network', 'BackgroundTasks',
    'OpenSSL',
    'XCTest', 'PackageDescription',
    // the package's own modules, which are imported rather than declared
    ...Object.keys(TARGET_DIRS),
    // standard library
    'Data', 'String', 'Int', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'Bool', 'Double',
    'Error', 'Equatable', 'Sendable', 'Codable', 'CaseIterable', 'CustomStringConvertible',
    'ExpressibleByArrayLiteral', 'RawRepresentable', 'Hashable', 'Comparable',
    'Character', 'Unicode', 'UTF8', 'Array', 'Dictionary', 'Set', 'Optional',
    'Range', 'Substring',
    'Any', 'Self', 'Never', 'Void', 'Result', 'Scalar',
    'Encoder', 'Decoder', 'Encodable', 'Decodable', 'CodingKey', 'DecodingError',
    'CancellationError', 'CheckedContinuation', 'MainActor',
    // Foundation
    'URL', 'URLComponents', 'URLQueryItem', 'URLRequest', 'URLResponse',
    'HTTPURLResponse', 'URLError', 'URLSession', 'URLSessionConfiguration',
    'URLSessionTask', 'URLSessionDataTask', 'URLSessionTaskDelegate', 'URLSessionDataDelegate',
    'URLProtocol', 'ResponseDisposition', 'URLAuthenticationChallenge',
    'AuthChallengeDisposition', 'URLCredential', 'NSURLAuthenticationMethodServerTrust',
    'HTTPCookie', 'HTTPCookieStorage', 'URLCache', 'StoragePolicy', 'CharacterSet',
    'JSONSerialization', 'JSONEncoder', 'JSONDecoder', 'NSNumber', 'NSString', 'NSDictionary',
    'NSNull',
    'Date', 'DateFormatter', 'TimeInterval', 'TimeZone', 'Locale', 'UUID', 'NSObject',
    'NotificationCenter',
    // Network path observation and iOS opportunistic background scheduling.
    'NWPathMonitor',
    'BGTaskScheduler', 'BGTask', 'BGAppRefreshTaskRequest', 'BGProcessingTaskRequest',
    /* Reached only by UserDefaultsKeyValueStore, which is the one file allowed to
     * know how the file-sync rows are stored. Every rule above it is written
     * against the KeyValueStore seam so it can be tested without a container. */
    'UserDefaults',
    // CryptoKit
    'SHA256', 'P256', 'Signing', 'ECDSASignature',
    /* Security/CoreFoundation used by the device-local Keychain, Secure
     * Enclave signing identity and URLSession server-trust delegate. */
    'OSStatus', 'CFTypeRef', 'CFDictionary', 'CFString', 'CFData', 'CFError', 'Unmanaged',
    'SecItemCopyMatching', 'SecItemUpdate', 'SecItemAdd', 'SecItemDelete',
    'SecAccessControlCreateWithFlags',
    'SecKey', 'SecKeyCreateRandomKey', 'SecKeyCopyAttributes', 'SecKeyCopyPublicKey',
    'SecKeyCopyExternalRepresentation', 'SecKeyIsAlgorithmSupported', 'SecKeyCreateSignature',
    'SecTrust', 'SecPolicyCreateSSL', 'SecTrustSetPolicies', 'SecTrustEvaluateWithError',
    'SecTrustGetCertificateCount', 'SecTrustGetCertificateAtIndex', 'SecCertificateCopyData',
    /* ZephyrUI is the SwiftUI presentation layer. The product rules it
     * renders are Foundation/Combine-only so the macOS CI host can test them;
     * the views themselves are compiled but not run there, and they are the
     * only files allowed to name these modules. */
    'Combine', 'SwiftUI', 'UIKit',
    // Combine
    'ObservableObject', 'Published', 'ObservedObject',
    /* SwiftUI view surface. The floors are iOS 15 / macOS 12, so the names
     * here are deliberately the long-stable half of the framework:
     * NavigationView rather than NavigationStack, no LabeledContent, no
     * ` searchable`. A name that needs a newer SDK does not belong on this
     * list until the manifest floors move. */
    'View', 'Text', 'Image', 'Label', 'Button', 'Toggle', 'Picker', 'Stepper',
    'Slider', 'TextField', 'SecureField', 'List', 'Form', 'Section', 'Group',
    'HStack', 'VStack', 'Spacer', 'ForEach', 'ProgressView', 'EmptyView',
    'AnyView', 'NavigationView', 'NavigationLink', 'TabView', 'ToolbarItem',
    'State', 'StateObject', 'Environment', 'Binding', 'ViewBuilder', 'FocusState',
    /* The UIKit bridge behind canImport(UIKit): the interactive pop gesture
     * recognizer is re-enabled, never replaced, per MOBILE_EXPERIENCE.md. */
    'UIViewControllerRepresentable', 'UIViewController', 'UINavigationController',
    'UIApplication',
    'Context',
    // more standard library / Foundation reached by the presentation layer
    'Task', 'AnyHashable', 'WritableKeyPath', 'Identifiable', 'NSLock', 'DispatchQueue',
    /* Generic parameter names. The matcher reads `PageState<Value>` as a type
     * reference and there is no declaration syntax it can see for a type
     * parameter, so the one name in use is listed here rather than weakening
     * the check with a heuristic. */
    'Value', 'Element', 'T', 'Type',
    /* Darwin / POSIX, used by PosixSecurityScopedFileSystem.
     *
     * The iOS provider reaches the filesystem through syscalls rather than
     * FileManager attributes: only lstat can answer "is this node itself a
     * symlink", which is the question the containment jail turns on, and only
     * access(2) gives the kernel's own readability answer rather than a guess
     * from the mode bits. Listed explicitly, like every other entry here, so a
     * genuinely missing type is still caught. */
    'Darwin',
    'S_IFMT', 'S_IFLNK', 'S_IFDIR', 'S_IFREG',
    'R_OK', 'W_OK',
    'O_CREAT', 'O_EXCL', 'O_WRONLY', 'O_RDWR', 'O_RDONLY', 'O_NOFOLLOW',
    'O_CLOEXEC', 'O_NONBLOCK', 'O_TRUNC', 'O_DIRECTORY',
    'AT_SYMLINK_NOFOLLOW', 'AT_REMOVEDIR', 'RENAME_EXCL', 'RENAME_NOFOLLOW_ANY',
    'F_DUPFD_CLOEXEC', 'MAXNAMLEN',
    'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EEXIST', 'ENOSPC', 'EDQUOT',
    'ELOOP',
    'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EXDEV', 'EINTR',
    // Foundation and standard library reached by the same file
    'FileManager', 'FileHandle', 'FileProtectionType', 'URLResourceValues',
    'SecRandomCopyBytes',
    'Int32', 'UInt64', 'AnyObject', 'OpaquePointer', 'UnsafeMutablePointer', 'CChar',
    'UnsafeMutableRawPointer', 'UnsafeMutableRawBufferPointer', 'UnsafeRawBufferPointer',
    // OpenSSL 3.6.3 C API used only behind KeychainMLKEMIdentityStore.
    'ERR_clear_error', 'OPENSSL_cleanse',
    'EVP_PKEY_CTX_new_from_name', 'EVP_PKEY_CTX_new_from_pkey', 'EVP_PKEY_CTX_free',
    'EVP_PKEY_keygen_init', 'EVP_PKEY_keygen', 'EVP_PKEY_free',
    'EVP_PKEY_get_octet_string_param', 'EVP_PKEY_fromdata_init', 'EVP_PKEY_fromdata',
    'EVP_PKEY_encapsulate_init', 'EVP_PKEY_encapsulate',
    'EVP_PKEY_decapsulate_init', 'EVP_PKEY_decapsulate',
    'OSSL_KEYMGMT_SELECT_DOMAIN_PARAMETERS', 'OSSL_KEYMGMT_SELECT_OTHER_PARAMETERS',
    'OSSL_KEYMGMT_SELECT_PUBLIC_KEY', 'OSSL_KEYMGMT_SELECT_PRIVATE_KEY',
    'OSSL_PARAM_construct_octet_string', 'OSSL_PARAM_construct_end',
    // SQLite3 C module used by the durable, actor-isolated sync repository.
    'SQLITE_OPEN_CREATE', 'SQLITE_OPEN_READWRITE', 'SQLITE_OPEN_FULLMUTEX',
    'SQLITE_OPEN_NOFOLLOW',
    'SQLITE_OK', 'SQLITE_DONE', 'SQLITE_ROW',
    'SQLITE_INTEGER', 'SQLITE_FLOAT', 'SQLITE_TEXT', 'SQLITE_BLOB',
    /* #filePath / #line default arguments in the XCTest helpers, so a failure is
     * reported at the caller rather than inside the helper. */
    'StaticString', 'UInt',
    /* The stdlib's cryptographically secure generator. Used for ZFT2 handles,
     * which DEVELOPMENT.md 13.3 requires to be unguessable. */
    'SystemRandomNumberGenerator',
    // XCTest API surface used by the suites
    'XCTestCase', 'XCTUnwrap', 'XCTFail',
    'XCTAssertEqual', 'XCTAssertNotEqual', 'XCTAssertTrue', 'XCTAssertFalse',
    'XCTAssertNil', 'XCTAssertNotNil', 'XCTAssertThrowsError', 'XCTAssertNoThrow',
    'XCTAssertGreaterThan', 'XCTAssertGreaterThanOrEqual',
    'XCTAssertLessThan', 'XCTAssertLessThanOrEqual',
    // SwiftPM manifest
    'Package',
    // doc-comment markers that survive as bare words
    'MARK',
  ]);

  const referenced = new Map();
  for (const { rel, clean } of parsed) {
    if (rel.endsWith('Package.swift')) continue;
    for (const match of clean.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (PLATFORM.has(name) || declared.has(name)) continue;
      if (!referenced.has(name)) referenced.set(name, new Set());
      referenced.get(name).add(rel);
    }
  }

  const report = [...referenced.entries()]
    .map(([name, where]) => '  ' + name + '\n      ' + [...where].join('\n      '))
    .join('\n');
  assert.equal(
    referenced.size,
    0,
    'referenced but neither declared in the tree nor a known platform type:\n' + report,
  );
});

test('the test target reaches the real fixtures, not a copy', () => {
  /* A copy of the vectors inside Tests/ would be a second source of truth for
   * bytes four languages must agree on, and it would go stale silently. The
   * loader walks up to mobile/contracts/generated instead, and the walk has to
   * be right: an off-by-one is a runtime failure on the macOS runner and
   * invisible everywhere else. */
  const loader = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCoreTests, 'Fixtures.swift'), 'utf8');

  const deletions = (loader.match(/deletingLastPathComponent\(\)/g) || []).length;
  assert.equal(
    deletions,
    4,
    'Fixtures.swift sits at mobile/ios/Tests/ZephyrCoreTests/, so reaching mobile/ ' +
      'takes 4 deletions from the file path itself',
  );
  assert.match(loader, /appendingPathComponent\("contracts"\)/);
  assert.match(loader, /appendingPathComponent\("generated"\)/);
  assert.doesNotMatch(
    loader,
    /appendingPathComponent\("mobile"\)/,
    'the 4th deletion already lands in mobile/; appending it again resolves to mobile/mobile',
  );

  for (const name of ['aad-vectors.json', 'zft2-frames.json']) {
    assert.ok(
      !fs.existsSync(path.join(TARGET_DIRS.ZephyrCoreTests, name)),
      name + ' must not be copied into the test target',
    );
    assert.ok(
      fs.existsSync(path.join(MOBILE_ROOT, 'contracts', 'generated', name)),
      name + ' must exist to be loaded',
    );
  }
});

test('the Swift port asserts the same frozen vectors Kotlin does', () => {
  /* A Swift suite that did not read the shared fixtures would be asserting its
   * own opinion of the protocol, which is how two ports drift while both stay
   * green. */
  const aad = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCoreTests, 'MobileAadTests.swift'), 'utf8');
  const zft2 = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCoreTests, 'Zft2CodecTests.swift'), 'utf8');

  /* Named files, and the count matters: the AAD suite reads its vectors in three
   * separate tests (cases, mutation distinctness, rejects), so a single match
   * stayed green when one call was repointed at another file. */
  const aadLoads = aad.match(/Fixtures\.json\("aad-vectors\.json"\)/g) || [];
  assert.ok(
    aadLoads.length >= 3,
    `every AAD test must read the frozen vectors, saw ${aadLoads.length}`,
  );
  assert.doesNotMatch(
    aad,
    /Fixtures\.json\((?!"aad-vectors\.json")/,
    'the AAD suite must not read any fixture other than aad-vectors.json',
  );

  const zft2Loads = zft2.match(/Fixtures\.json\("zft2-frames\.json"\)/g) || [];
  assert.ok(
    zft2Loads.length >= 5,
    `every ZFT2 fixture-driven test must read the frozen frames, saw ${zft2Loads.length}`,
  );
  assert.doesNotMatch(
    zft2,
    /Fixtures\.json\((?!"zft2-frames\.json")/,
    'the ZFT2 suite must not read any fixture other than zft2-frames.json',
  );
  assert.match(aad, /vectors\["cases"\]/, 'the AAD cases must be read');
  assert.match(aad, /vectors\["rejects"\]/, 'the AAD rejects must be read');
  for (const key of ['frames', 'rejects', 'inflight', 'chunkNegotiation', 'writeOps']) {
    assert.match(zft2, new RegExp('fixture\\["' + key + '"\\]'), 'zft2 ' + key + ' must be read');
  }
});

test('the AAD port keeps the properties that make the binding load-bearing', () => {
  const source = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCore, 'MobileAad.swift'), 'utf8');

  /* Field validation is not defensive tidying. A field containing the NUL
   * separator could forge a different field split that joins to the same bytes,
   * which is an authentication bypass rather than a formatting problem. */
  assert.match(source, /separatorInField/, 'a NUL inside a field must be refused');
  assert.match(source, /\$0\.value == 0/, 'the NUL check must inspect the scalars');

  assert.match(source, /func constantTimeEquals/);
  const body = source.slice(source.indexOf('func constantTimeEquals'));
  const loop = body.slice(body.indexOf('for offset'), body.indexOf('return diff == 0'));
  assert.ok(loop.length > 0, 'the comparison loop must exist');
  assert.doesNotMatch(loop, /return/, 'an early return would leak how much of the AAD matched');
  assert.match(loop, /diff \|=/, 'differences must accumulate rather than short-circuit');

  /* Slice-safe indexing. Data slices keep the parent indices, so indexing both
   * operands with the same integer compares different logical positions -- and
   * only in production, where buffers are slices. */
  assert.match(loop, /a\.startIndex \+ offset/);
  assert.match(loop, /b\.startIndex \+ offset/);

  /* The purpose guard must actually gate. Matching only the `contains` call left
   * `guard true || ...contains(...)` green -- verified by mutation -- and that
   * spelling admits any purpose string, producing an AAD the server can never
   * rebuild. Asserted against the comment-stripped source so the guard's own
   * explanation cannot satisfy it. */
  const code = stripComments(source);
  assert.match(
    code,
    /guard SecretEnvelopeContract\.sharedPurposes\.contains\(input\.purpose\) else \{/,
    'the shared purpose must be checked by a bare guard, with nothing short-circuiting it',
  );
  const guardLine = code
    .split(/\r?\n/)
    .find((line) => line.includes('sharedPurposes.contains(input.purpose)'));
  assert.ok(guardLine, 'the purpose guard must exist');
  assert.doesNotMatch(guardLine, /\|\||&&|true|false/, 'the guard must not be short-circuited');
});

test('the ZFT2 port does not delegate metadata encoding to Foundation JSON', () => {
  /* The encoded length of the metadata lands in the frame header, so the
   * encoding must be exactly reproducible. JSONSerialization gives no order
   * guarantee, escapes forward slashes in some configurations, and round-trips
   * integers through Double. Any of those changes metaLen, and a desynchronised
   * metaLen makes the peer split the frame at the wrong offset. */
  const meta = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCore, 'Zft2Meta.swift'), 'utf8');
  const codec = fs.readFileSync(path.join(TARGET_DIRS.ZephyrCore, 'Zft2Codec.swift'), 'utf8');

  /* Compared against the comment-stripped source, because the doc comments
   * deliberately name JSONSerialization in order to explain why it is not used.
   * Matching the raw text would fail on the explanation itself. */
  const metaCode = stripComments(meta);
  const codecCode = stripComments(codec);

  assert.doesNotMatch(metaCode, /JSONSerialization/, 'metadata must not be encoded by JSONSerialization');
  assert.doesNotMatch(metaCode, /JSONEncoder/, 'nor by JSONEncoder');
  assert.doesNotMatch(codecCode, /JSONSerialization/);

  assert.match(
    metaCode,
    /pairs:\s*\[\(key: String, value: Zft2Value\)\]/,
    'metadata must be ordered pairs, not a Dictionary',
  );
  assert.doesNotMatch(
    metaCode,
    /\[String:\s*Zft2Value\]/,
    'a dictionary would discard the key order that is part of the wire bytes',
  );

  /* Check order in decode is load-bearing: the length-bomb fixture is both a
   * limit violation and a length mismatch, and must report the former. */
  const decode = codecCode.slice(codecCode.indexOf('public static func decode'));
  const truncatedAt = decode.indexOf('truncated_header');
  const magicAt = decode.indexOf('bad_magic');
  const metaLimitAt = decode.indexOf('metadata_too_large');
  const mismatchAt = decode.indexOf('length_mismatch');
  assert.ok(
    truncatedAt >= 0 && magicAt > truncatedAt,
    'a truncated header must be reported before magic can be checked',
  );
  assert.ok(
    metaLimitAt > 0 && mismatchAt > metaLimitAt,
    'the length limits must be checked before the total-length comparison',
  );
});

test('CI actually points a Swift compiler at this package', () => {
  /* The static gate above is the cheap half. It cannot type-check a call site,
   * so something has to run swiftc, and only the macOS runner can. Without this
   * job the package would be in exactly the state it was created to escape:
   * Swift in the repository that no compiler has ever read.
   *
   * Asserted here rather than in a desktop workflow test because this file is
   * the one that already reasons about the iOS tree, and a reviewer looking for
   * "who compiles the Swift" will look here first.
   */
  const workflow = fs.readFileSync(
    path.join(MOBILE_ROOT, '..', '..', '.github', 'workflows', 'zephyr-one-mobile.yml'),
    'utf8',
  );

  assert.match(workflow, /^\s{2}ios:$/m, 'an ios job must exist');
  assert.match(workflow, /runs-on:\s*macos-/, 'swiftc and the iOS SDK need a macOS runner');
  assert.match(workflow, /working-directory:\s*zephyr_one\/mobile\/ios/);
  assert.match(workflow, /swift build/, 'the package must be compiled');
  assert.match(workflow, /swift test/, 'and the fixture-driven suites must run');

  /* The path filter has to reach this tree, or the job never triggers on a change
   * to it. mobile/ios sits under this prefix. */
  assert.match(workflow, /zephyr_one\/mobile\/\*\*/, 'the workflow must trigger on mobile changes');

  /* The Android job must keep its own artefact upload. Appending the ios block in
   * the wrong place captured that step into the ios job once already -- the YAML
   * stayed valid and android silently stopped uploading reports, which is the
   * kind of break that is invisible until someone needs a failing test log. */
  const jobs = workflow.split(/^  (?=\w+:$)/m);
  const android = jobs.find((section) => section.startsWith('android:'));
  const ios = jobs.find((section) => section.startsWith('ios:'));
  assert.ok(android, 'the android job must exist');
  assert.ok(ios, 'the ios job must exist');
  assert.match(android, /Upload test reports/, 'the android job keeps its report upload');
  assert.doesNotMatch(ios, /android-test-reports/, 'the ios job must not carry android artefacts');
});
