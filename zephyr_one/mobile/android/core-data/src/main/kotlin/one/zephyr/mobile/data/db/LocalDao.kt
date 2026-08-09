package one.zephyr.mobile.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ServerProfileDao {

    @Query("SELECT * FROM server_profiles ORDER BY lastUsedAt DESC, displayName")
    fun observeAll(): Flow<List<ServerProfileRow>>

    @Query("SELECT * FROM server_profiles WHERE id = :id")
    suspend fun find(id: String): ServerProfileRow?

    @Upsert
    suspend fun upsert(row: ServerProfileRow)

    @Query("DELETE FROM server_profiles WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface AccountBindingDao {

    @Query("SELECT * FROM account_bindings LIMIT 1")
    fun observeActive(): Flow<AccountBindingRow?>

    @Query("SELECT * FROM account_bindings LIMIT 1")
    suspend fun active(): AccountBindingRow?

    @Query("SELECT * FROM account_bindings WHERE serverProfileId = :serverProfileId")
    suspend fun find(serverProfileId: String): AccountBindingRow?

    @Upsert
    suspend fun upsert(row: AccountBindingRow)

    @Query("UPDATE account_bindings SET state = :state WHERE serverProfileId = :serverProfileId")
    suspend fun updateState(serverProfileId: String, state: String)

    @Query("UPDATE account_bindings SET automaticEnabled = :enabled WHERE serverProfileId = :serverProfileId")
    suspend fun updateAutomatic(serverProfileId: String, enabled: Boolean)

    @Query("UPDATE account_bindings SET syncIntervalSec = :seconds WHERE serverProfileId = :serverProfileId")
    suspend fun updateInterval(serverProfileId: String, seconds: Int)

    @Query("UPDATE account_bindings SET networkPolicy = :policy WHERE serverProfileId = :serverProfileId")
    suspend fun updateNetworkPolicy(serverProfileId: String, policy: String)

    @Query("DELETE FROM account_bindings")
    suspend fun deleteAll()
}

@Dao
interface DevicePreferenceDao {

    @Query("SELECT * FROM device_preferences")
    fun observeAll(): Flow<List<DevicePreferenceRow>>

    @Query("SELECT * FROM device_preferences WHERE key = :key")
    suspend fun find(key: String): DevicePreferenceRow?

    @Upsert
    suspend fun upsert(row: DevicePreferenceRow)

    @Query("DELETE FROM device_preferences WHERE key = :key")
    suspend fun delete(key: String)
}

@Dao
interface TrustedCertificateDao {

    @Query("SELECT * FROM trusted_certificates ORDER BY trustedAt DESC")
    fun observeAll(): Flow<List<TrustedCertificateRow>>

    @Query("SELECT * FROM trusted_certificates WHERE hostKey = :hostKey")
    suspend fun find(hostKey: String): TrustedCertificateRow?

    @Upsert
    suspend fun upsert(row: TrustedCertificateRow)

    @Query("DELETE FROM trusted_certificates WHERE hostKey = :hostKey")
    suspend fun delete(hostKey: String)

    @Query("DELETE FROM trusted_certificates")
    suspend fun deleteAll()
}
