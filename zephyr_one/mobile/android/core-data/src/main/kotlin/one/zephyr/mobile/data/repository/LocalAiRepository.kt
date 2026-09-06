package one.zephyr.mobile.data.repository

import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.db.DevicePreferenceRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.SecretStore

/** Device-local authority for the complete Zephyr AI configuration surface. */
class LocalAiRepository(
    private val db: ZephyrDatabase,
    private val secrets: SecretStore,
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) {
    fun observe(): Flow<LocalAiCatalog> = db.devicePreferenceDao().observeAll().map { rows ->
        rows.firstOrNull { it.key == PREF_CATALOG }?.valueJson?.let(::decode) ?: LocalAiCatalog()
    }

    suspend fun load(): LocalAiCatalog = db.devicePreferenceDao().find(PREF_CATALOG)?.valueJson?.let(::decode)
        ?: LocalAiCatalog()

    suspend fun save(next: LocalAiCatalog) {
        val normalized = next.normalized()
        db.devicePreferenceDao().upsert(
            DevicePreferenceRow(PREF_CATALOG, json.encodeToString(normalized), System.currentTimeMillis()),
        )
    }

    suspend fun upsertProvider(provider: LocalAiProvider, apiKey: CharArray?) {
        val current = load()
        val id = provider.id.ifBlank { UUID.randomUUID().toString() }
        val next = provider.copy(id = id, revision = provider.revision.coerceAtLeast(0) + 1)
        if (apiKey != null) replaceSecret(PROVIDER_ENTITY, id, "apiKey", apiKey.concatToString())
        save(current.copy(providers = current.providers.filterNot { it.id == id } + next))
    }

    suspend fun deleteProvider(id: String) {
        secrets.removeEntity(PROVIDER_ENTITY, id)
        val current = load()
        save(current.copy(
            providers = current.providers.filterNot { it.id == id },
            defaultProviderId = current.defaultProviderId.takeUnless { it == id }.orEmpty(),
        ))
    }

    fun providerApiKey(id: String): CharArray? = secret(PROVIDER_ENTITY, id, "apiKey")

    suspend fun upsertEnvironment(item: LocalAiEnvironment, value: CharArray?) {
        val current = load()
        val id = item.id.ifBlank { UUID.randomUUID().toString() }
        if (value != null) replaceSecret(ENV_ENTITY, id, "value", value.concatToString())
        save(current.copy(environment = current.environment.filterNot { it.id == id } + item.copy(id = id)))
    }

    suspend fun deleteEnvironment(id: String) {
        secrets.removeEntity(ENV_ENTITY, id)
        val current = load()
        save(current.copy(environment = current.environment.filterNot { it.id == id }))
    }

    fun environmentValue(id: String): CharArray? = secret(ENV_ENTITY, id, "value")

    suspend fun upsertMcp(server: LocalAiMcpServer, secretHeaders: CharArray?) {
        val current = load()
        val id = server.id.ifBlank { UUID.randomUUID().toString() }
        if (secretHeaders != null) replaceSecret(MCP_ENTITY, id, "headers", secretHeaders.concatToString())
        save(current.copy(mcpServers = current.mcpServers.filterNot { it.id == id } + server.copy(id = id)))
    }

    suspend fun deleteMcp(id: String) {
        secrets.removeEntity(MCP_ENTITY, id)
        val current = load()
        save(current.copy(mcpServers = current.mcpServers.filterNot { it.id == id }))
    }

    fun mcpHeaders(id: String): CharArray? = secret(MCP_ENTITY, id, "headers")

    suspend fun upsertMemory(item: LocalAiMemory) = updateList(item.id, { it.memories }, { c, list -> c.copy(memories = list) }, item)
    suspend fun upsertSkill(item: LocalAiSkill) = updateList(item.id, { it.skills }, { c, list -> c.copy(skills = list) }, item)
    suspend fun upsertPlan(item: LocalAiPlan) = updateList(item.id, { it.plans }, { c, list -> c.copy(plans = list) }, item)
    suspend fun deleteMemory(id: String) { val c = load(); save(c.copy(memories = c.memories.filterNot { it.id == id })) }
    suspend fun deleteSkill(id: String) { val c = load(); save(c.copy(skills = c.skills.filterNot { it.id == id })) }
    suspend fun deletePlan(id: String) { val c = load(); save(c.copy(plans = c.plans.filterNot { it.id == id })) }

    private suspend inline fun <reified T> updateList(
        id: String,
        crossinline get: (LocalAiCatalog) -> List<T>,
        crossinline copy: (LocalAiCatalog, List<T>) -> LocalAiCatalog,
        item: T,
    ) {
        val current = load()
        val resolved = id.ifBlank { UUID.randomUUID().toString() }
        val patched: T = when (item) {
            is LocalAiMemory -> item.copy(id = resolved) as T
            is LocalAiSkill -> item.copy(id = resolved) as T
            is LocalAiPlan -> item.copy(id = resolved) as T
            else -> item
        }
        val list = get(current).filterNot {
            when (it) {
                is LocalAiMemory -> it.id == resolved
                is LocalAiSkill -> it.id == resolved
                is LocalAiPlan -> it.id == resolved
                else -> false
            }
        } + patched
        save(copy(current, list))
    }

    private fun decode(raw: String): LocalAiCatalog = runCatching { json.decodeFromString<LocalAiCatalog>(raw) }.getOrDefault(LocalAiCatalog())

    private fun replaceSecret(type: String, id: String, field: String, value: String) {
        val bytes = value.toByteArray()
        try { secrets.put(SecretRef.of(type, id, field), bytes, Residency.OWNED) } finally { bytes.fill(0) }
    }

    private fun secret(type: String, id: String, field: String): CharArray? {
        val bytes = secrets.get(SecretRef.of(type, id, field)) ?: return null
        return try { bytes.toString(Charsets.UTF_8).toCharArray() } finally { bytes.fill(0) }
    }

    companion object {
        const val PREF_CATALOG = "one.ai.catalog.v2"
        const val PROVIDER_ENTITY = "oneAiProvider"
        const val ENV_ENTITY = "oneAiEnvironment"
        const val MCP_ENTITY = "oneAiMcp"
    }
}

@Serializable
data class LocalAiCatalog(
    val schemaVersion: Int = 2,
    val enabled: Boolean = true,
    val assistantName: String = "Zephyr AI",
    val defaultProviderId: String = "",
    val defaultModel: String = "",
    val systemPrompt: String = "",
    val codeCompletionEnabled: Boolean = true,
    val context: LocalAiContext = LocalAiContext(),
    val sensitive: LocalAiSensitive = LocalAiSensitive(),
    val permissions: LocalAiPermissions = LocalAiPermissions(),
    val permissionRules: LocalAiPermissionRules = LocalAiPermissionRules(),
    val planner: LocalAiPlanner = LocalAiPlanner(),
    val memoryEnabled: Boolean = true,
    val memoryMaxItems: Int = 500,
    val providers: List<LocalAiProvider> = emptyList(),
    val mcpServers: List<LocalAiMcpServer> = emptyList(),
    val environment: List<LocalAiEnvironment> = emptyList(),
    val memories: List<LocalAiMemory> = emptyList(),
    val skills: List<LocalAiSkill> = emptyList(),
    val plans: List<LocalAiPlan> = emptyList(),
    val sandbox: LocalAiSandbox = LocalAiSandbox(),
    val syncFromMainEnabled: Boolean = false,
) {
    fun normalized(): LocalAiCatalog = copy(
        assistantName = assistantName.trim().take(40).ifBlank { "Zephyr AI" },
        context = context.normalized(), memoryMaxItems = memoryMaxItems.coerceIn(1, 2000),
        providers = providers.distinctBy { it.id }, mcpServers = mcpServers.distinctBy { it.id },
        environment = environment.distinctBy { it.id }, memories = memories.distinctBy { it.id }.take(memoryMaxItems),
        skills = skills.distinctBy { it.id }, plans = plans.distinctBy { it.id }.take(200),
    )
}

@Serializable data class LocalAiContext(val windowTokens: Int = 64_000, val maxInputChars: Int = 90_000, val toolResultChars: Int = 30_000, val memoryItems: Int = 16, val maxToolRounds: Int = 0) {
    fun normalized() = copy(windowTokens = windowTokens.coerceAtLeast(1024), maxInputChars = maxInputChars.coerceAtLeast(8000), toolResultChars = toolResultChars.coerceAtLeast(1000), memoryItems = memoryItems.coerceIn(0, 2000), maxToolRounds = maxToolRounds.coerceAtLeast(0))
}
@Serializable data class LocalAiSensitive(val requireConfirmation: Boolean = true, val autoConfirm: Boolean = false, val autoConfirmDelayMs: Int = 2500)
@Serializable data class LocalAiPermissions(val webSearch: Boolean = true, val webFetch: Boolean = true, val browser: Boolean = true, val remoteExecute: Boolean = true, val fileRead: Boolean = true, val fileWrite: Boolean = true, val codeEdit: Boolean = true, val memory: Boolean = true, val notesRead: Boolean = true, val notesWrite: Boolean = true, val env: Boolean = true, val sandbox: Boolean = true)
@Serializable data class LocalAiPermissionRules(val mode: String = "ask", val deny: List<String> = emptyList(), val ask: List<String> = emptyList(), val allow: List<String> = emptyList())
@Serializable data class LocalAiPlanner(val enabled: Boolean = true, val requirePlanBeforeTools: Boolean = false)
@Serializable data class LocalAiModel(val id: String, val label: String = id, val hidden: Boolean = false, val contextWindowTokens: Int? = null, val maxOutputTokens: Int? = null, val temperature: Double? = null, val topP: Double? = null, val reasoning: Boolean = false, val reasoningEffort: String? = null, val inputImage: Boolean = true, val inputPdf: Boolean = false, val inputAudio: Boolean = false, val inputVideo: Boolean = false, val outputImage: Boolean = false, val outputAudio: Boolean = false, val tools: Boolean = true, val parallelToolCalls: Boolean = true, val promptCache: String = "auto", val maxImagesPerRequest: Int? = null, val maxImageBytes: Long? = null, val apiMode: String? = null, val userAgent: String? = null, val extraJson: String = "{}")
@Serializable data class LocalAiProvider(val id: String = "", val name: String = "", val type: String = "openai-compatible", val baseUrl: String = "", val apiMode: String = "auto", val defaultModel: String = "", val models: List<LocalAiModel> = emptyList(), val organization: String = "", val extraHeadersJson: String = "{}", val modelUserAgents: String = "", val temperature: Double? = null, val topP: Double? = null, val maxTokens: Int = 4096, val contextWindowTokens: Int? = null, val reasoningEffort: String? = null, val visionDefault: Boolean = true, val usePreviousResponse: Boolean = false, val presencePenalty: Double = 0.0, val frequencyPenalty: Double = 0.0, val extraJson: String = "{}", val enabled: Boolean = true, val source: String = "local", val revision: Long = 0)
@Serializable data class LocalAiMcpServer(val id: String = "", val name: String = "", val type: String = "http", val command: String = "", val args: List<String> = emptyList(), val env: Map<String, String> = emptyMap(), val url: String = "", val trustedReadOnly: List<String> = emptyList(), val timeoutSeconds: Int = 300, val enabled: Boolean = true)
@Serializable data class LocalAiEnvironment(val id: String = "", val name: String = "", val description: String = "", val enabled: Boolean = true, val visibleToAi: Boolean = false, val valueVisibleToAi: Boolean = false)
@Serializable data class LocalAiMemory(val id: String = "", val title: String = "", val scope: String = "global", val project: String = "", val connectionIds: List<String> = emptyList(), val tags: List<String> = emptyList(), val content: String = "", val enabled: Boolean = true, val updatedAt: Long = System.currentTimeMillis())
@Serializable data class LocalAiSkill(val id: String = "", val name: String = "", val description: String = "", val prompt: String = "", val enabled: Boolean = true, val updatedAt: Long = System.currentTimeMillis())
@Serializable data class LocalAiPlanStep(val id: String = "", val title: String = "", val status: String = "pending", val note: String = "", val error: String = "")
@Serializable data class LocalAiPlan(
    val id: String = "",
    val title: String = "",
    val status: String = "planned",
    val risk: String = "",
    val steps: List<LocalAiPlanStep> = emptyList(),
    val note: String = "",
    val updatedAt: Long = System.currentTimeMillis(),
)
@Serializable data class LocalAiSandbox(val enabled: Boolean = true, val workspaceQuotaMb: Int = 256, val timeoutSeconds: Int = 60, val networkDefault: Boolean = false, val allowedCommands: List<String> = listOf("cat", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "sha256sum"))
