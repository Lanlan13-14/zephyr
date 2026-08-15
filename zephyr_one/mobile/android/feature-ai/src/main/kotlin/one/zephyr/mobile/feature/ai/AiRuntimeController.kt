package one.zephyr.mobile.feature.ai

import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject

data class AiAttachment(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val kind: String,
    val uploaded: Boolean = true,
)

data class AiProviderOption(
    val id: String,
    val name: String,
    val models: List<AiModelOption>,
    val owned: Boolean,
)

data class AiModelOption(
    val id: String,
    val label: String,
    val reasoning: Boolean,
    val acceptsImage: Boolean,
    val acceptsPdf: Boolean,
    val acceptsAudio: Boolean,
    val acceptsVideo: Boolean,
)

data class AiPendingPermission(
    val askId: String,
    val callId: String,
    val tool: String,
    val summary: String,
    val risk: String,
    val args: JsonObject,
)

data class AiRuntimeState(
    val runtimeEnabled: Boolean = false,
    val loading: Boolean = false,
    val providers: List<AiProviderOption> = emptyList(),
    val conversationId: String? = null,
    val runtimeSessionId: String? = null,
    val runId: String? = null,
    val running: Boolean = false,
    val waitingPermission: AiPendingPermission? = null,
    val conversation: AiConversation = AiConversation(),
    val attachments: List<AiAttachment> = emptyList(),
    val error: String? = null,
) {
    val selectedProvider: AiProviderOption?
        get() = providers.firstOrNull()
}

data class AiUpload(
    val name: String,
    val mime: String,
    val bytes: ByteArray,
) : AutoCloseable {
    override fun close() = bytes.fill(0)
}

interface AiRuntimeController {
    val state: StateFlow<AiRuntimeState>

    suspend fun refresh()
    fun selectProvider(providerId: String)
    fun selectModel(modelId: String)
    fun selectMode(mode: String)
    fun selectRunProfile(profile: String)
    fun selectPermission(mode: String)
    fun selectThinking(value: String)
    fun setPlanEnabled(enabled: Boolean)
    suspend fun send(text: String)
    suspend fun stop()
    suspend fun decide(approve: Boolean)
    suspend fun upload(file: AiUpload)
    suspend fun removeAttachment(id: String)
    fun clearError()
}
