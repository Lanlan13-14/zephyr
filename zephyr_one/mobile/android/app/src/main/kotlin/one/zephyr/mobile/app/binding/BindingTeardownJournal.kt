package one.zephyr.mobile.app.binding

import android.content.Context
import android.content.SharedPreferences
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.sync.SyncSettings

/** Exact ownership boundary retained while a revoked binding is being destroyed. */
internal data class BindingTeardownScope(
    val serverProfileId: String,
    val userId: String,
    val deviceId: String,
    val generation: String,
) {
    val bindingKey: String = "$serverProfileId/$userId/$deviceId"

    fun matches(binding: AccountBinding): Boolean =
        serverProfileId == binding.serverProfileId &&
            userId == binding.userId &&
            deviceId == binding.deviceId &&
            generation == BindingGeneration.of(binding)

    init {
        require(serverProfileId.isNotBlank() && serverProfileId.length <= MAX_SCOPE_SEGMENT_LENGTH)
        require(userId.isNotBlank() && userId.length <= MAX_SCOPE_SEGMENT_LENGTH)
        require(deviceId.isNotBlank() && deviceId.length <= MAX_SCOPE_SEGMENT_LENGTH)
        require(generation.matches(GENERATION_PATTERN))
    }

    companion object {
        fun of(binding: AccountBinding): BindingTeardownScope = BindingTeardownScope(
            serverProfileId = binding.serverProfileId,
            userId = binding.userId,
            deviceId = binding.deviceId,
            generation = BindingGeneration.of(binding),
        )

        private const val MAX_SCOPE_SEGMENT_LENGTH = 4_096
        private val GENERATION_PATTERN = Regex("[0-9a-f]{64}")
    }
}

/**
 * Durable intent record written before the account graph is stopped.
 *
 * It deliberately lives outside both the binding row and the account SQLCipher database: either
 * of those is a deletion target, so neither can prove what remains to erase after process death.
 */
internal interface BindingTeardownJournal {
    fun pending(): BindingTeardownScope?
    fun persist(scope: BindingTeardownScope)
    fun clear(scope: BindingTeardownScope)
}

internal fun interface BindingScopeStateWiper {
    fun wipe(scope: BindingTeardownScope)
}

/** Erases an unpublished generation without reconciling or revoking application-wide grants. */
internal fun interface BindingPreparedStateWiper {
    fun discard(scope: BindingTeardownScope)
}

/** Durable, non-sensitive proof that package-global no-account cleanup is incomplete. */
internal interface NoAccountCleanupJournal {
    fun pending(): Boolean
    fun persist()
    fun clear()
}

/** May revoke package-global capabilities only after the coordinator proves no binding is active. */
internal fun interface NoAccountStateWiper {
    fun wipe(): Boolean
}

/**
 * A replacement has two durable ownership boundaries. PREPARED records still belong to [previous];
 * COMMITTED is written only after the binding row durably names [next].
 */
internal data class BindingReplacementRecord(
    val previous: BindingTeardownScope?,
    val next: StoredBinding,
    val stage: BindingReplacementStage,
) {
    val nextScope: BindingTeardownScope = BindingTeardownScope.of(next.binding)
}

internal enum class BindingReplacementStage {
    PREPARED,
    COMMITTED,
    OLD_FENCED,
    NEXT_STARTED,
    PUBLISHED,
    OLD_TORN_DOWN,
}

internal interface BindingReplacementJournal {
    fun pending(): BindingReplacementRecord?
    fun persist(record: BindingReplacementRecord)
    fun advance(record: BindingReplacementRecord, stage: BindingReplacementStage)
    fun clear(record: BindingReplacementRecord)
}

/**
 * Separate from [BindingTeardownJournal]: this record starts before new scoped state is created and
 * survives while the new binding row is published but old scoped state still needs erasure.
 */
internal class SharedPreferencesBindingReplacementJournal(
    context: Context,
) : BindingReplacementJournal {
    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun pending(): BindingReplacementRecord? {
        if (!preferences.contains(KEY_STAGE)) return null
        check(preferences.getInt(KEY_VERSION, -1) == VERSION) { "unsupported binding replacement journal" }
        val stage = BindingReplacementStage.valueOf(requiredString(KEY_STAGE))
        val binding = AccountBinding(
            serverProfileId = requiredString(KEY_NEXT_SERVER),
            userId = requiredString(KEY_NEXT_USER),
            username = requiredString(KEY_NEXT_USERNAME),
            deviceId = requiredString(KEY_NEXT_DEVICE),
            deviceName = requiredString(KEY_NEXT_DEVICE_NAME),
            tokenId = requiredString(KEY_NEXT_TOKEN),
            tokenName = requiredString(KEY_NEXT_TOKEN_NAME),
            state = BindingState.valueOf(requiredString(KEY_NEXT_STATE)),
            registryHash = requiredString(KEY_NEXT_REGISTRY),
            boundAt = preferences.getLong(KEY_NEXT_BOUND_AT, Long.MIN_VALUE).also {
                check(it != Long.MIN_VALUE) { "incomplete binding replacement journal" }
            },
            lastSyncAt = preferences.getLong(KEY_NEXT_LAST_SYNC, Long.MIN_VALUE)
                .takeUnless { it == Long.MIN_VALUE },
            instanceEpoch = preferences.getLong(KEY_NEXT_INSTANCE_EPOCH, Long.MIN_VALUE).also {
                check(it != Long.MIN_VALUE) { "incomplete binding replacement journal" }
            },
        )
        val pins = preferences.getStringSet(KEY_PROFILE_PINS, mutableSetOf())!!.toList()
        val profile = ServerProfile(
            id = requiredString(KEY_PROFILE_ID),
            baseUrl = requiredString(KEY_PROFILE_URL),
            displayName = requiredString(KEY_PROFILE_NAME),
            tlsPolicy = when (requiredString(KEY_PROFILE_TLS)) {
                TLS_SYSTEM -> TlsPolicy.SystemTrust
                TLS_PINNED -> TlsPolicy.PinnedSpki(pins)
                TLS_INSECURE -> TlsPolicy.InsecureTrust
                else -> error("invalid binding replacement TLS policy")
            },
            createdAt = preferences.getLong(KEY_PROFILE_CREATED, Long.MIN_VALUE).also {
                check(it != Long.MIN_VALUE) { "incomplete binding replacement journal" }
            },
            lastUsedAt = preferences.getLong(KEY_PROFILE_LAST_USED, Long.MIN_VALUE)
                .takeUnless { it == Long.MIN_VALUE },
        )
        val previous = if (preferences.getBoolean(KEY_HAS_PREVIOUS, false)) {
            BindingTeardownScope(
                serverProfileId = requiredString(KEY_PREVIOUS_SERVER),
                userId = requiredString(KEY_PREVIOUS_USER),
                deviceId = requiredString(KEY_PREVIOUS_DEVICE),
                generation = requiredString(KEY_PREVIOUS_GENERATION),
            )
        } else {
            null
        }
        return BindingReplacementRecord(
            previous = previous,
            next = StoredBinding(
                binding = binding,
                profile = profile,
                settings = SyncSettings(
                    automaticEnabled = preferences.getBoolean(KEY_SETTINGS_AUTOMATIC, false),
                    intervalSec = preferences.getInt(KEY_SETTINGS_INTERVAL, -1).also {
                        check(it > 0) { "incomplete binding replacement journal" }
                    },
                    networkPolicy = NetworkPolicy.fromWire(requiredString(KEY_SETTINGS_NETWORK)),
                ),
            ),
            stage = stage,
        )
    }

    override fun persist(record: BindingReplacementRecord) {
        require(record.stage == BindingReplacementStage.PREPARED) { "replacement journal must start prepared" }
        val existing = pending()
        check(existing == null || sameReplacement(existing, record)) { "another binding replacement is pending" }
        if (existing != null) return
        write(record, record.stage)
    }

    override fun advance(record: BindingReplacementRecord, stage: BindingReplacementStage) {
        val existing = checkNotNull(pending()) { "binding replacement journal is missing" }
        check(sameReplacement(existing, record)) { "binding replacement ownership changed" }
        if (stage.ordinal <= existing.stage.ordinal) return
        write(record, stage)
    }

    override fun clear(record: BindingReplacementRecord) {
        val existing = pending() ?: return
        check(sameReplacement(existing, record)) { "binding replacement ownership changed" }
        check(preferences.edit().clear().commit()) { "binding replacement journal could not be cleared" }
    }

    private fun write(record: BindingReplacementRecord, stage: BindingReplacementStage) {
        val binding = record.next.binding
        val profile = record.next.profile
        val editor = preferences.edit()
            .clear()
            .putInt(KEY_VERSION, VERSION)
            .putString(KEY_STAGE, stage.name)
            .putBoolean(KEY_HAS_PREVIOUS, record.previous != null)
            .putString(KEY_NEXT_SERVER, binding.serverProfileId)
            .putString(KEY_NEXT_USER, binding.userId)
            .putString(KEY_NEXT_USERNAME, binding.username)
            .putString(KEY_NEXT_DEVICE, binding.deviceId)
            .putString(KEY_NEXT_DEVICE_NAME, binding.deviceName)
            .putString(KEY_NEXT_TOKEN, binding.tokenId)
            .putString(KEY_NEXT_TOKEN_NAME, binding.tokenName)
            .putString(KEY_NEXT_STATE, binding.state.name)
            .putString(KEY_NEXT_REGISTRY, binding.registryHash)
            .putLong(KEY_NEXT_BOUND_AT, binding.boundAt)
            .putLong(KEY_NEXT_LAST_SYNC, binding.lastSyncAt ?: Long.MIN_VALUE)
            .putLong(KEY_NEXT_INSTANCE_EPOCH, binding.instanceEpoch)
            .putString(KEY_PROFILE_ID, profile.id)
            .putString(KEY_PROFILE_URL, profile.baseUrl)
            .putString(KEY_PROFILE_NAME, profile.displayName)
            .putString(
                KEY_PROFILE_TLS,
                when (profile.tlsPolicy) {
                    is TlsPolicy.PinnedSpki -> TLS_PINNED
                    is TlsPolicy.InsecureTrust -> TLS_INSECURE
                    is TlsPolicy.SystemTrust -> TLS_SYSTEM
                },
            )
            .putStringSet(
                KEY_PROFILE_PINS,
                (profile.tlsPolicy as? TlsPolicy.PinnedSpki)?.sha256Pins?.toMutableSet() ?: mutableSetOf(),
            )
            .putLong(KEY_PROFILE_CREATED, profile.createdAt)
            .putLong(KEY_PROFILE_LAST_USED, profile.lastUsedAt ?: Long.MIN_VALUE)
            .putBoolean(KEY_SETTINGS_AUTOMATIC, record.next.settings.automaticEnabled)
            .putInt(KEY_SETTINGS_INTERVAL, record.next.settings.intervalSec)
            .putString(KEY_SETTINGS_NETWORK, record.next.settings.networkPolicy.wireName)
        record.previous?.let { previous ->
            editor.putString(KEY_PREVIOUS_SERVER, previous.serverProfileId)
                .putString(KEY_PREVIOUS_USER, previous.userId)
                .putString(KEY_PREVIOUS_DEVICE, previous.deviceId)
                .putString(KEY_PREVIOUS_GENERATION, previous.generation)
        }
        check(editor.commit()) { "binding replacement journal could not be persisted" }
    }

    private fun sameReplacement(left: BindingReplacementRecord, right: BindingReplacementRecord): Boolean =
        left.previous == right.previous && left.nextScope == right.nextScope

    private fun requiredString(key: String): String =
        checkNotNull(preferences.getString(key, null)) { "incomplete binding replacement journal" }

    private companion object {
        const val PREFERENCES = "zephyr-one-binding-replacement"
        const val VERSION = 1
        const val TLS_SYSTEM = "system"
        const val TLS_PINNED = "pinned"
        const val TLS_INSECURE = "insecure"
        const val KEY_VERSION = "version"
        const val KEY_STAGE = "stage"
        const val KEY_HAS_PREVIOUS = "has-previous"
        const val KEY_PREVIOUS_SERVER = "previous-server"
        const val KEY_PREVIOUS_USER = "previous-user"
        const val KEY_PREVIOUS_DEVICE = "previous-device"
        const val KEY_PREVIOUS_GENERATION = "previous-generation"
        const val KEY_NEXT_SERVER = "next-server"
        const val KEY_NEXT_USER = "next-user"
        const val KEY_NEXT_USERNAME = "next-username"
        const val KEY_NEXT_DEVICE = "next-device"
        const val KEY_NEXT_DEVICE_NAME = "next-device-name"
        const val KEY_NEXT_TOKEN = "next-token"
        const val KEY_NEXT_TOKEN_NAME = "next-token-name"
        const val KEY_NEXT_STATE = "next-state"
        const val KEY_NEXT_REGISTRY = "next-registry"
        const val KEY_NEXT_BOUND_AT = "next-bound-at"
        const val KEY_NEXT_LAST_SYNC = "next-last-sync"
        const val KEY_NEXT_INSTANCE_EPOCH = "next-instance-epoch"
        const val KEY_PROFILE_ID = "profile-id"
        const val KEY_PROFILE_URL = "profile-url"
        const val KEY_PROFILE_NAME = "profile-name"
        const val KEY_PROFILE_TLS = "profile-tls"
        const val KEY_PROFILE_PINS = "profile-pins"
        const val KEY_PROFILE_CREATED = "profile-created"
        const val KEY_PROFILE_LAST_USED = "profile-last-used"
        const val KEY_SETTINGS_AUTOMATIC = "settings-automatic"
        const val KEY_SETTINGS_INTERVAL = "settings-interval"
        const val KEY_SETTINGS_NETWORK = "settings-network"
    }
}

internal class SharedPreferencesBindingTeardownJournal(
    context: Context,
) : BindingTeardownJournal {
    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun pending(): BindingTeardownScope? {
        if (!preferences.contains(KEY_STATE)) return null
        check(preferences.getInt(KEY_VERSION, -1) == VERSION) { "unsupported binding teardown journal" }
        check(preferences.getString(KEY_STATE, null) == STATE_PENDING) { "invalid binding teardown state" }
        return BindingTeardownScope(
            serverProfileId = requiredString(KEY_SERVER),
            userId = requiredString(KEY_USER),
            deviceId = requiredString(KEY_DEVICE),
            generation = requiredString(KEY_GENERATION),
        )
    }

    override fun persist(scope: BindingTeardownScope) {
        val existing = pending()
        check(existing == null || existing == scope) { "another binding teardown is still pending" }
        if (existing == scope) return
        check(
            preferences.edit()
                .putInt(KEY_VERSION, VERSION)
                .putString(KEY_STATE, STATE_PENDING)
                .putString(KEY_SERVER, scope.serverProfileId)
                .putString(KEY_USER, scope.userId)
                .putString(KEY_DEVICE, scope.deviceId)
                .putString(KEY_GENERATION, scope.generation)
                .commit(),
        ) { "binding teardown journal could not be persisted" }
    }

    override fun clear(scope: BindingTeardownScope) {
        val existing = pending() ?: return
        check(existing == scope) { "binding teardown journal scope changed" }
        check(preferences.edit().clear().commit()) { "binding teardown journal could not be cleared" }
    }

    private fun requiredString(key: String): String =
        checkNotNull(preferences.getString(key, null)) { "incomplete binding teardown journal" }

    private companion object {
        const val PREFERENCES = "zephyr-one-binding-teardown"
        const val VERSION = 1
        const val STATE_PENDING = "TEARDOWN_PENDING"
        const val KEY_VERSION = "version"
        const val KEY_STATE = "state"
        const val KEY_SERVER = "server-profile-id"
        const val KEY_USER = "user-id"
        const val KEY_DEVICE = "device-id"
        const val KEY_GENERATION = "generation"
    }
}

internal class SharedPreferencesNoAccountCleanupJournal(
    context: Context,
) : NoAccountCleanupJournal {
    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun pending(): Boolean {
        if (!preferences.contains(KEY_STATE)) return false
        check(preferences.getInt(KEY_VERSION, -1) == VERSION) { "unsupported no-account cleanup journal" }
        check(preferences.getString(KEY_STATE, null) == STATE_PENDING) { "invalid no-account cleanup state" }
        return true
    }

    override fun persist() {
        if (pending()) return
        check(
            preferences.edit()
                .putInt(KEY_VERSION, VERSION)
                .putString(KEY_STATE, STATE_PENDING)
                .commit(),
        ) { "no-account cleanup journal could not be persisted" }
    }

    override fun clear() {
        if (!pending()) return
        check(preferences.edit().clear().commit()) { "no-account cleanup journal could not be cleared" }
    }

    private companion object {
        const val PREFERENCES = "zephyr-one-no-account-cleanup"
        const val VERSION = 1
        const val STATE_PENDING = "CLEANUP_PENDING"
        const val KEY_VERSION = "version"
        const val KEY_STATE = "state"
    }
}
