package one.zephyr.mobile.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey

/** A Zephyr deployment One can bind to. Portable metadata only, no credentials. */
@Entity(tableName = "server_profiles")
data class ServerProfileRow(
    @PrimaryKey val id: String,
    val baseUrl: String,
    val displayName: String,
    /** "system" or "pinned"; pin values live in [pinnedSpkiJson]. */
    val tlsPolicy: String,
    val pinnedSpkiJson: String,
    val createdAt: Long,
    val lastUsedAt: Long?,
)

/**
 * The account+token+device binding.
 *
 * Credentials are deliberately absent: the access and refresh credentials live in the SecretStore,
 * so a database export can never carry them (DEVELOPMENT.md 1030).
 */
@Entity(tableName = "account_bindings")
data class AccountBindingRow(
    @PrimaryKey val serverProfileId: String,
    val userId: String,
    val username: String,
    val deviceId: String,
    val deviceName: String,
    val tokenId: String,
    val tokenName: String,
    val state: String,
    val registryHash: String,
    val boundAt: Long,
    val lastSyncAt: Long?,
    /** Bumped by a main-end backup restore; invalidates every cursor and credential. */
    val instanceEpoch: Long,
    val automaticEnabled: Boolean,
    val syncIntervalSec: Int,
    val networkPolicy: String,
)

/** Device-local One settings that are never synced (language, app lock, screenshot guard). */
@Entity(tableName = "device_preferences")
data class DevicePreferenceRow(
    @PrimaryKey val key: String,
    val valueJson: String,
    val updatedAt: Long,
)

/**
 * Trusted remote-desktop certificates.
 *
 * REMOTE_DESKTOP_EXPERIENCE.md requires an explicit per-host trust decision with a visible
 * fingerprint; there is no "accept everything" mode, so a row here is always a user action.
 */
@Entity(tableName = "trusted_certificates")
data class TrustedCertificateRow(
    @PrimaryKey val hostKey: String,
    val protocol: String,
    val sha256Fingerprint: String,
    val subject: String,
    val issuer: String,
    val notAfter: Long?,
    val trustedAt: Long,
)
