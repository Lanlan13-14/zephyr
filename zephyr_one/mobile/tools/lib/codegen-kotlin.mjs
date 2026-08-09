// Emits Kotlin contract sources from mobile/contracts. Generated files are checked in so that
// Gradle builds need no Node toolchain, and `node tools/generate.mjs --check` gates drift.
import {
  openapi, entityRegistry, errorRegistry, pushOrderedEntityTypes,
} from "./contracts.mjs";
import { SECRET_AAD_PREFIX, SHARED_AAD_PREFIX, HKDF_SALT_INPUT, SECRET_AAD_FIELDS, SHARED_AAD_FIELDS } from "./aad.mjs";
import * as zft2 from "./zft2.mjs";
import { BINDING_STATES, RUN_PHASES, FIRST_BIND_PHASES, NORMAL_PHASES, MAX_OPS_PER_BATCH, CONFLICT_RESOLUTIONS } from "./sync-core.mjs";

export const KOTLIN_PACKAGE = "one.zephyr.mobile.contracts";
const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.",
  "",
  `package ${KOTLIN_PACKAGE}`,
  "",
].join("\n");

/** Kotlin string literal. Also escapes `$` so no accidental string templates appear. */
function s(value) {
  return JSON.stringify(String(value)).replace(/\$/g, "\\$");
}

function list(values) {
  const items = values ?? [];
  if (items.length === 0) return "emptyList()";
  return `listOf(${items.map(s).join(", ")})`;
}

function nullableStr(value) {
  return value === null || value === undefined ? "null" : s(value);
}

function enumConst(value) {
  return String(value).replace(/[^A-Za-z0-9]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function entityRegistryKt() {
  const registry = entityRegistry();
  const out = [HEADER];
  out.push("/** One sync entity as frozen by contracts/registries/entity-registry.json. */");
  out.push("data class SyncEntitySpec(");
  out.push("    val type: String,");
  out.push("    val source: String,");
  out.push("    val idField: String,");
  out.push("    val ownerField: String,");
  out.push("    val revisionField: String?,");
  out.push("    val deleteMode: String,");
  out.push("    val dependencyOrder: Int,");
  out.push("    val minimumClientVersion: Int,");
  out.push("    val editableFields: List<String>,");
  out.push("    val secretFields: List<String>,");
  out.push("    val serverAuthorityFields: List<String>,");
  out.push("    val opaquePreserveFields: List<String>,");
  out.push("    val deviceLocalFields: List<String>,");
  out.push("    val capabilities: List<String>,");
  out.push("    val status: String,");
  out.push(") {");
  out.push("    /** Fields One must never name in a fieldMask. */");
  out.push("    val forbiddenMaskFields: List<String> =");
  out.push("        secretFields + serverAuthorityFields + opaquePreserveFields + deviceLocalFields");
  out.push("}");
  out.push("");
  out.push("object EntityRegistry {");
  out.push(`    const val VERSION: Int = ${registry.version}`);
  out.push(`    const val SOURCE_COMMIT: String = ${s(registry.sourceCommit)}`);
  out.push("");
  out.push(`    val classification: List<String> = ${list(registry.classification)}`);
  out.push(`    val excludedEditableScopes: List<String> = ${list(registry.excludedEditableScopes)}`);
  out.push("");
  out.push("    val entities: List<SyncEntitySpec> = listOf(");
  for (const e of registry.entities) {
    out.push("        SyncEntitySpec(");
    out.push(`            type = ${s(e.type)},`);
    out.push(`            source = ${s(e.source)},`);
    out.push(`            idField = ${s(e.idField)},`);
    out.push(`            ownerField = ${s(e.ownerField)},`);
    out.push(`            revisionField = ${nullableStr(e.revisionField)},`);
    out.push(`            deleteMode = ${s(e.deleteMode)},`);
    out.push(`            dependencyOrder = ${e.dependencyOrder},`);
    out.push(`            minimumClientVersion = ${e.minimumClientVersion},`);
    out.push(`            editableFields = ${list(e.editableFields)},`);
    out.push(`            secretFields = ${list(e.secretFields)},`);
    out.push(`            serverAuthorityFields = ${list(e.serverAuthorityFields)},`);
    out.push(`            opaquePreserveFields = ${list(e.opaquePreserveFields)},`);
    out.push(`            deviceLocalFields = ${list(e.deviceLocalFields)},`);
    out.push(`            capabilities = ${list(e.capabilities ?? e.capabilityValues)},`);
    out.push(`            status = ${s(e.status)},`);
    out.push("        ),");
  }
  out.push("    )");
  out.push("");
  out.push("    val byType: Map<String, SyncEntitySpec> = entities.associateBy { it.type }");
  out.push("");
  out.push("    /** Push topology order: dependencies first, ties broken by type name. */");
  out.push(`    val pushOrder: List<String> = ${list(pushOrderedEntityTypes())}`);
  out.push("");
  out.push("    fun require(type: String): SyncEntitySpec =");
  out.push("        byType[type] ?: throw IllegalArgumentException(\"unknown entityType \" + type)");
  out.push("");
  out.push("    fun isEditableScope(scope: String): Boolean = !excludedEditableScopes.contains(scope)");
  out.push("}");
  return out.join("\n") + "\n";
}

export function errorRegistryKt() {
  const registry = errorRegistry();
  const out = [HEADER];
  out.push("/** Stable mobile v1 error code. Clients branch on `code`, never on `message`. */");
  out.push("data class MobileErrorSpec(");
  out.push("    val code: String,");
  out.push("    val httpStatus: Int,");
  out.push("    val retryable: Boolean,");
  out.push("    val clientAction: String,");
  out.push(")");
  out.push("");
  out.push("object ErrorRegistry {");
  out.push(`    const val VERSION: Int = ${registry.version}`);
  out.push("");
  out.push("    val errors: List<MobileErrorSpec> = listOf(");
  for (const e of registry.errors) {
    out.push(`        MobileErrorSpec(${s(e.code)}, ${e.httpStatus}, ${e.retryable}, ${s(e.clientAction)}),`);
  }
  out.push("    )");
  out.push("");
  out.push("    val byCode: Map<String, MobileErrorSpec> = errors.associateBy { it.code }");
  out.push("");
  out.push("    fun retryable(code: String): Boolean = byCode[code]?.retryable ?: false");
  out.push("");
  out.push("    fun clientAction(code: String): String = byCode[code]?.clientAction ?: \"report_unknown_error\"");
  out.push("");
  out.push("    /** Codes that invalidate the local cursor and force a fresh bootstrap. */");
  out.push("    val bootstrapResetCodes: List<String> = errors");
  out.push("        .filter { it.clientAction == \"restart_bootstrap\" }");
  out.push("        .map { it.code }");
  out.push("");
  out.push("    /** Codes that mean the binding must be re-established before syncing again. */");
  out.push("    val rebindCodes: List<String> = errors");
  out.push("        .filter { it.clientAction == \"rebind\" || it.clientAction == \"refresh_or_rebind\" }");
  out.push("        .map { it.code }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function apiPathsKt() {
  const spec = openapi();
  const out = [HEADER];
  out.push("/** Paths taken verbatim from contracts/openapi-mobile-v1.json. */");
  out.push("object MobileApiPaths {");
  out.push(`    const val TITLE: String = ${s(spec.info.title)}`);
  out.push(`    const val VERSION: String = ${s(spec.info.version)}`);
  out.push("    const val PROTOCOL_VERSION: Int = 1");
  out.push("");
  const seen = new Set();
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      const name = enumConst(route.replace(/^\/api\//, "").replace(/\{[^}]+\}/g, "by"));
      const constName = `${method.toUpperCase()}_${name}`;
      if (seen.has(constName)) continue;
      seen.add(constName);
      out.push(`    const val ${constName}: String = ${s(route)}`);
    }
  }
  out.push("");
  out.push("    fun deviceById(deviceId: String): String = \"/api/mobile/v1/devices/\" + deviceId");
  out.push("");
  out.push("    fun sharedResource(resourceType: String, resourceId: String): String =");
  out.push("        \"/api/mobile/v1/shared/\" + resourceType + \"/\" + resourceId");
  out.push("");
  /* The connections/{id}/sessions path is a template like the two above, so it
   * gets a helper for the same reason: a hand-built string in the client is how
   * a path drifts from the frozen OpenAPI without any test noticing. */
  out.push("    fun sharedConnectionSessions(connectionId: String): String =");
  out.push("        \"/api/mobile/v1/shared/connections/\" + connectionId + \"/sessions\"");
  out.push("");
  out.push("    fun sharedSession(sessionId: String): String =");
  out.push("        \"/api/mobile/v1/shared/sessions/\" + sessionId");
  out.push("}");
  return out.join("\n") + "\n";
}

export function syncContractKt() {
  const registry = entityRegistry();
  const capabilities = registry.entities.find((e) => e.type === "resourceAcl").capabilityValues;
  const fileSync = registry.entities.find((e) => e.type === "fileSyncConfig");
  const out = [HEADER];
  out.push("/** Persisted binding state from SYNC_STATE_MACHINE.md section 1. */");
  out.push("enum class BindingState {");
  for (const state of BINDING_STATES) out.push(`    ${state},`);
  out.push("    ;");
  out.push("    val isBound: Boolean get() = this != UNBOUND");
  out.push("    val canRunSync: Boolean get() = when (this) {");
  out.push("        UNBOUND, REVOKED, FATAL_INCOMPATIBLE, REAUTH_REQUIRED -> false");
  out.push("        else -> true");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("/** Runtime phase from SYNC_STATE_MACHINE.md section 2. */");
  out.push("enum class SyncPhase {");
  for (const phase of RUN_PHASES) out.push(`    ${phase},`);
  out.push("}");
  out.push("");
  out.push("enum class SyncAction { UPSERT, DELETE, RESTORE }");
  out.push("");
  out.push("enum class PushStatus { ACCEPTED, DUPLICATE, CONFLICT, REJECTED, DEPENDENCY_MISSING }");
  out.push("");
  out.push("enum class ConflictResolution {");
  for (const resolution of CONFLICT_RESOLUTIONS) out.push(`    ${enumConst(resolution)},`);
  out.push("}");
  out.push("");
  out.push("/** Fixed ACL capability set shared with Zephyr authz.js. */");
  out.push("enum class Capability(val wireName: String) {");
  for (const capability of capabilities) out.push(`    ${enumConst(capability)}(${s(capability)}),`);
  out.push("    ;");
  out.push("    companion object {");
  out.push("        fun fromWire(value: String): Capability? = entries.firstOrNull { it.wireName == value }");
  out.push("    }");
  out.push("}");
  out.push("");
  out.push("object SyncContract {");
  out.push("    const val PROTOCOL_VERSION: Int = 1");
  out.push(`    const val MAX_OPS_PER_BATCH: Int = ${MAX_OPS_PER_BATCH}`);
  out.push(`    const val MIN_INTERVAL_SEC: Int = ${fileSync.limits.intervalSecondsMin}`);
  out.push(`    const val MAX_INTERVAL_SEC: Int = ${fileSync.limits.intervalSecondsMax}`);
  out.push("    const val DEFAULT_INTERVAL_SEC: Int = 300");
  out.push("    const val APPLIED_OP_RETENTION_DAYS: Int = 180");
  out.push("    const val TOMBSTONE_RETENTION_DAYS: Int = 180");
  out.push("    const val BOOTSTRAP_PAGE_TOKEN_TTL_MINUTES: Int = 30");
  out.push("    const val BLOB_CHUNK_BYTES: Int = 4 * 1024 * 1024");
  out.push("");
  out.push("    /** Android periodic WorkManager cannot run faster than this. */");
  out.push("    const val PERIODIC_WORK_MIN_INTERVAL_SEC: Int = 15 * 60");
  out.push("");
  out.push(`    val firstBindPhases: List<SyncPhase> = listOf(${FIRST_BIND_PHASES.map((p) => `SyncPhase.${p}`).join(", ")})`);
  out.push(`    val normalPhases: List<SyncPhase> = listOf(${NORMAL_PHASES.map((p) => `SyncPhase.${p}`).join(", ")})`);
  out.push("");
  out.push("    /** Retry backoff in milliseconds, jittered 0.5x-1.5x by the caller. */");
  out.push("    val retryBackoffMs: List<Long> = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 60_000L, 900_000L)");
  out.push("");
  out.push("    fun clampIntervalSec(value: Int): Int = value.coerceIn(MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)");
  out.push("}");
  return out.join("\n") + "\n";
}

export function secretEnvelopeKt() {
  const out = [HEADER];
  out.push("/** Device envelope constants frozen by DATA_AND_MIGRATION.md section 5.2. */");
  out.push("object SecretEnvelopeContract {");
  out.push("    const val VERSION: Int = 1");
  out.push(`    const val ALG: String = ${s("ML-KEM-768+HKDF-SHA256+AES-256-GCM")}`);
  out.push(`    const val KEM: String = ${s("ML-KEM-768")}`);
  out.push(`    const val AEAD: String = ${s("AES-256-GCM")}`);
  out.push("    const val IV_BYTES: Int = 12");
  out.push("    const val TAG_BYTES: Int = 16");
  out.push("    const val DERIVED_KEY_BYTES: Int = 32");
  out.push(`    const val HKDF_SALT_INPUT: String = ${s(HKDF_SALT_INPUT)}`);
  out.push(`    const val SECRET_AAD_PREFIX: String = ${s(SECRET_AAD_PREFIX)}`);
  out.push(`    const val SHARED_AAD_PREFIX: String = ${s(SHARED_AAD_PREFIX)}`);
  out.push(`    val secretAadFields: List<String> = ${list(SECRET_AAD_FIELDS)}`);
  out.push(`    val sharedAadFields: List<String> = ${list(SHARED_AAD_FIELDS)}`);
  out.push("    const val AAD_SEPARATOR: Byte = 0x00");
  out.push("");
  out.push("    /** Purposes a shared single-use envelope may carry. */");
  out.push(`    val sharedPurposes: List<String> = ${list(["ssh", "telnet", "rdp", "vnc"])}`);
  out.push("");
  out.push("    /** Keys that must never appear inside a decrypted shared payload. */");
  out.push(`    val forbiddenSharedPayloadKeys: List<String> = ${list(["clientToken", "aiProviderApiKey", "aiEnvValue", "serverDataKey", "ownerSid", "refreshCredential"])}`);
  out.push("}");
  return out.join("\n") + "\n";
}

export function zft2ContractKt() {
  const out = [HEADER];
  out.push("/** ZFT2 wire constants frozen by ZEPHYR_PARITY.md 10.2. */");
  out.push("object Zft2Contract {");
  out.push(`    val MAGIC: ByteArray = byteArrayOf(${Array.from(zft2.MAGIC).map((b) => `0x${b.toString(16).toUpperCase()}`).join(", ")})`);
  out.push(`    const val VERSION: Int = ${zft2.VERSION}`);
  out.push(`    const val HEADER_BYTES: Int = ${zft2.HEADER_BYTES}`);
  out.push(`    const val FLAG_ERROR: Int = 0x${zft2.FLAG_ERROR.toString(16).padStart(4, "0")}`);
  out.push(`    const val FLAG_RESPONSE: Int = 0x${zft2.FLAG_RESPONSE.toString(16).padStart(4, "0")}`);
  out.push(`    const val MAX_META_BYTES: Int = ${zft2.MAX_META_BYTES}`);
  out.push(`    const val MAX_PAYLOAD_BYTES: Int = ${zft2.MAX_PAYLOAD_BYTES}`);
  out.push(`    const val MAX_INFLIGHT_MIN: Int = ${zft2.MAX_INFLIGHT_MIN}`);
  out.push(`    const val MAX_INFLIGHT_MAX: Int = ${zft2.MAX_INFLIGHT_MAX}`);
  out.push(`    const val MAX_INFLIGHT_DEFAULT: Int = ${zft2.MAX_INFLIGHT_DEFAULT}`);
  out.push("}");
  out.push("");
  out.push("enum class Zft2Op(val code: Int) {");
  for (const [name, code] of Object.entries(zft2.OP)) {
    out.push(`    ${name}(0x${code.toString(16).padStart(2, "0")}),`);
  }
  out.push("    ;");
  out.push("    /** Write semantics a readOnly provider must reject at the provider layer. */");
  out.push(`    val isWrite: Boolean get() = this in listOf(${zft2.WRITE_OPS.map((code) => Object.entries(zft2.OP).find(([, v]) => v === code)[0]).join(", ")})`);
  out.push("");
  out.push("    companion object {");
  out.push("        fun fromCode(code: Int): Zft2Op? = entries.firstOrNull { it.code == code }");
  out.push("    }");
  out.push("}");
  return out.join("\n") + "\n";
}

export function kotlinSources() {
  return {
    "EntityRegistry.kt": entityRegistryKt(),
    "ErrorRegistry.kt": errorRegistryKt(),
    "MobileApiPaths.kt": apiPathsKt(),
    "SyncContract.kt": syncContractKt(),
    "SecretEnvelopeContract.kt": secretEnvelopeKt(),
    "Zft2Contract.kt": zft2ContractKt(),
  };
}
