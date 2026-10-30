package one.zephyr.mobile.app.di

import androidx.room.withTransaction
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.*
import one.zephyr.mobile.data.db.DevicePreferenceRow
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.security.LockState
import one.zephyr.mobile.security.SecretStore
import one.zephyr.mobile.model.SecretRef

/** User-visible first-bind choice. Nothing here is an automatic account migration. */
data class LocalImportView(
    val required: Boolean = false,
    val counts: Map<String, Int> = emptyMap(),
    val decision: String? = null,
    val busy: Boolean = false,
    val ready: Boolean = false,
    val error: String? = null,
    val pendingTypes: Set<String>? = null,
    val pendingCredentials: Boolean = false,
)

internal class LocalImportCoordinator(private val target: AccountContainer, private val app: AppContainer) {
    private val mutex = Mutex()
    private val _view = MutableStateFlow(LocalImportView())
    val view: StateFlow<LocalImportView> = _view.asStateFlow()
    private val preferenceKey = "link.firstImport.v1"

    private val sourceBinding = app.localImportBinding()
    private val sourceGeneration = AccountContainer.generationOf(sourceBinding)

    private suspend fun sourceRows(): List<MirrorEntityRow> = withSource { source ->
        val mirror = EntityRegistry.entities.flatMap { source.mirrorDao().listByType(it.type, sourceBinding.userId) }
        val raw = source.devicePreferenceDao().find(LocalAiRepository.PREF_CATALOG)?.valueJson
            ?: return@withSource mirror
        val catalog = LocalImportCatalog.sources(LocalImportCatalog.decode(raw), sourceBinding.userId).map {
            MirrorEntityRow(it.type, it.id, sourceBinding.userId, 0L, it.payload.toString(), "{}", null, null, 0L)
        }
        // The catalog is device authority for its five AI types; prefer it over a stale sync mirror.
        (catalog + mirror).distinctBy { it.entityType to it.entityId }
    }

    private suspend fun <T> withSource(block: suspend (ZephyrDatabase) -> T): T {
        check(AccountContainer.generationOf(app.localImportBinding()) == sourceGeneration) { "Local workspace changed" }
        // The manager owns this handle. Closing it here could close a concurrently restored local
        // workspace, or leave a closed handle cached in AccountDatabaseManager.
        return block(app.accountDatabases.open(AccountContainer.databaseScopeOf(sourceBinding)).database)
    }

    private fun assertCurrent() {
        check(app.account === target && target.acceptsLocalImport) { "Binding changed; reopen the import preview" }
        check(app.appLock.state.value != LockState.LOCKED) { "Unlock before importing local data" }
        check(AccountContainer.generationOf(app.localImportBinding()) == sourceGeneration) { "Local workspace changed" }
    }

    suspend fun prepare() = mutex.withLock {
        if (target.localMode) return@withLock
        try {
            refreshView(armGate = true)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // A source-open failure must not permit a first push by looking like an empty source.
            target.syncState.setImportDecisionRequired(target.bindingKey, true)
            _view.value = LocalImportView(required = true, error = "本机数据暂时无法读取，请解锁后重试")
        }
    }

    suspend fun refresh() = mutex.withLock {
        assertCurrent()
        refreshView(armGate = false)
    }

    private suspend fun refreshView(armGate: Boolean) {
        val saved = preference(preferenceKey)
        val decision = saved?.get("decision")?.jsonPrimitive?.contentOrNull
        val pending = preference("$preferenceKey.batch")
        val counts = sourceRows().filter { it.entityType != "activityEvent" }.groupingBy { it.entityType }.eachCount()
        if (armGate && (pending != null || (counts.isNotEmpty() && decision == null))) {
            target.syncState.setImportDecisionRequired(target.bindingKey, true)
        }
        val state = target.syncState.state(target.bindingKey)
        _view.value = LocalImportView(
            required = state?.importDecisionRequired == true,
            counts = counts,
            decision = decision,
            ready = !target.accountDatabaseRequiresBootstrap(),
            pendingTypes = pending?.get("copies")?.jsonArray?.map { it.jsonObject.getValue("type").jsonPrimitive.content }?.toSet(),
            pendingCredentials = pending?.get("includeCredentials")?.jsonPrimitive?.booleanOrNull == true,
        )
    }

    private suspend fun preference(key: String): JsonObject? = target.database.devicePreferenceDao().find(key)
        ?.valueJson?.let { Json.parseToJsonElement(it).jsonObject }

    suspend fun decide(copyTypes: Set<String>, includeCredentials: Boolean, confirmed: Boolean) {
        mutex.withLock {
            assertCurrent()
            _view.value = _view.value.copy(busy = true, error = null)
            try {
                target.syncEngine.withExclusiveLocalWrite {
                    assertCurrent()
                    check(!target.accountDatabaseRequiresBootstrap()) { "请等待账户快照下载完成后再导入" }
                    check(target.syncState.importDecisionRequired(target.bindingKey)) { "该绑定已经完成导入选择" }
                    val pending = preference("$preferenceKey.batch")
                    if (copyTypes.isEmpty()) {
                        check(pending == null) { "已有复制批次，请继续完成复制；不能将部分副本作为仅本机数据上传" }
                        saveDecision("keep_local")
                    } else {
                        check(confirmed) { "复制前需要明确确认" }
                        copySelected(copyTypes, includeCredentials, pending)
                        saveDecision("copy_as_new")
                    }
                }
                _view.value = _view.value.copy(required = false, busy = false,
                    decision = if (copyTypes.isEmpty()) "keep_local" else "copy_as_new")
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                _view.value = _view.value.copy(busy = false)
                throw cancelled
            } catch (_: Exception) {
                // Do not expose provider/decryption exception messages or source payloads to UI.
                runCatching { refreshView(armGate = false) }
                _view.value = _view.value.copy(busy = false, error = "导入未完成，未解除上传门禁。请检查依赖类型并重试；凭据可选择不复制。")
                return
            }
        }
        // The actor must not be invoked while holding its exclusive local-write lock.
        target.syncEngine.syncNow()
    }

    private suspend fun saveDecision(decision: String) {
        assertCurrent()
        target.database.withTransaction {
            assertCurrent()
            check(target.database.syncStateDao().find(target.bindingKey) != null) { "Missing binding state" }
            target.database.devicePreferenceDao().upsert(DevicePreferenceRow(preferenceKey,
                buildJsonObject { put("decision", decision) }.toString(), System.currentTimeMillis()))
            target.database.devicePreferenceDao().delete("$preferenceKey.batch")
            target.database.syncStateDao().updateImportDecisionRequired(target.bindingKey, false)
        }
    }

    private suspend fun copySelected(types: Set<String>, includeCredentials: Boolean, pending: JsonObject?) {
        val sourceSecrets = SecretStore(
            blobs = app.secretBlobs,
            scope = SecretStore.SecretScope(sourceBinding.serverProfileId, sourceBinding.userId,
                sourceBinding.deviceId, sourceGeneration),
        )
        app.appLock.register(sourceSecrets)
        try {
            val rows = sourceRows()
            val plan = if (pending == null) {
                LocalImportPlanner.plan(rows.map { LocalImportSource(it.entityType, it.entityId, EntityCodec.parse(it.payloadJson)) }, types)
            } else {
                check(pending.getValue("sourceGeneration").jsonPrimitive.content == sourceGeneration) { "Source generation changed" }
                check(pending.getValue("includeCredentials").jsonPrimitive.boolean == includeCredentials) { "Resume the original credential choice" }
                pending.getValue("copies").jsonArray.map { element ->
                    val row = element.jsonObject
                    LocalImportCopy(row.getValue("type").jsonPrimitive.content, row.getValue("sourceId").jsonPrimitive.content,
                        row.getValue("newId").jsonPrimitive.content, row.getValue("values").jsonObject)
                }.also { check(it.map { copy -> copy.type }.toSet() == types) { "Resume the original type selection" } }
            }
            // Preflight every selected credential before creating a durable batch. No partial copy
            // is created if the initial dependency/credential check fails.
            if (includeCredentials) for (copy in plan) {
                val key = receiptKey(copy)
                if (target.database.devicePreferenceDao().find(key) == null) {
                    val row = rows.single { it.entityType == copy.type && it.entityId == copy.sourceId }
                    for (field in EntityRegistry.byType.getValue(copy.type).secretFields) {
                        readSecret(sourceSecrets, row, field)?.wipe()
                    }
                }
            }
            assertCurrent()
            if (pending == null) {
                val batch = buildJsonObject {
                    put("sourceGeneration", sourceGeneration)
                    put("includeCredentials", includeCredentials)
                    putJsonArray("copies") {
                        for (copy in plan) add(buildJsonObject {
                            put("type", copy.type); put("sourceId", copy.sourceId); put("newId", copy.newId); put("values", copy.values)
                        })
                    }
                }
                target.database.devicePreferenceDao().upsert(DevicePreferenceRow("$preferenceKey.batch", batch.toString(), System.currentTimeMillis()))
            }
            for (copy in plan) {
                assertCurrent()
                val receipt = receiptKey(copy)
                if (target.database.devicePreferenceDao().find(receipt) != null) continue
                val row = rows.single { it.entityType == copy.type && it.entityId == copy.sourceId }
                val spec = EntityRegistry.byType.getValue(copy.type)
                val secrets = linkedMapOf<String, SecretState>()
                try {
                    if (includeCredentials) for (field in spec.secretFields) {
                        readSecret(sourceSecrets, row, field)?.let { secrets[field] = it }
                    }
                    target.writeGateway.apply(
                        edit = LocalEdit(
                            entityType = copy.type, entityId = copy.newId, action = SyncAction.UPSERT,
                            requestedMask = spec.editableFields.filter { path ->
                                path.split('.').fold(copy.values as JsonElement?) { node, part -> (node as? JsonObject)?.get(part) } != null
                            },
                            values = copy.values, secrets = secrets, createdLocally = true,
                        ),
                        ownerUserId = target.binding.userId,
                        commitReceipt = DevicePreferenceRow(receipt, "copied", System.currentTimeMillis()),
                        requireAbsent = true,
                        commitGuard = ::assertCurrent,
                    )
                } finally {
                    secrets.values.filterIsInstance<SecretState.Replace>().forEach { it.wipe() }
                }
            }
        } finally {
            app.appLock.unregister(sourceSecrets)
            sourceSecrets.evictPlaintextCache()
        }
    }

    private fun receiptKey(copy: LocalImportCopy): String = "$preferenceKey.copy.${copy.type}.${copy.newId}"

    private fun readSecret(store: SecretStore, row: MirrorEntityRow, field: String): SecretState.Replace? {
        assertCurrent()
        val presence = EntityCodec.parse(row.secretPresenceJson)
        val flag = "has" + field.replaceFirstChar { it.uppercaseChar() }
        val refs = buildList {
            add(SecretRef.of(row.entityType, row.entityId, field))
            if (row.entityType == "aiEnv") add(SecretRef.of(LocalAiRepository.ENV_ENTITY, row.entityId, field))
        }
        val ref = refs.firstOrNull(store::has)
        if (ref == null && !EntityCodec.bool(presence, flag, false)) return null
        val bytes = ref?.let(store::get) ?: error("Selected source credential is unavailable")
        return try {
            assertCurrent()
            SecretState.Replace.fromUtf8(bytes)
        } finally { bytes.fill(0) }
    }
}
