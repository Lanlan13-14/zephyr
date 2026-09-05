package one.zephyr.mobile.model

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncAction

/**
 * A server change record (contracts/schemas/sync-change.schema.json).
 *
 * [changeSeq] is the only ordering authority. The client never re-orders a page: applying changes
 * out of order would let a stale upsert land after the tombstone that supersedes it.
 */
data class SyncChange(
    val changeSeq: Long,
    val entityType: String,
    val entityId: String,
    val action: SyncAction,
    val revision: Long,
    val changedAt: Long,
    /** Which device produced the change, so an echo of our own push can be recognised. */
    val actorDeviceId: String? = null,
    val fieldMask: List<String> = emptyList(),
    val payload: JsonObject = JsonObject(emptyMap()),
    /** Envelopes keyed by registry field name. Opened only after the AAD is verified. */
    val secretEnvelopes: Map<String, SecretEnvelope> = emptyMap(),
    val tombstone: JsonObject? = null,
    /**
     * Server could not project this row (legacy owner key, deleted-after-upsert).
     * The client must skip it and still advance the cursor; treating it as an
     * empty owned payload would freeze the whole page on residency.
     */
    val unsupported: Boolean = false,
) {
    val isDelete: Boolean get() = action == SyncAction.DELETE
}

/** One page of [SyncChange]. A page is applied atomically or not at all. */
data class ChangePage(
    val fromCursor: Long,
    val nextCursor: Long,
    val hasMore: Boolean,
    val changes: List<SyncChange>,
)

/**
 * One bootstrap snapshot page.
 *
 * [snapshotCursor] must be persisted before the first page is applied: it is the cursor the
 * catch-up pull resumes from, and losing it means the snapshot cannot be joined to the change feed.
 */
data class BootstrapPage(
    val bootstrapId: String,
    val snapshotCursor: Long,
    val nextPageToken: String?,
    val complete: Boolean,
    val entities: List<SyncChange>,
)

/** Per-operation push outcome. */
data class PushResult(
    val opId: String,
    val status: PushStatus,
    val entityId: String? = null,
    val revision: Long? = null,
    val changeSeq: Long? = null,
    val error: MobileError? = null,
    /** Server's view of the row when the status is CONFLICT. */
    val serverPayload: JsonObject? = null,
    val serverChangedFields: List<String> = emptyList(),
)

data class PushResponse(
    val batchId: String,
    val serverCursor: Long,
    val results: List<PushResult>,
    val changesAvailable: Boolean,
)

data class MobileAuthCapabilities(
    val sidHeader: String = "",
    val accessScheme: String = "",
    val proofHeader: String = "",
    val nonceHeader: String = "",
    val timestampHeader: String = "",
    val challengePath: String = "",
    val proofVersion: String = "",
    val proofSkewSec: Int = 0,
    val challengeTtlSec: Int = 0,
    val challengeMaxActivePerDevice: Int = 0,
    val challengeMaxIssuesPerMinute: Int = 0,
    val signatureFormat: String = "",
    val encryptionAlg: String = "",
    val signingAlg: String = "",
)

data class ServerEncryptionCapabilities(
    val alg: String,
    val keyVersion: Int,
    val publicKey: String,
)

data class WakeTransportCapabilities(
    val enabled: Boolean = false,
    val transport: String = "",
    val path: String = "",
    val event: String = "",
    val payloadFields: List<String> = emptyList(),
    val heartbeatSec: Int = 0,
    val retryMs: Long = 0L,
    val supportsLastEventId: Boolean = false,
    val requiresDeviceAccess: Boolean = false,
    val requiresDeviceProof: Boolean = false,
    val maxConnections: Int = 0,
    val maxConnectionsPerOwner: Int = 0,
    val maxBufferedBytes: Long = 0L,
)

/** Server-declared protocol, crypto, proof, wake, limit and feature capabilities. */
data class ServerCapabilities(
    val protocolVersions: List<Int>,
    val registryHash: String,
    val minimumAppVersions: Map<String, String> = emptyMap(),
    val limits: Map<String, Long> = emptyMap(),
    val serverId: String = "",
    val auth: MobileAuthCapabilities = MobileAuthCapabilities(),
    val serverEncryption: ServerEncryptionCapabilities? = null,
    val features: Map<String, Boolean> = emptyMap(),
    val wake: WakeTransportCapabilities = WakeTransportCapabilities(),
) {
    fun supports(protocolVersion: Int): Boolean = protocolVersions.contains(protocolVersion)

    fun feature(name: String): Boolean = features[name] == true
}
