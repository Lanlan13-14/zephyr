package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalEditResult
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.SshKey

/** Proxies, SSH keys and jump hosts: the three connection dependencies. */
class ResourceRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
) {

    fun observeProxies(ownerUserId: String): Flow<List<Proxy>> =
        db.mirrorDao().observeByType(Proxy.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::proxy) }

    fun observeSshKeys(ownerUserId: String): Flow<List<SshKey>> =
        db.mirrorDao().observeByType(SshKey.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::sshKey) }

    fun observeJumpHosts(ownerUserId: String): Flow<List<JumpHost>> =
        db.mirrorDao().observeByType(JumpHost.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::jumpHost) }

    suspend fun findProxy(id: String): Proxy? =
        db.mirrorDao().find(Proxy.ENTITY_TYPE, id)?.let(ResourceMappers::proxy)

    suspend fun findSshKey(id: String): SshKey? =
        db.mirrorDao().find(SshKey.ENTITY_TYPE, id)?.let(ResourceMappers::sshKey)

    suspend fun findJumpHost(id: String): JumpHost? =
        db.mirrorDao().find(JumpHost.ENTITY_TYPE, id)?.let(ResourceMappers::jumpHost)

    suspend fun saveProxy(
        proxy: Proxy,
        mask: List<String>,
        password: SecretState = SecretState.Unchanged,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Proxy.ENTITY_TYPE,
            entityId = proxy.id,
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.proxyValues(proxy),
            secrets = mapOf("password" to password),
            residency = proxy.residency,
            capabilities = proxy.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveSshKey(
        key: SshKey,
        mask: List<String>,
        privateKey: SecretState = SecretState.Unchanged,
        passphrase: SecretState = SecretState.Unchanged,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = SshKey.ENTITY_TYPE,
            entityId = key.id,
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.sshKeyValues(key),
            secrets = mapOf("privateKey" to privateKey, "passphrase" to passphrase),
            residency = key.residency,
            capabilities = key.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveJumpHost(
        host: JumpHost,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = JumpHost.ENTITY_TYPE,
            entityId = host.id,
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.jumpHostValues(host),
            residency = host.residency,
            capabilities = host.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun delete(entityType: String, entityId: String, ownerUserId: String): LocalEditResult =
        gateway.apply(
            LocalEdit(
                entityType = entityType,
                entityId = entityId,
                action = SyncAction.DELETE,
                requestedMask = emptyList(),
                values = JsonObject(emptyMap()),
            ),
            ownerUserId = ownerUserId,
        )
}
