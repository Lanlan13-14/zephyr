package one.zephyr.mobile.data.repository

import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.data.db.AccountBindingRow
import one.zephyr.mobile.data.db.ServerProfileRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.security.SecretStore

/**
 * Server profiles and the single active account binding.
 *
 * One binding at a time is a product decision, not a limitation: SHARED_RESOURCE_RESIDENCY.md 130
 * requires every in-memory shared session and the whole local mirror to be dropped when the account
 * or server changes, which is only auditable if there is exactly one binding to reason about.
 */
class BindingRepository(
    private val db: ZephyrDatabase,
    private val secretStore: SecretStore,
) {

    fun observeProfiles(): Flow<List<ServerProfile>> =
        db.serverProfileDao().observeAll().map { rows -> rows.map(::toProfile) }

    fun observeActiveBinding(): Flow<AccountBinding?> =
        db.accountBindingDao().observeActive().map { row -> row?.let(::toBinding) }

    suspend fun activeBinding(): AccountBinding? = db.accountBindingDao().active()?.let(::toBinding)

    suspend fun profile(id: String): ServerProfile? = db.serverProfileDao().find(id)?.let(::toProfile)

    suspend fun saveProfile(profile: ServerProfile) {
        db.serverProfileDao().upsert(
            ServerProfileRow(
                id = profile.id,
                baseUrl = profile.baseUrl,
                displayName = profile.displayName,
                tlsPolicy = when (profile.tlsPolicy) {
                    is TlsPolicy.SystemTrust -> "system"
                    is TlsPolicy.PinnedSpki -> "pinned"
                    is TlsPolicy.InsecureTrust -> "insecure"
                },
                pinnedSpkiJson = one.zephyr.mobile.data.db.Converters.stringListToText(
                    (profile.tlsPolicy as? TlsPolicy.PinnedSpki)?.sha256Pins ?: emptyList(),
                ),
                createdAt = profile.createdAt,
                lastUsedAt = profile.lastUsedAt,
            ),
        )
    }

    suspend fun saveBinding(binding: AccountBinding, automaticEnabled: Boolean, intervalSec: Int, policy: NetworkPolicy) {
        db.accountBindingDao().upsert(
            AccountBindingRow(
                serverProfileId = binding.serverProfileId,
                userId = binding.userId,
                username = binding.username,
                deviceId = binding.deviceId,
                deviceName = binding.deviceName,
                tokenId = binding.tokenId,
                tokenName = binding.tokenName,
                state = binding.state.name,
                registryHash = binding.registryHash,
                boundAt = binding.boundAt,
                lastSyncAt = binding.lastSyncAt,
                instanceEpoch = binding.instanceEpoch,
                automaticEnabled = automaticEnabled,
                syncIntervalSec = SyncContract.clampIntervalSec(intervalSec),
                networkPolicy = policy.wireName,
            ),
        )
    }

    suspend fun updateState(serverProfileId: String, state: BindingState) {
        db.accountBindingDao().updateState(serverProfileId, state.name)
    }

    suspend fun setAutomaticEnabled(serverProfileId: String, enabled: Boolean) {
        db.accountBindingDao().updateAutomatic(serverProfileId, enabled)
    }

    /** Interval is clamped here so a stale UI value can never persist an out-of-range period. */
    suspend fun setIntervalSec(serverProfileId: String, seconds: Int) {
        db.accountBindingDao().updateInterval(serverProfileId, SyncContract.clampIntervalSec(seconds))
    }

    suspend fun setNetworkPolicy(serverProfileId: String, policy: NetworkPolicy) {
        db.accountBindingDao().updateNetworkPolicy(serverProfileId, policy.wireName)
    }

    /**
     * Full local teardown for unbind, account switch or device revoke.
     *
     * Everything goes in one transaction and the SecretStore is wiped with its wrapping key, so a
     * partially-unbound device cannot keep decryptable material for an account it no longer holds.
     */
    suspend fun unbind() {
        db.withTransaction {
            db.pendingOperationDao().deleteAll()
            db.conflictDao().deleteAll()
            db.appliedOperationDao().deleteAll()
            db.blobTransferDao().deleteAll()
            db.bootstrapDao().clearAll()
            db.syncStateDao().deleteAll()
            db.overlayDao().deleteAll()
            db.tombstoneDao().deleteAll()
            db.mirrorDao().deleteAll()
            db.mirrorDao().deleteAllSearch()
            db.trustedCertificateDao().deleteAll()
            db.accountBindingDao().deleteAll()
        }
        secretStore.wipe()
    }

    private fun toProfile(row: ServerProfileRow): ServerProfile = ServerProfile(
        id = row.id,
        baseUrl = row.baseUrl,
        displayName = row.displayName,
        tlsPolicy = when (row.tlsPolicy) {
            "pinned" -> TlsPolicy.PinnedSpki(one.zephyr.mobile.data.db.Converters.textToStringList(row.pinnedSpkiJson))
            "insecure" -> TlsPolicy.InsecureTrust
            else -> TlsPolicy.SystemTrust
        },
        createdAt = row.createdAt,
        lastUsedAt = row.lastUsedAt,
    )

    private fun toBinding(row: AccountBindingRow): AccountBinding = AccountBinding(
        serverProfileId = row.serverProfileId,
        userId = row.userId,
        username = row.username,
        deviceId = row.deviceId,
        deviceName = row.deviceName,
        tokenId = row.tokenId,
        tokenName = row.tokenName,
        state = runCatching { BindingState.valueOf(row.state) }.getOrDefault(BindingState.UNBOUND),
        registryHash = row.registryHash,
        boundAt = row.boundAt,
        lastSyncAt = row.lastSyncAt,
        instanceEpoch = row.instanceEpoch,
    )
}
