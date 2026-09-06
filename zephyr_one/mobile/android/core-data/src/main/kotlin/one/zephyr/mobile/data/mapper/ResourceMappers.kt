package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.model.AiConversationRecord
import one.zephyr.mobile.model.AiEnv
import one.zephyr.mobile.model.AiMemory
import one.zephyr.mobile.model.AiMessageRecord
import one.zephyr.mobile.model.AiModel
import one.zephyr.mobile.model.AiProvider
import one.zephyr.mobile.model.AiProviderConfig
import one.zephyr.mobile.model.AiSkill
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.ClientToken
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.ProxyType
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.model.SshKey
import one.zephyr.mobile.model.SyncState

/** Projections for the remaining mirrored entities. Same opaque-preserving rules as connections. */
object ResourceMappers {

    private fun syncStateOf(row: MirrorEntityRow, conflicted: Boolean): SyncState = when {
        conflicted -> SyncState.CONFLICTED
        row.hasPendingWrite -> SyncState.PENDING_LOCAL
        else -> SyncState.SYNCED
    }

    fun proxy(row: MirrorEntityRow, conflicted: Boolean = false): Proxy {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        val type = ProxyType.fromWire(EntityCodec.string(payload, "type"))
        return Proxy(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            type = type,
            host = EntityCodec.text(payload, "host"),
            port = EntityCodec.int(payload, "port", type.defaultPort),
            username = EntityCodec.text(payload, "username"),
            password = SecretPresence(EntityCodec.bool(presence, "hasPassword", false)),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            residency = Residency.OWNED,
            capabilities = CapabilitySet.owner,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun sshKey(row: MirrorEntityRow, conflicted: Boolean = false): SshKey {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return SshKey(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            remark = EntityCodec.text(payload, "remark"),
            privateKey = SecretPresence(EntityCodec.bool(presence, "hasPrivateKey", false)),
            passphrase = SecretPresence(EntityCodec.bool(presence, "hasPassphrase", false)),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun jumpHost(row: MirrorEntityRow, conflicted: Boolean = false): JumpHost {
        val payload = EntityCodec.parse(row.payloadJson)
        return JumpHost(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            connectionId = EntityCodec.text(payload, "connectionId"),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun note(row: MirrorEntityRow, conflicted: Boolean = false): Note {
        val payload = EntityCodec.parse(row.payloadJson)
        return Note(
            noteId = row.entityId,
            ownerUserId = row.ownerUserId,
            title = EntityCodec.text(payload, "title"),
            content = EntityCodec.text(payload, "content"),
            groupPath = EntityCodec.text(payload, "groupPath"),
            tags = EntityCodec.stringList(payload, "tags"),
            linkedConnectionIds = EntityCodec.stringList(payload, "linkedConnectionIds"),
            aiReadEnabled = EntityCodec.bool(payload, "allowAiRead", false),
            aiWriteEnabled = EntityCodec.bool(payload, "allowAiWrite", false),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun snippet(row: MirrorEntityRow, conflicted: Boolean = false): Snippet {
        val payload = EntityCodec.parse(row.payloadJson)
        return Snippet(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            command = EntityCodec.text(payload, "command"),
            group = EntityCodec.text(payload, "group"),
            autoRun = EntityCodec.bool(payload, "autoRun", false),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    /**
     * Client Token is a full entity, not metadata: the secret rides the device envelope into the
     * SecretStore, and only its presence appears here. PRODUCT_REQUIREMENTS.md 12 lists
     * "token metadata only" as a release blocker, so [ClientToken.token] must reflect a real value.
     */
    fun clientToken(row: MirrorEntityRow, conflicted: Boolean = false): ClientToken {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return ClientToken(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            token = SecretPresence(EntityCodec.bool(presence, "hasToken", false)),
            createdAt = EntityCodec.long(payload, "createdAt", 0L),
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            lastUsedAt = EntityCodec.longOrNull(payload, "lastUsedAt"),
            linkedOneDeviceCount = EntityCodec.int(payload, "linkedOneDeviceCount", 0),
            linkedLegacyAgentCount = EntityCodec.int(payload, "linkedLegacyAgentCount", 0),
            revision = row.revision,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun activityEvent(row: MirrorEntityRow): ActivityEvent {
        val payload = EntityCodec.parse(row.payloadJson)
        return ActivityEvent(
            id = row.entityId,
            userId = row.ownerUserId,
            message = EntityCodec.text(payload, "message"),
            type = EntityCodec.text(payload, "type"),
            category = EntityCodec.text(payload, "category"),
            outcome = EntityCodec.text(payload, "outcome"),
            protocol = EntityCodec.string(payload, "protocol"),
            target = EntityCodec.string(payload, "target"),
            connectionId = EntityCodec.string(payload, "connectionId"),
            durationMs = EntityCodec.longOrNull(payload, "durationMs"),
            occurredAt = EntityCodec.long(payload, "time", 0L),
        )
    }

    fun proxyValues(proxy: Proxy): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(proxy.name),
            "host" to JsonPrimitive(proxy.host),
            "port" to JsonPrimitive(proxy.port),
            "type" to JsonPrimitive(proxy.type.wireName),
            "username" to JsonPrimitive(proxy.username),
            "visibility" to JsonPrimitive(proxy.visibility),
        ),
    )

    fun sshKeyValues(key: SshKey): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(key.name),
            "remark" to JsonPrimitive(key.remark),
            "visibility" to JsonPrimitive(key.visibility),
        ),
    )

    fun jumpHostValues(host: JumpHost): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(host.name),
            "connectionId" to JsonPrimitive(host.connectionId),
            "visibility" to JsonPrimitive(host.visibility),
        ),
    )

    fun noteValues(note: Note): JsonObject = JsonObject(
        mapOf(
            "title" to JsonPrimitive(note.title),
            "content" to JsonPrimitive(note.content),
            "groupPath" to JsonPrimitive(note.groupPath),
            "tags" to JsonArrays.of(note.tags),
            "linkedConnectionIds" to JsonArrays.of(note.linkedConnectionIds),
            "allowAiRead" to JsonPrimitive(note.aiReadEnabled),
            "allowAiWrite" to JsonPrimitive(note.aiWriteEnabled),
        ),
    )

    fun snippetValues(snippet: Snippet): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(snippet.name),
            "command" to JsonPrimitive(snippet.command),
            "group" to JsonPrimitive(snippet.group),
            "autoRun" to JsonPrimitive(snippet.autoRun),
        ),
    )

    fun aiProvider(row: MirrorEntityRow, conflicted: Boolean = false): AiProvider {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        val config = EntityCodec.obj(payload, "config") ?: JsonObject(emptyMap())
        val options = EntityCodec.obj(config, "options") ?: JsonObject(emptyMap())
        return AiProvider(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            type = EntityCodec.text(payload, "type", "openai-compatible"),
            baseUrl = EntityCodec.text(payload, "baseUrl"),
            defaultModel = EntityCodec.text(payload, "defaultModel"),
            models = EntityCodec.objectList(payload, "models").map(::aiModel),
            config = AiProviderConfig(
                apiMode = EntityCodec.text(config, "apiMode", "auto"),
                temperature = EntityCodec.doubleOrNull(options, "temperature"),
                topP = EntityCodec.doubleOrNull(options, "top_p") ?: EntityCodec.doubleOrNull(options, "topP"),
                maxTokens = EntityCodec.intOrNull(options, "max_tokens") ?: EntityCodec.intOrNull(options, "maxTokens"),
                maxOutputTokens = EntityCodec.intOrNull(options, "max_output_tokens")
                    ?: EntityCodec.intOrNull(options, "maxOutputTokens"),
                presencePenalty = EntityCodec.doubleOrNull(options, "presence_penalty")
                    ?: EntityCodec.doubleOrNull(options, "presencePenalty"),
                frequencyPenalty = EntityCodec.doubleOrNull(options, "frequency_penalty")
                    ?: EntityCodec.doubleOrNull(options, "frequencyPenalty"),
                vision = EntityCodec.bool(options, "vision", true),
                usePreviousResponseId = EntityCodec.bool(options, "use_previous_response_id", false),
                reasoningEffort = EntityCodec.string(options, "reasoning_effort")
                    ?: EntityCodec.string(options, "reasoningEffort"),
                windowTokens = EntityCodec.intOrNull(options, "context")
                    ?: EntityCodec.intOrNull(options, "windowTokens"),
            ),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            shareWithUsers = EntityCodec.bool(payload, "shareWithUsers", false),
            shareWithAdmins = EntityCodec.bool(payload, "shareWithAdmins", false),
            sharedUserIds = EntityCodec.stringList(payload, "sharedUserIds"),
            enabled = EntityCodec.bool(payload, "enabled", true),
            apiKey = SecretPresence(EntityCodec.bool(presence, "hasApiKey", EntityCodec.bool(payload, "hasApiKey", false))),
            revision = row.revision,
            createdAt = EntityCodec.long(payload, "createdAt", 0L),
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            residency = Residency.OWNED,
            capabilities = CapabilitySet.owner,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiProviderValues(provider: AiProvider): JsonObject {
        val options = buildMap<String, kotlinx.serialization.json.JsonElement> {
            provider.config.temperature?.let { put("temperature", JsonPrimitive(it)) }
            provider.config.topP?.let { put("top_p", JsonPrimitive(it)) }
            provider.config.maxTokens?.let { put("max_tokens", JsonPrimitive(it)) }
            provider.config.maxOutputTokens?.let { put("max_output_tokens", JsonPrimitive(it)) }
            provider.config.presencePenalty?.let { put("presence_penalty", JsonPrimitive(it)) }
            provider.config.frequencyPenalty?.let { put("frequency_penalty", JsonPrimitive(it)) }
            put("vision", JsonPrimitive(provider.config.vision))
            put("use_previous_response_id", JsonPrimitive(provider.config.usePreviousResponseId))
            provider.config.reasoningEffort?.let { put("reasoning_effort", JsonPrimitive(it)) }
            provider.config.windowTokens?.let { put("context", JsonPrimitive(it)) }
        }
        return JsonObject(
            mapOf(
                "name" to JsonPrimitive(provider.name),
                "type" to JsonPrimitive(provider.type),
                "baseUrl" to JsonPrimitive(provider.baseUrl),
                "defaultModel" to JsonPrimitive(provider.defaultModel),
                "models" to JsonArray(provider.models.map(::aiModelValues)),
                "config" to JsonObject(
                    mapOf(
                        "apiMode" to JsonPrimitive(provider.config.apiMode),
                        "options" to JsonObject(options),
                    ),
                ),
                "visibility" to JsonPrimitive(provider.visibility),
                "shareWithUsers" to JsonPrimitive(provider.shareWithUsers),
                "shareWithAdmins" to JsonPrimitive(provider.shareWithAdmins),
                "sharedUserIds" to JsonArrays.of(provider.sharedUserIds),
                "enabled" to JsonPrimitive(provider.enabled),
            ),
        )
    }

    fun aiMemory(row: MirrorEntityRow, conflicted: Boolean = false): AiMemory {
        val payload = EntityCodec.parse(row.payloadJson)
        return AiMemory(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            title = EntityCodec.text(payload, "title"),
            content = EntityCodec.text(payload, "content"),
            scope = EntityCodec.text(payload, "scope", "global"),
            project = EntityCodec.text(payload, "project"),
            projects = EntityCodec.stringList(payload, "projects"),
            tags = EntityCodec.stringList(payload, "tags"),
            connectionIds = EntityCodec.stringList(payload, "connectionIds"),
            enabled = EntityCodec.bool(payload, "enabled", true),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiMemoryValues(memory: AiMemory): JsonObject = JsonObject(
        mapOf(
            "title" to JsonPrimitive(memory.title),
            "content" to JsonPrimitive(memory.content),
            "scope" to JsonPrimitive(memory.scope),
            "project" to JsonPrimitive(memory.project),
            "projects" to JsonArrays.of(memory.projects),
            "tags" to JsonArrays.of(memory.tags),
            "connectionIds" to JsonArrays.of(memory.connectionIds),
        ),
    )

    fun aiSkill(row: MirrorEntityRow, conflicted: Boolean = false): AiSkill {
        val payload = EntityCodec.parse(row.payloadJson)
        return AiSkill(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            description = EntityCodec.text(payload, "description"),
            prompt = EntityCodec.text(payload, "prompt"),
            enabled = EntityCodec.bool(payload, "enabled", true),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiSkillValues(skill: AiSkill): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(skill.name),
            "description" to JsonPrimitive(skill.description),
            "prompt" to JsonPrimitive(skill.prompt),
            "enabled" to JsonPrimitive(skill.enabled),
        ),
    )

    fun aiEnv(row: MirrorEntityRow, conflicted: Boolean = false): AiEnv {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return AiEnv(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            enabled = EntityCodec.bool(payload, "enabled", true),
            visibleToAi = EntityCodec.bool(payload, "visibleToAi", false),
            value = SecretPresence(EntityCodec.bool(presence, "hasValue", EntityCodec.bool(payload, "hasValue", false))),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiEnvValues(env: AiEnv): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(env.name),
            "enabled" to JsonPrimitive(env.enabled),
            "visibleToAi" to JsonPrimitive(env.visibleToAi),
        ),
    )

    fun aiConversation(row: MirrorEntityRow, conflicted: Boolean = false): AiConversationRecord {
        val payload = EntityCodec.parse(row.payloadJson)
        return AiConversationRecord(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            title = EntityCodec.text(payload, "title"),
            providerId = EntityCodec.text(payload, "providerId"),
            model = EntityCodec.text(payload, "model"),
            archived = EntityCodec.bool(payload, "archived", false),
            revision = row.revision,
            createdAt = EntityCodec.long(payload, "createdAt", 0L),
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiConversationValues(conversation: AiConversationRecord): JsonObject = JsonObject(
        mapOf(
            "title" to JsonPrimitive(conversation.title),
            "providerId" to JsonPrimitive(conversation.providerId),
            "model" to JsonPrimitive(conversation.model),
            "archived" to JsonPrimitive(conversation.archived),
        ),
    )

    fun aiMessage(row: MirrorEntityRow, conflicted: Boolean = false): AiMessageRecord {
        val payload = EntityCodec.parse(row.payloadJson)
        return AiMessageRecord(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            conversationId = EntityCodec.text(payload, "conversationId"),
            role = EntityCodec.text(payload, "role"),
            content = EntityCodec.text(payload, "content"),
            attachments = EntityCodec.stringList(payload, "attachments"),
            revision = row.revision,
            createdAt = EntityCodec.long(payload, "createdAt", 0L),
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun aiMessageValues(message: AiMessageRecord): JsonObject = JsonObject(
        mapOf(
            "conversationId" to JsonPrimitive(message.conversationId),
            "role" to JsonPrimitive(message.role),
            "content" to JsonPrimitive(message.content),
            "attachments" to JsonArrays.of(message.attachments),
        ),
    )

    private fun aiModel(payload: JsonObject): AiModel {
        val input = EntityCodec.obj(payload, "input") ?: JsonObject(emptyMap())
        val output = EntityCodec.obj(payload, "output") ?: JsonObject(emptyMap())
        return AiModel(
            id = EntityCodec.text(payload, "id"),
            label = EntityCodec.text(payload, "label", EntityCodec.text(payload, "id")),
            hidden = EntityCodec.bool(payload, "hidden", false),
            reasoning = EntityCodec.bool(payload, "reasoning", false),
            reasoningConfigured = EntityCodec.bool(payload, "reasoningConfigured", false),
            tools = EntityCodec.bool(payload, "tools", true),
            parallelToolCalls = EntityCodec.bool(payload, "parallelToolCalls", true),
            contextWindowTokens = EntityCodec.intOrNull(payload, "contextWindowTokens"),
            maxOutputTokens = EntityCodec.intOrNull(payload, "maxOutputTokens"),
            temperature = EntityCodec.doubleOrNull(payload, "temperature"),
            topP = EntityCodec.doubleOrNull(payload, "topP"),
            maxImagesPerRequest = EntityCodec.intOrNull(payload, "maxImagesPerRequest"),
            maxImageBytes = EntityCodec.longOrNull(payload, "maxImageBytes"),
            reasoningEffort = EntityCodec.string(payload, "reasoningEffort"),
            promptCache = EntityCodec.text(payload, "promptCache", "auto"),
            apiMode = EntityCodec.string(payload, "apiMode"),
            inputImage = EntityCodec.bool(input, "image", EntityCodec.bool(payload, "inputImage", true)),
            inputPdf = EntityCodec.bool(input, "pdf", EntityCodec.bool(payload, "inputPdf", false)),
            inputAudio = EntityCodec.bool(input, "audio", EntityCodec.bool(payload, "inputAudio", false)),
            inputVideo = EntityCodec.bool(input, "video", EntityCodec.bool(payload, "inputVideo", false)),
            outputImage = EntityCodec.bool(output, "image", EntityCodec.bool(payload, "outputImage", false)),
            outputAudio = EntityCodec.bool(output, "audio", EntityCodec.bool(payload, "outputAudio", false)),
        )
    }

    private fun aiModelValues(model: AiModel): JsonObject = JsonObject(
        buildMap {
            put("id", JsonPrimitive(model.id))
            put("label", JsonPrimitive(model.label))
            put("hidden", JsonPrimitive(model.hidden))
            put("reasoning", JsonPrimitive(model.reasoning))
            put("reasoningConfigured", JsonPrimitive(model.reasoningConfigured))
            put("tools", JsonPrimitive(model.tools))
            put("parallelToolCalls", JsonPrimitive(model.parallelToolCalls))
            put("promptCache", JsonPrimitive(model.promptCache))
            put(
                "input",
                JsonObject(
                    mapOf(
                        "image" to JsonPrimitive(model.inputImage),
                        "pdf" to JsonPrimitive(model.inputPdf),
                        "audio" to JsonPrimitive(model.inputAudio),
                        "video" to JsonPrimitive(model.inputVideo),
                    ),
                ),
            )
            put(
                "output",
                JsonObject(
                    mapOf(
                        "image" to JsonPrimitive(model.outputImage),
                        "audio" to JsonPrimitive(model.outputAudio),
                    ),
                ),
            )
            model.contextWindowTokens?.let { put("contextWindowTokens", JsonPrimitive(it)) }
            model.maxOutputTokens?.let { put("maxOutputTokens", JsonPrimitive(it)) }
            model.temperature?.let { put("temperature", JsonPrimitive(it)) }
            model.topP?.let { put("topP", JsonPrimitive(it)) }
            model.maxImagesPerRequest?.let { put("maxImagesPerRequest", JsonPrimitive(it)) }
            model.maxImageBytes?.let { put("maxImageBytes", JsonPrimitive(it)) }
            model.reasoningEffort?.let { put("reasoningEffort", JsonPrimitive(it)) }
            model.apiMode?.let { put("apiMode", JsonPrimitive(it)) }
        },
    )
}
