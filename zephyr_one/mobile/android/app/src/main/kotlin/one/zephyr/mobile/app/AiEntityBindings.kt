package one.zephyr.mobile.app

import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.mapper.AiProviderSyncMappers
import one.zephyr.mobile.data.repository.LocalAiEnvironment
import one.zephyr.mobile.data.repository.LocalAiMemory
import one.zephyr.mobile.data.repository.LocalAiProvider
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.data.repository.LocalAiSkill
import one.zephyr.mobile.data.repository.LocalAiTodo
import one.zephyr.mobile.data.repository.OwnedAiRepository
import one.zephyr.mobile.model.AiEnv
import one.zephyr.mobile.model.AiMemory
import one.zephyr.mobile.model.AiProvider
import one.zephyr.mobile.model.AiSkill
import one.zephyr.mobile.model.AiTodo
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.SecretState.Replace

/**
 * Entity bindings for the One AI catalog. Each binding adapts one catalog
 * list (device authority) to one mirror entity (server picture) with the
 * generic [EntityBinding] surface.
 *
 * Secret rule (D1/D2): pushing a provider carries the local apiKey through
 * the secret envelope; pulling NEVER overwrites a local key — the mirror row
 * carries presence only, and a mirrored row merged into the catalog keeps
 * whatever key this device already holds in its SecretStore. The own-key
 * bootstrap (device with no key for a synced own provider) fetches the key
 * once through the main-side runtime channel (AiRuntimeApi.startRun does not
 * need the key on-device; DIRECT routing needs it and resolves via the
 * provider detail endpoint on first use).
 */

/** A local row plus borrowed sync bookkeeping. */
internal data class LocalRow<T>(
    val row: T,
    override val syncId: String,
    override val syncRevision: Long,
    override val syncDeletedAt: Long? = null,
) : SyncedRow

/** A mirror model row viewed as a [SyncedRow]. */
internal data class MirrorRow<T>(
    val row: T,
    override val syncId: String,
    override val syncRevision: Long,
    override val syncDeletedAt: Long?,
) : SyncedRow

/**
 * Typed unpacking for a binding's rows. The wrapper pair is closed
 * (LocalRow/MirrorRow are the only SyncedRow implementations), so each cast
 * is sound by construction; suppressing it in one place keeps the five
 * bindings free of thirty @Suppress sites.
 */
@Suppress("UNCHECKED_CAST")
internal fun <T> SyncedRow.unpackLocal(): T? = (this as? LocalRow<*>)?.row as? T

@Suppress("UNCHECKED_CAST")
internal fun <T> SyncedRow.unpackMirror(): T? = (this as? MirrorRow<*>)?.row as? T

internal class TodoBinding(
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
) : EntityBinding {
    override val entityType = AiTodo.ENTITY_TYPE

    override suspend fun localRows(): List<SyncedRow> =
        localAi.load().todos.map { LocalRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun mirrorRows(owner: String): List<SyncedRow> =
        ownedAi.listTodosWithTombstones(owner).map { MirrorRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun applyMerged(rows: List<SyncedRow>) {
        val catalog = localAi.load()
        val merged = rows.mapNotNull { it.unpackLocal<LocalAiTodo>() }
        localAi.save(catalog.copy(todos = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val todo = row.unpackLocal<LocalAiTodo>()!!
        ownedAi.saveTodo(
            AiTodo(
                id = todo.id, ownerUserId = owner, title = todo.title,
                description = todo.description, status = todo.status, priority = todo.priority,
                dueAt = todo.dueAt, note = todo.note, source = todo.source,
                steps = todo.steps.map { one.zephyr.mobile.model.AiTodoStep(it.id, it.title, it.done) },
            ),
            mask = listOf("title", "description", "status", "priority", "dueAt", "steps", "note", "source"),
            ownerUserId = owner,
        )
    }

    override suspend fun pushDelete(id: String, owner: String) { ownedAi.delete(entityType, id, owner) }

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = a.unpackLocal<LocalAiTodo>() ?: a.unpackMirror<AiTodo>()?.toLocal()
        val y = b.unpackLocal<LocalAiTodo>() ?: b.unpackMirror<AiTodo>()?.toLocal()
        if (x == null || y == null) return false
        return x.title == y.title && x.description == y.description && x.status == y.status &&
            x.priority == y.priority && x.dueAt == y.dueAt && x.steps == y.steps &&
            x.note == y.note && x.source == y.source
    }

    private fun AiTodo.toLocal() = LocalAiTodo(
        id = id, title = title, description = description, status = status, priority = priority,
        dueAt = dueAt, steps = steps.map { one.zephyr.mobile.data.repository.LocalAiTodoStep(it.id, it.title, it.done) },
        note = note, source = source, revision = revision, deletedAt = deletedAt, updatedAt = updatedAt,
    )
}

internal class ProviderBinding(
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
) : EntityBinding {
    override val entityType = AiProvider.ENTITY_TYPE

    override suspend fun localRows(): List<SyncedRow> =
        localAi.load().providers.map { LocalRow(it, it.id, it.revision) }

    override suspend fun mirrorRows(owner: String): List<SyncedRow> =
        ownedAi.listProvidersWithTombstones(owner).map { MirrorRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun applyMerged(rows: List<SyncedRow>) {
        val catalog = localAi.load()
        val localRows = rows.mapNotNull { it.unpackLocal<LocalAiProvider>() }
        /* Merge into the catalog by id: a mirrored row replaces config fields
         * but NEVER the local secret (key stays in the SecretStore untouched). */
        val merged = catalog.providers.map { existing ->
            val incoming = localRows.firstOrNull { it.id == existing.id } ?: return@map existing
            incoming
        } + localRows.filter { incoming -> catalog.providers.none { it.id == incoming.id } }
        localAi.save(catalog.copy(providers = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val provider = row.unpackLocal<LocalAiProvider>()!!
        val apiKey = localAi.providerApiKey(provider.id)
        ownedAi.saveProvider(
            provider = provider.toModel(owner),
            mask = listOf(
                "name", "type", "baseUrl", "defaultModel", "models", "config",
                "visibility", "shareWithUsers", "shareWithAdmins", "sharedUserIds", "enabled",
            ),
            apiKey = if (apiKey != null) SecretState.Replace(apiKey.concatToString()) else SecretState.Unchanged,
            ownerUserId = owner,
        )
        if (apiKey != null) apiKey.fill(' ')
    }

    override suspend fun pushDelete(id: String, owner: String) { ownedAi.delete(entityType, id, owner) }

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = a.unpackLocal<LocalAiProvider>() ?: a.unpackMirror<AiProvider>()?.toLocal()
        val y = b.unpackLocal<LocalAiProvider>() ?: b.unpackMirror<AiProvider>()?.toLocal()
        if (x == null || y == null) return false
        return x.name == y.name && x.type == y.type && x.baseUrl == y.baseUrl &&
            x.defaultModel == y.defaultModel && x.models == y.models &&
            x.apiMode == y.apiMode && x.temperature == y.temperature && x.topP == y.topP &&
            x.maxTokens == y.maxTokens && x.maxOutputTokens == y.maxOutputTokens &&
            x.contextWindowTokens == y.contextWindowTokens &&
            x.reasoningEffort == y.reasoningEffort && x.visionDefault == y.visionDefault &&
            x.usePreviousResponse == y.usePreviousResponse &&
            x.presencePenalty == y.presencePenalty && x.frequencyPenalty == y.frequencyPenalty &&
            x.visibility == y.visibility && x.shareWithUsers == y.shareWithUsers &&
            x.shareWithAdmins == y.shareWithAdmins && x.sharedUserIds == y.sharedUserIds &&
            x.enabled == y.enabled
    }

    private fun AiProvider.toLocal(): LocalAiProvider = AiProviderSyncMappers.toLocal(this, "main")

    private fun LocalAiProvider.toModel(owner: String): AiProvider = AiProviderSyncMappers.toModel(this, owner)
}

internal class MemoryBinding(
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
) : EntityBinding {
    override val entityType = AiMemory.ENTITY_TYPE

    override suspend fun localRows(): List<SyncedRow> =
        localAi.load().memories.map { LocalRow(it, it.id, it.revision) }

    override suspend fun mirrorRows(owner: String): List<SyncedRow> =
        ownedAi.listMemoriesWithTombstones(owner).map { MirrorRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun applyMerged(rows: List<SyncedRow>) {
        val catalog = localAi.load()
        val merged = rows.mapNotNull { it.unpackLocal<LocalAiMemory>() }
        localAi.save(catalog.copy(memories = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val memory = row.unpackLocal<LocalAiMemory>()!!
        ownedAi.saveMemory(
            AiMemory(id = memory.id, ownerUserId = owner, title = memory.title, content = memory.content),
            mask = listOf("title", "content"),
            ownerUserId = owner,
        )
    }

    override suspend fun pushDelete(id: String, owner: String) { ownedAi.delete(entityType, id, owner) }

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = a.unpackLocal<LocalAiMemory>() ?: a.unpackMirror<AiMemory>()?.toLocal()
        val y = b.unpackLocal<LocalAiMemory>() ?: b.unpackMirror<AiMemory>()?.toLocal()
        if (x == null || y == null) return false
        return x.title == y.title && x.content == y.content && x.scope == y.scope && x.tags == y.tags
    }

    private fun AiMemory.toLocal() = LocalAiMemory(
        id = id, title = title, content = content, scope = scope, project = project,
        connectionIds = connectionIds, tags = tags, enabled = enabled, revision = revision,
    )
}

internal class SkillBinding(
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
) : EntityBinding {
    override val entityType = AiSkill.ENTITY_TYPE

    override suspend fun localRows(): List<SyncedRow> =
        localAi.load().skills.map { LocalRow(it, it.id, it.revision) }

    override suspend fun mirrorRows(owner: String): List<SyncedRow> =
        ownedAi.listSkillsWithTombstones(owner).map { MirrorRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun applyMerged(rows: List<SyncedRow>) {
        val catalog = localAi.load()
        val merged = rows.mapNotNull { it.unpackLocal<LocalAiSkill>() }
        localAi.save(catalog.copy(skills = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val skill = row.unpackLocal<LocalAiSkill>()!!
        ownedAi.saveSkill(
            AiSkill(id = skill.id, ownerUserId = owner, name = skill.name, description = skill.description, prompt = skill.prompt),
            mask = listOf("name", "description", "prompt"),
            ownerUserId = owner,
        )
    }

    override suspend fun pushDelete(id: String, owner: String) { ownedAi.delete(entityType, id, owner) }

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = a.unpackLocal<LocalAiSkill>() ?: a.unpackMirror<AiSkill>()?.toLocal()
        val y = b.unpackLocal<LocalAiSkill>() ?: b.unpackMirror<AiSkill>()?.toLocal()
        if (x == null || y == null) return false
        return x.name == y.name && x.description == y.description && x.prompt == y.prompt
    }

    private fun AiSkill.toLocal() = LocalAiSkill(
        id = id, name = name, description = description, prompt = prompt, enabled = enabled, revision = revision,
    )
}

internal class EnvBinding(
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
) : EntityBinding {
    override val entityType = AiEnv.ENTITY_TYPE

    override suspend fun localRows(): List<SyncedRow> =
        localAi.load().environment.map { LocalRow(it, it.id, it.revision) }

    override suspend fun mirrorRows(owner: String): List<SyncedRow> =
        ownedAi.listEnvWithTombstones(owner).map { MirrorRow(it, it.id, it.revision, it.deletedAt) }

    override suspend fun applyMerged(rows: List<SyncedRow>) {
        val catalog = localAi.load()
        val merged = rows.mapNotNull { it.unpackLocal<LocalAiEnvironment>() }
        localAi.save(catalog.copy(environment = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val env = row.unpackLocal<LocalAiEnvironment>()!!
        val value = localAi.environmentValue(env.id)
        ownedAi.saveEnv(
            AiEnv(id = env.id, ownerUserId = owner, name = env.name),
            mask = listOf("name"),
            value = if (value != null) SecretState.Replace(value.concatToString()) else SecretState.Unchanged,
            ownerUserId = owner,
        )
        if (value != null) value.fill(' ')
    }

    override suspend fun pushDelete(id: String, owner: String) { ownedAi.delete(entityType, id, owner) }

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = a.unpackLocal<LocalAiEnvironment>() ?: a.unpackMirror<AiEnv>()?.toLocal()
        val y = b.unpackLocal<LocalAiEnvironment>() ?: b.unpackMirror<AiEnv>()?.toLocal()
        if (x == null || y == null) return false
        return x.name == y.name && x.enabled == y.enabled && x.visibleToAi == y.visibleToAi
    }

    private fun AiEnv.toLocal() = LocalAiEnvironment(
        id = id, name = name, enabled = enabled, revision = revision,
    )
}
