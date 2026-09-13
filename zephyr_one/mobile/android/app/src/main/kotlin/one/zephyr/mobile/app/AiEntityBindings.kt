package one.zephyr.mobile.app

import one.zephyr.mobile.contracts.SyncAction
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
        val merged = rows.mapNotNull { (it as? LocalRow<LocalAiTodo>)?.row }
        localAi.save(catalog.copy(todos = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val todo = (row as LocalRow<LocalAiTodo>).row
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

    override suspend fun pushDelete(id: String, owner: String) = ownedAi.delete(entityType, id, owner)

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = (a as? LocalRow<LocalAiTodo>)?.row ?: (a as? MirrorRow<AiTodo>)?.row?.toLocal()
        val y = (b as? LocalRow<LocalAiTodo>)?.row ?: (b as? MirrorRow<AiTodo>)?.row?.toLocal()
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
        val localRows = rows.mapNotNull { (it as? LocalRow<LocalAiProvider>)?.row }
        /* Merge into the catalog by id: a mirrored row replaces config fields
         * but NEVER the local secret (key stays in the SecretStore untouched). */
        val merged = catalog.providers.map { existing ->
            val incoming = localRows.firstOrNull { it.id == existing.id } ?: return@map existing
            incoming
        } + localRows.filter { incoming -> catalog.providers.none { it.id == incoming.id } }
        localAi.save(catalog.copy(providers = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val provider = (row as LocalRow<LocalAiProvider>).row
        val apiKey = localAi.providerApiKey(provider.id)
        ownedAi.saveProvider(
            provider = provider.toModel(owner),
            mask = listOf(
                "name", "type", "baseUrl", "defaultModel", "models", "config",
                "enabled",
            ),
            apiKey = if (apiKey != null) SecretState.Set(apiKey.concatToString()) else SecretState.None,
            ownerUserId = owner,
        )
        if (apiKey != null) apiKey.fill(' ')
    }

    override suspend fun pushDelete(id: String, owner: String) = ownedAi.delete(entityType, id, owner)

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = (a as? LocalRow<LocalAiProvider>)?.row ?: (a as? MirrorRow<AiProvider>)?.row?.toLocal()
        val y = (b as? LocalRow<LocalAiProvider>)?.row ?: (b as? MirrorRow<AiProvider>)?.row?.toLocal()
        if (x == null || y == null) return false
        return x.name == y.name && x.type == y.type && x.baseUrl == y.baseUrl &&
            x.defaultModel == y.defaultModel && x.models == y.models && x.enabled == y.enabled
    }

    private fun AiProvider.toLocal() = LocalAiProvider(
        id = id, name = name, type = type, baseUrl = baseUrl, apiMode = config.apiMode,
        defaultModel = defaultModel,
        models = models.map { m -> LocalAiModel(id = m.id, label = m.label, contextWindowTokens = m.contextWindowTokens) },
        enabled = enabled, source = "main", revision = revision,
    )

    private fun LocalAiProvider.toModel(owner: String) = AiProvider(
        id = id, ownerUserId = owner, name = name, type = type, baseUrl = baseUrl,
        defaultModel = defaultModel,
        models = models.map { m -> AiModel(id = m.id, label = m.label, contextWindowTokens = m.contextWindowTokens) },
        config = AiProviderConfig(apiMode = apiMode),
        enabled = enabled,
    )
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
        val merged = rows.mapNotNull { (it as? LocalRow<LocalAiMemory>)?.row }
        localAi.save(catalog.copy(memories = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val memory = (row as LocalRow<LocalAiMemory>).row
        ownedAi.saveMemory(
            AiMemory(id = memory.id, ownerUserId = owner, title = memory.title, content = memory.content),
            mask = listOf("title", "content"),
            ownerUserId = owner,
        )
    }

    override suspend fun pushDelete(id: String, owner: String) = ownedAi.delete(entityType, id, owner)

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = (a as? LocalRow<LocalAiMemory>)?.row ?: (a as? MirrorRow<AiMemory>)?.row?.toLocal()
        val y = (b as? LocalRow<LocalAiMemory>)?.row ?: (b as? MirrorRow<AiMemory>)?.row?.toLocal()
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
        val merged = rows.mapNotNull { (it as? LocalRow<LocalAiSkill>)?.row }
        localAi.save(catalog.copy(skills = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val skill = (row as LocalRow<LocalAiSkill>).row
        ownedAi.saveSkill(
            AiSkill(id = skill.id, ownerUserId = owner, name = skill.name, description = skill.description, prompt = skill.prompt),
            mask = listOf("name", "description", "prompt"),
            ownerUserId = owner,
        )
    }

    override suspend fun pushDelete(id: String, owner: String) = ownedAi.delete(entityType, id, owner)

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = (a as? LocalRow<LocalAiSkill>)?.row ?: (a as? MirrorRow<AiSkill>)?.row?.toLocal()
        val y = (b as? LocalRow<LocalAiSkill>)?.row ?: (b as? MirrorRow<AiSkill>)?.row?.toLocal()
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
        val merged = rows.mapNotNull { (it as? LocalRow<LocalAiEnvironment>)?.row }
        localAi.save(catalog.copy(environment = merged))
    }

    override suspend fun pushUpsert(row: SyncedRow, owner: String) {
        val env = (row as LocalRow<LocalAiEnvironment>).row
        val value = localAi.environmentValue(env.id)
        ownedAi.saveEnv(
            AiEnv(id = env.id, ownerUserId = owner, name = env.name),
            mask = listOf("name"),
            value = if (value != null) SecretState.Set(value.concatToString()) else SecretState.None,
            ownerUserId = owner,
        )
        if (value != null) value.fill(' ')
    }

    override suspend fun pushDelete(id: String, owner: String) = ownedAi.delete(entityType, id, owner)

    override fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean {
        val x = (a as? LocalRow<LocalAiEnvironment>)?.row ?: (a as? MirrorRow<AiEnv>)?.row?.toLocal()
        val y = (b as? LocalRow<LocalAiEnvironment>)?.row ?: (b as? MirrorRow<AiEnv>)?.row?.toLocal()
        if (x == null || y == null) return false
        return x.name == y.name && x.enabled == y.enabled && x.visibleToAi == y.visibleToAi
    }

    private fun AiEnv.toLocal() = LocalAiEnvironment(
        id = id, name = name, description = description, enabled = enabled, revision = revision,
    )
}
