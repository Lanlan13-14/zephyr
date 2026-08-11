package one.zephyr.mobile.app.binding

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import one.zephyr.mobile.model.AccountBinding

internal sealed interface LegacyAccountMigrationDecision {
    data object Ready : LegacyAccountMigrationDecision
    data object RequiresBootstrap : LegacyAccountMigrationDecision
    data class BlockedByPendingWrites(val count: Int) : LegacyAccountMigrationDecision
}

/**
 * Policy for the old process-wide plaintext Room database.
 *
 * Rows are never copied into an account database: the old database cannot prove which account
 * owns them. A clean mirror is discarded and rebuilt from the verified server binding. Pending
 * local writes stop recovery so they are neither attributed to the wrong account nor silently
 * deleted; a future recovery/export flow must resolve them before this binding can bootstrap.
 */
internal object LegacyAccountDatabaseMigration {
    const val MARKER_KEY = "account-database-migration-v1"
    const val BLOCKED_ERROR_CODE = "legacy_pending_writes"

    fun decide(
        storedMarker: String?,
        expectedMarker: String,
        pendingWriteCount: Int,
    ): LegacyAccountMigrationDecision {
        require(pendingWriteCount >= 0) { "pendingWriteCount must not be negative" }
        if (pendingWriteCount > 0) {
            return LegacyAccountMigrationDecision.BlockedByPendingWrites(pendingWriteCount)
        }
        return if (storedMarker == expectedMarker) {
            LegacyAccountMigrationDecision.Ready
        } else {
            LegacyAccountMigrationDecision.RequiresBootstrap
        }
    }

    fun marker(binding: AccountBinding): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(
            ByteArrayOutputStream().use { bytes ->
                DataOutputStream(bytes).use { output ->
                    listOf(
                        binding.serverProfileId,
                        binding.userId,
                        generationOf(binding),
                    ).forEach { value ->
                        val encoded = value.toByteArray(Charsets.UTF_8)
                        output.writeInt(encoded.size)
                        output.write(encoded)
                    }
                }
                bytes.toByteArray()
            },
        )
        return buildString(digest.size * 2) {
            digest.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(HEX[value ushr 4])
                append(HEX[value and 0x0f])
            }
        }
    }

    fun generationOf(binding: AccountBinding): String =
        BindingGeneration.of(binding)

    private const val HEX = "0123456789abcdef"
}

/** Readiness lives inside the encrypted generation it describes, never only in the legacy DB. */
internal object AccountDatabaseReadiness {
    const val MARKER_KEY = "account-database-ready-v1"

    fun marker(binding: AccountBinding): String = LegacyAccountDatabaseMigration.marker(binding)

    fun requiresBootstrap(storedMarker: String?, binding: AccountBinding): Boolean =
        storedMarker != marker(binding)
}

internal class LegacyPendingWritesException(val pendingWriteCount: Int) : IllegalStateException(
    "unscoped legacy database contains pending local writes",
)
