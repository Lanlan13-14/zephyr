package one.zephyr.mobile.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class AiRuntimeStatusDto(
    val enabled: Boolean = false,
    val legacyChat: Boolean = false,
)

@Serializable
data class AiModelInputDto(
    val image: Boolean = true,
    val pdf: Boolean = false,
    val audio: Boolean = false,
    val video: Boolean = false,
)

@Serializable
data class AiModelDto(
    val id: String,
    val label: String = id,
    val hidden: Boolean = false,
    val reasoning: Boolean = false,
    val input: AiModelInputDto = AiModelInputDto(),
)

@Serializable
data class AiProviderDto(
    val id: String,
    val name: String,
    val type: String = "",
    val defaultModel: String = "",
    val models: List<AiModelDto> = emptyList(),
    val owner: String = "own",
    val owned: Boolean = true,
    val enabled: Boolean = true,
)

@Serializable
data class AiProvidersResponseDto(val providers: List<AiProviderDto> = emptyList())

@Serializable
data class AiSessionDto(
    val id: String,
    val title: String = "新对话",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AiRuntimeSessionResponseDto(
    val ok: Boolean = true,
    val session: AiSessionDto? = null,
    val sessionId: String? = null,
)

@Serializable
data class AiRuntimeSessionsResponseDto(
    val ok: Boolean = true,
    val sessions: List<AiSessionDto> = emptyList(),
    val enabled: Boolean = true,
)

@Serializable
data class AiHistoryAttachmentDto(
    val id: String,
    val sessionId: String = "",
    val name: String = "file",
    val mime: String = "application/octet-stream",
    val size: Long = 0,
)

@Serializable
data class AiHistoryMessageDto(
    val id: String,
    val role: String,
    val content: String = "",
    val attachments: List<AiHistoryAttachmentDto> = emptyList(),
    val revision: Long = 1,
    val createdAt: Long = 0,
)

@Serializable
data class AiHistoryConversationDto(
    val id: String,
    val title: String = "新对话",
    val providerId: String? = null,
    val model: String? = null,
    val revision: Long = 1,
    val updatedAt: Long = 0,
    val messages: List<AiHistoryMessageDto> = emptyList(),
)

@Serializable
data class AiHistoryResponseDto(
    val ok: Boolean = true,
    val conversations: List<AiHistoryConversationDto> = emptyList(),
)

@Serializable
data class AiAttachmentDto(
    val id: String,
    val name: String,
    val mime: String = "application/octet-stream",
    val size: Long = 0,
    val kind: String = "document",
    val createdAt: Long = 0,
)

@Serializable
data class AiAttachmentResponseDto(
    val ok: Boolean = true,
    val attachment: AiAttachmentDto,
)

@Serializable
data class AiAttachmentsResponseDto(
    val ok: Boolean = true,
    val attachments: List<AiAttachmentDto> = emptyList(),
)

@Serializable
data class AiRunPermissionDto(
    val mode: String = "ask",
    val deny: List<String> = emptyList(),
    val allow: List<String> = emptyList(),
    val ask: List<String> = emptyList(),
)

@Serializable
data class AiRunRequestDto(
    val sessionId: String? = null,
    val conversationId: String,
    val title: String,
    val userMessageId: String,
    val assistantMessageId: String,
    val historyUserContent: String,
    val message: String,
    val attachments: List<String> = emptyList(),
    val providerId: String? = null,
    val model: String? = null,
    val options: JsonObject = JsonObject(emptyMap()),
    val context: JsonObject = JsonObject(emptyMap()),
    val mode: String = "balanced",
    val permissionMode: String = "ask",
    val permission: AiRunPermissionDto = AiRunPermissionDto(),
)

@Serializable
data class AiRunStartDto(
    val ok: Boolean = true,
    val runId: String,
    val sessionId: String,
    val conversationId: String,
    val ticket: String = "",
    val ssePath: String = "",
    val sseProxyPath: String = "",
)

@Serializable
data class AiRunDecisionRequestDto(
    val sessionId: String,
    val callId: String,
    val tool: String,
    val approve: Boolean,
    val scope: String = "once",
    val providerId: String? = null,
    val model: String? = null,
)

@Serializable
data class AiRunDecisionResponseDto(
    val ok: Boolean = true,
    val approved: Boolean = false,
    val resumed: Boolean = false,
    val runId: String = "",
    val callId: String = "",
    val sessionId: String = "",
    val ticket: String = "",
)

@Serializable
data class AiAbortResponseDto(
    val ok: Boolean = true,
    val aborted: Boolean = true,
)

@Serializable
data class AiOkResponseDto(val ok: Boolean = true)

data class AiRuntimeEvent(
    val type: String,
    val runId: String,
    val seq: Long,
    val timestamp: Long,
    val data: JsonObject,
)

@Serializable
data class AiRuntimeEventEnvelope(
    val type: String = "message",
    val runId: String = "",
    val seq: Long = 0,
    @SerialName("ts") val timestamp: Long = 0,
    val data: JsonElement? = null,
)
