// Emits Swift contract sources from mobile/contracts. Generated files are checked in so that
// SwiftPM/Xcode builds need no Node toolchain, and `node tools/generate.mjs --check` gates drift.
import {
  openapi, entityRegistry, errorRegistry, pushOrderedEntityTypes,
} from "./contracts.mjs";
import { SECRET_AAD_PREFIX, SHARED_AAD_PREFIX, HKDF_SALT_INPUT, SECRET_AAD_FIELDS, SHARED_AAD_FIELDS } from "./aad.mjs";
import * as zft2 from "./zft2.mjs";
import { BINDING_STATES, RUN_PHASES, FIRST_BIND_PHASES, NORMAL_PHASES, MAX_OPS_PER_BATCH, CONFLICT_RESOLUTIONS } from "./sync-core.mjs";

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.",
  "",
  "import Foundation",
  "",
].join("\n");

/** Swift string literal. */
function s(value) {
  return JSON.stringify(String(value));
}

function arr(values) {
  const items = values ?? [];
  if (items.length === 0) return "[]";
  return `[${items.map(s).join(", ")}]`;
}

function nullableStr(value) {
  return value === null || value === undefined ? "nil" : s(value);
}

/** lowerCamelCase Swift case name. UPPER_SNAKE, camelCase and kebab-case all normalise here. */
function caseName(value) {
  const words = String(value).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/);
  return words
    .map((raw) => (/^[A-Z0-9]+$/.test(raw) ? raw.toLowerCase() : raw))
    .map((word, index) => (index === 0
      ? word.charAt(0).toLowerCase() + word.slice(1)
      : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
}

/** UPPER_SNAKE for path constants, mirrored from the Kotlin generator. */
function pathCaseName(route, method) {
  const trimmed = route.replace(/^\/api\//, "").replace(/\{[^}]+\}/g, "by");
  const words = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const suffix = words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  return caseName(method) + suffix;
}

export function entityRegistrySwift() {
  const registry = entityRegistry();
  const out = [HEADER];
  out.push("/// One sync entity as frozen by contracts/registries/entity-registry.json.");
  out.push("public struct SyncEntitySpec: Sendable, Equatable {");
  out.push("    public let type: String");
  out.push("    public let source: String");
  out.push("    public let idField: String");
  out.push("    public let ownerField: String");
  out.push("    public let revisionField: String?");
  out.push("    public let deleteMode: String");
  out.push("    public let dependencyOrder: Int");
  out.push("    public let minimumClientVersion: Int");
  out.push("    public let editableFields: [String]");
  out.push("    public let secretFields: [String]");
  out.push("    public let serverAuthorityFields: [String]");
  out.push("    public let opaquePreserveFields: [String]");
  out.push("    public let deviceLocalFields: [String]");
  out.push("    public let capabilities: [String]");
  out.push("    public let status: String");
  out.push("");
  out.push("    /// Fields One must never name in a fieldMask.");
  out.push("    public var forbiddenMaskFields: [String] {");
  out.push("        secretFields + serverAuthorityFields + opaquePreserveFields + deviceLocalFields");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("public enum EntityRegistry {");
  out.push(`    public static let version = ${registry.version}`);
  out.push(`    public static let sourceCommit = ${s(registry.sourceCommit)}`);
  out.push("");
  out.push(`    public static let classification: [String] = ${arr(registry.classification)}`);
  out.push(`    public static let excludedEditableScopes: [String] = ${arr(registry.excludedEditableScopes)}`);
  out.push("");
  out.push("    public static let entities: [SyncEntitySpec] = [");
  for (const e of registry.entities) {
    out.push("        SyncEntitySpec(");
    out.push(`            type: ${s(e.type)},`);
    out.push(`            source: ${s(e.source)},`);
    out.push(`            idField: ${s(e.idField)},`);
    out.push(`            ownerField: ${s(e.ownerField)},`);
    out.push(`            revisionField: ${nullableStr(e.revisionField)},`);
    out.push(`            deleteMode: ${s(e.deleteMode)},`);
    out.push(`            dependencyOrder: ${e.dependencyOrder},`);
    out.push(`            minimumClientVersion: ${e.minimumClientVersion},`);
    out.push(`            editableFields: ${arr(e.editableFields)},`);
    out.push(`            secretFields: ${arr(e.secretFields)},`);
    out.push(`            serverAuthorityFields: ${arr(e.serverAuthorityFields)},`);
    out.push(`            opaquePreserveFields: ${arr(e.opaquePreserveFields)},`);
    out.push(`            deviceLocalFields: ${arr(e.deviceLocalFields)},`);
    out.push(`            capabilities: ${arr(e.capabilities ?? e.capabilityValues)},`);
    out.push(`            status: ${s(e.status)}`);
    out.push("        ),");
  }
  out.push("    ]");
  out.push("");
  out.push("    public static let byType: [String: SyncEntitySpec] = Dictionary(");
  out.push("        uniqueKeysWithValues: entities.map { (\$0.type, \$0) }");
  out.push("    )");
  out.push("");
  out.push("    /// Push topology order: dependencies first, ties broken by type name.");
  out.push(`    public static let pushOrder: [String] = ${arr(pushOrderedEntityTypes())}`);
  out.push("");
  out.push("    public static func spec(for type: String) throws -> SyncEntitySpec {");
  out.push("        guard let spec = byType[type] else { throw ContractError.unknownEntityType(type) }");
  out.push("        return spec");
  out.push("    }");
  out.push("");
  out.push("    public static func isEditableScope(_ scope: String) -> Bool {");
  out.push("        !excludedEditableScopes.contains(scope)");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("public enum ContractError: Error, Equatable {");
  out.push("    case unknownEntityType(String)");
  out.push("    case forbiddenMaskField(entityType: String, field: String)");
  out.push("    case unknownMaskField(entityType: String, field: String)");
  out.push("}");
  return out.join("\n") + "\n";
}

export function errorRegistrySwift() {
  const registry = errorRegistry();
  const out = [HEADER];
  out.push("/// Stable mobile v1 error code. Clients branch on `code`, never on `message`.");
  out.push("public struct MobileErrorSpec: Sendable, Equatable {");
  out.push("    public let code: String");
  out.push("    public let httpStatus: Int");
  out.push("    public let retryable: Bool");
  out.push("    public let clientAction: String");
  out.push("");
  out.push("    public init(_ code: String, _ httpStatus: Int, _ retryable: Bool, _ clientAction: String) {");
  out.push("        self.code = code");
  out.push("        self.httpStatus = httpStatus");
  out.push("        self.retryable = retryable");
  out.push("        self.clientAction = clientAction");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("public enum ErrorRegistry {");
  out.push(`    public static let version = ${registry.version}`);
  out.push("");
  out.push("    public static let errors: [MobileErrorSpec] = [");
  for (const e of registry.errors) {
    out.push(`        MobileErrorSpec(${s(e.code)}, ${e.httpStatus}, ${e.retryable}, ${s(e.clientAction)}),`);
  }
  out.push("    ]");
  out.push("");
  out.push("    public static let byCode: [String: MobileErrorSpec] = Dictionary(");
  out.push("        uniqueKeysWithValues: errors.map { (\$0.code, \$0) }");
  out.push("    )");
  out.push("");
  out.push("    public static func spec(for code: String) -> MobileErrorSpec? { byCode[code] }");
  out.push("");
  out.push("    /// Unknown codes are never silently retried.");
  out.push("    public static func isRetryable(_ code: String) -> Bool { byCode[code]?.retryable ?? false }");
  out.push("");
  out.push("    public static func clientAction(_ code: String) -> String {");
  out.push("        byCode[code]?.clientAction ?? \"report_unknown_error\"");
  out.push("    }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function apiPathsSwift() {
  const spec = openapi();
  const out = [HEADER];
  out.push("/// Paths taken verbatim from contracts/openapi-mobile-v1.json.");
  out.push("public enum MobileApiPaths {");
  out.push(`    public static let title = ${s(spec.info.title)}`);
  out.push(`    public static let version = ${s(spec.info.version)}`);
  out.push("    public static let protocolVersion = 1");
  out.push("");
  const seen = new Set();
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      const name = pathCaseName(route, method);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(`    public static let ${name} = ${s(route)}`);
    }
  }
  out.push("");
  out.push("    public static func deviceById(_ deviceId: String) -> String {");
  out.push("        \"/api/mobile/v1/devices/\" + deviceId");
  out.push("    }");
  out.push("");
  out.push("    public static func sharedResource(_ resourceType: String, _ resourceId: String) -> String {");
  out.push("        \"/api/mobile/v1/shared/\" + resourceType + \"/\" + resourceId");
  out.push("    }");
  out.push("");
  out.push("    public static func sharedSession(_ sessionId: String) -> String {");
  out.push("        \"/api/mobile/v1/shared/sessions/\" + sessionId");
  out.push("    }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function syncContractSwift() {
  const registry = entityRegistry();
  const capabilities = registry.entities.find((e) => e.type === "resourceAcl").capabilityValues;
  const fileSync = registry.entities.find((e) => e.type === "fileSyncConfig");
  const out = [HEADER];
  out.push("/// Persisted binding state from SYNC_STATE_MACHINE.md section 1.");
  out.push("public enum BindingState: String, Sendable, CaseIterable, Codable {");
  for (const state of BINDING_STATES) out.push(`    case ${caseName(state)} = ${s(state)}`);
  out.push("");
  out.push("    public var isBound: Bool { self != .unbound }");
  out.push("");
  out.push("    public var canRunSync: Bool {");
  out.push("        switch self {");
  out.push("        case .unbound, .revoked, .fatalIncompatible, .reauthRequired: return false");
  out.push("        default: return true");
  out.push("        }");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("/// Runtime phase from SYNC_STATE_MACHINE.md section 2.");
  out.push("public enum SyncPhase: String, Sendable, CaseIterable, Codable {");
  for (const phase of RUN_PHASES) out.push(`    case ${caseName(phase)} = ${s(phase)}`);
  out.push("}");
  out.push("");
  out.push("public enum SyncAction: String, Sendable, CaseIterable, Codable {");
  out.push("    case upsert");
  out.push("    case delete");
  out.push("    case restore");
  out.push("}");
  out.push("");
  out.push("public enum PushStatus: String, Sendable, CaseIterable, Codable {");
  out.push("    case accepted");
  out.push("    case duplicate");
  out.push("    case conflict");
  out.push("    case rejected");
  out.push("    case dependencyMissing = \"dependency_missing\"");
  out.push("}");
  out.push("");
  out.push("public enum ConflictResolution: String, Sendable, CaseIterable, Codable {");
  for (const resolution of CONFLICT_RESOLUTIONS) out.push(`    case ${caseName(resolution)} = ${s(resolution)}`);
  out.push("}");
  out.push("");
  out.push("/// Fixed ACL capability set shared with Zephyr authz.js.");
  out.push("public enum Capability: String, Sendable, CaseIterable, Codable {");
  for (const capability of capabilities) out.push(`    case ${caseName(capability)} = ${s(capability)}`);
  out.push("}");
  out.push("");
  out.push("public enum SyncContract {");
  out.push("    public static let protocolVersion = 1");
  out.push(`    public static let maxOpsPerBatch = ${MAX_OPS_PER_BATCH}`);
  out.push(`    public static let minIntervalSec = ${fileSync.limits.intervalSecondsMin}`);
  out.push(`    public static let maxIntervalSec = ${fileSync.limits.intervalSecondsMax}`);
  out.push("    public static let defaultIntervalSec = 300");
  out.push("    public static let appliedOpRetentionDays = 180");
  out.push("    public static let tombstoneRetentionDays = 180");
  out.push("    public static let bootstrapPageTokenTtlMinutes = 30");
  out.push("    public static let blobChunkBytes = 4 * 1024 * 1024");
  out.push("");
  out.push(`    public static let firstBindPhases: [SyncPhase] = [${FIRST_BIND_PHASES.map((p) => "." + caseName(p)).join(", ")}]`);
  out.push(`    public static let normalPhases: [SyncPhase] = [${NORMAL_PHASES.map((p) => "." + caseName(p)).join(", ")}]`);
  out.push("");
  out.push("    /// Retry backoff in milliseconds, jittered 0.5x-1.5x by the caller.");
  out.push("    public static let retryBackoffMs: [Int] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 900_000]");
  out.push("");
  out.push("    public static func clampIntervalSec(_ value: Int) -> Int {");
  out.push("        min(maxIntervalSec, max(minIntervalSec, value))");
  out.push("    }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function secretEnvelopeSwift() {
  const out = [HEADER];
  out.push("/// Device envelope constants frozen by DATA_AND_MIGRATION.md section 5.2.");
  out.push("public enum SecretEnvelopeContract {");
  out.push("    public static let version = 1");
  out.push(`    public static let alg = ${s("ML-KEM-768+HKDF-SHA256+AES-256-GCM")}`);
  out.push(`    public static let kem = ${s("ML-KEM-768")}`);
  out.push(`    public static let aead = ${s("AES-256-GCM")}`);
  out.push("    public static let ivBytes = 12");
  out.push("    public static let tagBytes = 16");
  out.push("    public static let derivedKeyBytes = 32");
  out.push(`    public static let hkdfSaltInput = ${s(HKDF_SALT_INPUT)}`);
  out.push(`    public static let secretAadPrefix = ${s(SECRET_AAD_PREFIX)}`);
  out.push(`    public static let sharedAadPrefix = ${s(SHARED_AAD_PREFIX)}`);
  out.push(`    public static let secretAadFields: [String] = ${arr(SECRET_AAD_FIELDS)}`);
  out.push(`    public static let sharedAadFields: [String] = ${arr(SHARED_AAD_FIELDS)}`);
  out.push("    public static let aadSeparator: UInt8 = 0x00");
  out.push("");
  out.push("    /// Purposes a shared single-use envelope may carry.");
  out.push(`    public static let sharedPurposes: [String] = ${arr(["ssh", "telnet", "rdp", "vnc"])}`);
  out.push("");
  out.push("    /// Keys that must never appear inside a decrypted shared payload.");
  out.push(`    public static let forbiddenSharedPayloadKeys: [String] = ${arr(["clientToken", "aiProviderApiKey", "aiEnvValue", "serverDataKey", "ownerSid", "refreshCredential"])}`);
  out.push("}");
  return out.join("\n") + "\n";
}

export function zft2ContractSwift() {
  const out = [HEADER];
  out.push("/// ZFT2 wire constants frozen by ZEPHYR_PARITY.md 10.2.");
  out.push("public enum Zft2Contract {");
  out.push(`    public static let magic: [UInt8] = [${Array.from(zft2.MAGIC).map((b) => "0x" + b.toString(16).toUpperCase()).join(", ")}]`);
  out.push(`    public static let version: UInt8 = ${zft2.VERSION}`);
  out.push(`    public static let headerBytes = ${zft2.HEADER_BYTES}`);
  out.push(`    public static let flagError: UInt16 = 0x${zft2.FLAG_ERROR.toString(16).padStart(4, "0")}`);
  out.push(`    public static let flagResponse: UInt16 = 0x${zft2.FLAG_RESPONSE.toString(16).padStart(4, "0")}`);
  out.push(`    public static let maxMetaBytes = ${zft2.MAX_META_BYTES}`);
  out.push(`    public static let maxPayloadBytes = ${zft2.MAX_PAYLOAD_BYTES}`);
  out.push(`    public static let maxInflightMin = ${zft2.MAX_INFLIGHT_MIN}`);
  out.push(`    public static let maxInflightMax = ${zft2.MAX_INFLIGHT_MAX}`);
  out.push(`    public static let maxInflightDefault = ${zft2.MAX_INFLIGHT_DEFAULT}`);
  out.push("}");
  out.push("");
  out.push("public enum Zft2Op: UInt8, Sendable, CaseIterable {");
  for (const [name, code] of Object.entries(zft2.OP)) {
    out.push(`    case ${caseName(name)} = 0x${code.toString(16).padStart(2, "0")}`);
  }
  out.push("");
  out.push("    /// Write semantics a readOnly provider must reject at the provider layer.");
  out.push("    public var isWrite: Bool {");
  const writeNames = zft2.WRITE_OPS.map((code) => "." + caseName(Object.entries(zft2.OP).find(([, v]) => v === code)[0]));
  out.push(`        [${writeNames.join(", ")}].contains(self)`);
  out.push("    }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function swiftSources() {
  return {
    "EntityRegistry.swift": entityRegistrySwift(),
    "ErrorRegistry.swift": errorRegistrySwift(),
    "MobileApiPaths.swift": apiPathsSwift(),
    "SyncContract.swift": syncContractSwift(),
    "SecretEnvelopeContract.swift": secretEnvelopeSwift(),
    "Zft2Contract.swift": zft2ContractSwift(),
  };
}
