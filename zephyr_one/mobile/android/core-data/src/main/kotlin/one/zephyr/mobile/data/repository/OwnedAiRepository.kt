package one.zephyr.mobile.data.repository

import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalEditResult
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.model.AiConversationRecord
import one.zephyr.mobile.model.AiEnv
import one.zephyr.mobile.model.AiMemory
import one.zephyr.mobile.model.AiMessageRecord
import one.zephyr.mobile.model.AiProvider
import one.zephyr.mobile.model.AiSkill
import one.zephyr.mobile.model.SecretState

/**
 * Owned AI entities that ride the main-end change feed.
 *
 * Local catalog ([LocalAiRepository]) is device authority and never required for a bound
 * account to apply these rows. This repository is the only path that turns a mirrored
 * aiProvider/aiMemory/aiSkill/aiEnv/aiConversation/aiMessage into a local write that can
 * push back.
 */
class OwnedAiRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
) {

    fun observeProviders(ownerUserId: String): Flow<List<AiProvider>> =
        db.mirrorDao().observeByType(AiProvider.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::aiProvider) }
            .flowOn(Dispatchers.Default)

    fun observeMemories(ownerUserId: String): Flow<List<AiMemory>> =
        db.mirrorDao().observeByType(AiMemory.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::aiMemory) }
            .flowOn(Dispatchers.Default)

    fun observeSkills(ownerUserId: String): Flow<List<AiSkill>> =
        db.mirrorDao().observeByType(AiSkill.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::aiSkill) }
            .flowOn(Dispatchers.Default)

    fun observeEnv(ownerUserId: String): Flow<List<AiEnv>> =
        db.mirrorDao().observeByType(AiEnv.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::aiEnv) }
            .flowOn(Dispatchers.Default)

    fun observeConversations(ownerUserId: String): Flow<List<AiConversationRecord>> =
        db.mirrorDao().observeByType(AiConversationRecord.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::aiConversation) }
            .flowOn(Dispatchers.Default)

    suspend fun listProviders(ownerUserId: String): List<AiProvider> =
        db.mirrorDao().listByType(AiProvider.ENTITY_TYPE, ownerUserId).map(ResourceMappers::aiProvider)

    suspend fun listMemories(ownerUserId: String): List<AiMemory> =
        db.mirrorDao().listByType(AiMemory.ENTITY_TYPE, ownerUserId).map(ResourceMappers::aiMemory)

    suspend fun listSkills(ownerUserId: String): List<AiSkill> =
        db.mirrorDao().listByType(AiSkill.ENTITY_TYPE, ownerUserId).map(ResourceMappers::aiSkill)

    suspend fun listEnv(ownerUserId: String): List<AiEnv> =
        db.mirrorDao().listByType(AiEnv.ENTITY_TYPE, ownerUserId).map(ResourceMappers::aiEnv)

    suspend fun listConversations(ownerUserId: String): List<AiConversationRecord> =
        db.mirrorDao().listByType(AiConversationRecord.ENTITY_TYPE, ownerUserId).map(ResourceMappers::aiConversation)

    suspend fun listMessages(ownerUserId: String, conversationId: String): List<AiMessageRecord> =
        db.mirrorDao().listByType(AiMessageRecord.ENTITY_TYPE, ownerUserId)
            .map(ResourceMappers::aiMessage)
            .filter { it.conversationId == conversationId }

    suspend fun findProvider(id: String): AiProvider? =
        db.mirrorDao().find(AiProvider.ENTITY_TYPE, id)?.let(ResourceMappers::aiProvider)

    suspend fun findMemory(id: String): AiMemory? =
        db.mirrorDao().find(AiMemory.ENTITY_TYPE, id)?.let(ResourceMappers::aiMemory)

    suspend fun findSkill(id: String): AiSkill? =
        db.mirrorDao().find(AiSkill.ENTITY_TYPE, id)?.let(ResourceMappers::aiSkill)

    suspend fun findEnv(id: String): AiEnv? =
        db.mirrorDao().find(AiEnv.ENTITY_TYPE, id)?.let(ResourceMappers::aiEnv)

    suspend fun findConversation(id: String): AiConversationRecord? =
        db.mirrorDao().find(AiConversationRecord.ENTITY_TYPE, id)?.let(ResourceMappers::aiConversation)

    suspend fun saveProvider(
        provider: AiProvider,
        mask: List<String>,
        apiKey: SecretState = SecretState.Unchanged,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiProvider.ENTITY_TYPE,
            entityId = provider.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiProviderValues(provider),
            secrets = mapOf("apiKey" to apiKey),
            residency = provider.residency,
            capabilities = provider.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveMemory(
        memory: AiMemory,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiMemory.ENTITY_TYPE,
            entityId = memory.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiMemoryValues(memory),
            residency = memory.residency,
            capabilities = memory.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveSkill(
        skill: AiSkill,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiSkill.ENTITY_TYPE,
            entityId = skill.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiSkillValues(skill),
            residency = skill.residency,
            capabilities = skill.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveEnv(
        env: AiEnv,
        mask: List<String>,
        value: SecretState = SecretState.Unchanged,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiEnv.ENTITY_TYPE,
            entityId = env.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiEnvValues(env),
            secrets = mapOf("value" to value),
            residency = env.residency,
            capabilities = env.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveConversation(
        conversation: AiConversationRecord,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiConversationRecord.ENTITY_TYPE,
            entityId = conversation.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiConversationValues(conversation),
            residency = conversation.residency,
            capabilities = conversation.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun saveMessage(
        message: AiMessageRecord,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = AiMessageRecord.ENTITY_TYPE,
            entityId = message.id.ifBlank { UUID.randomUUID().toString() },
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ResourceMappers.aiMessageValues(message),
            residency = message.residency,
            capabilities = message.capabilities,
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
