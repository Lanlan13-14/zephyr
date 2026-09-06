package one.zephyr.mobile.app

import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.feature.ai.AiAttachment
import one.zephyr.mobile.feature.ai.AiConversation
import one.zephyr.mobile.feature.ai.AiModelOption
import one.zephyr.mobile.feature.ai.AiPendingPermission
import one.zephyr.mobile.feature.ai.AiProviderOption
import one.zephyr.mobile.feature.ai.AiRuntimeController
import one.zephyr.mobile.feature.ai.AiRuntimeState
import one.zephyr.mobile.feature.ai.AiTranscriptItem
import one.zephyr.mobile.feature.ai.AiUpload
import one.zephyr.mobile.feature.ai.AiWorkspaceChrome
import one.zephyr.mobile.network.AiHistoryConversationDto
import one.zephyr.mobile.network.AiProviderDto
import one.zephyr.mobile.network.AiRunDecisionRequestDto
import one.zephyr.mobile.network.AiRunPermissionDto
import one.zephyr.mobile.network.AiRunRequestDto
import one.zephyr.mobile.network.AiRunStartDto
import one.zephyr.mobile.network.AiRuntimeEvent
import one.zephyr.mobile.network.ApiResult

/** One account-scoped, process-local controller over the server-owned AI runtime. */
internal class AndroidAiRuntimeController(
    private val account: AccountContainer,
    private val scope: CoroutineScope,
    private val chrome: () -> AiWorkspaceChrome,
    private val context: () -> JsonObject,
    private val persistChrome: suspend (AiWorkspaceChrome) -> Unit,
) : AiRuntimeController {
    private val mutable = MutableStateFlow(AiRuntimeState())
    override val state: StateFlow<AiRuntimeState> = mutable.asStateFlow()

    private var selectedProviderId = ""
    private var selectedModelId = ""
    private var selectedMode = "standard"
    private var selectedRunProfile = "balanced"
    private var selectedPermission = "ask"
    private var selectedThinking = "medium"
    private var planEnabled = false
    private var streamJob: Job? = null
    private var lastEventId = 0L
    private val traceIndex = linkedMapOf<String, Int>()

    override suspend fun refresh() {
        mutable.update { it.copy(loading = true, error = null) }
        val status = account.aiRuntime.status()
        val providers = account.aiRuntime.providers()
        val history = account.aiRuntime.history()
        val runtimeEnabled = (status as? ApiResult.Success)?.value?.enabled == true
        if (status is ApiResult.Failure) return fail(status)
        if (providers is ApiResult.Failure) return fail(providers)
        if (history is ApiResult.Failure) return fail(history)
        val providerOptions = (providers as ApiResult.Success).value.map { it.toOption() }
        val currentChrome = chrome()
        selectedProviderId = currentChrome.providerId.takeIf { id -> providerOptions.any { it.id == id } }
            ?: selectedProviderId.takeIf { id -> providerOptions.any { it.id == id } }
            ?: providerOptions.firstOrNull()?.id.orEmpty()
        val selectedProvider = providerOptions.firstOrNull { it.id == selectedProviderId }
        selectedModelId = currentChrome.model.takeIf { model -> selectedProvider?.models?.any { it.id == model } == true }
            ?: selectedModelId.takeIf { model -> selectedProvider?.models?.any { it.id == model } == true }
            ?: selectedProvider?.models?.firstOrNull()?.id.orEmpty()
        selectedMode = normalize(currentChrome.collaboration, MODES, "standard")
        selectedRunProfile = normalize(currentChrome.runProfile, RUN_PROFILES, "balanced")
        selectedPermission = normalize(currentChrome.permission, PERMISSIONS, "ask")
        selectedThinking = currentChrome.thinking.ifBlank { "medium" }
        planEnabled = currentChrome.planEnabled
        val conversations = (history as ApiResult.Success).value
        val selectedConversation = selectConversation(conversations)
        val briefList = conversations.map {
            one.zephyr.mobile.feature.ai.AiConversationBrief(it.id, it.title.ifBlank { "新对话" }, it.updatedAt)
        }
        mutable.value = AiRuntimeState(
            runtimeEnabled = runtimeEnabled,
            loading = false,
            providers = providerOptions,
            conversationId = selectedConversation?.id,
            conversationTitle = selectedConversation?.title?.ifBlank { "新对话" } ?: "新对话",
            conversations = briefList,
            runtimeSessionId = mutable.value.runtimeSessionId,
            runId = mutable.value.runId,
            running = mutable.value.running,
            waitingPermission = mutable.value.waitingPermission,
            conversation = selectedConversation?.toConversation() ?: mutable.value.conversation,
            attachments = mutable.value.attachments,
        )
        persistSelection()
    }

    override fun selectConversation(id: String) {
        scope.launch {
            val history = (account.aiRuntime.history() as? ApiResult.Success)?.value.orEmpty()
            val target = history.firstOrNull { it.id == id }
            if (target != null) {
                mutable.update {
                    it.copy(
                        conversationId = target.id,
                        conversationTitle = target.title.ifBlank { "新对话" },
                        conversation = target.toConversation(),
                        error = null,
                    )
                }
            }
        }
    }

    override fun newConversation() {
        val newId = "conversation-${UUID.randomUUID()}"
        mutable.update {
            it.copy(
                conversationId = newId,
                conversationTitle = "新对话",
                conversation = AiConversation(),
                error = null,
            )
        }
    }

    override suspend fun deleteConversation(id: String) {
        val targetId = id.ifBlank { mutable.value.conversationId } ?: return
        mutable.update { it.copy(loading = true, error = null) }
        val ownerUserId = account.binding.userId
        runCatching {
            val history = (account.aiRuntime.history() as? ApiResult.Success)?.value.orEmpty()
            val target = history.firstOrNull { it.id == targetId }
            account.aiRuntime.deleteConversation(targetId, target?.revision)
        }

        account.ownedAi.delete(one.zephyr.mobile.model.AiConversationRecord.ENTITY_TYPE, targetId, ownerUserId)
        val messages = account.ownedAi.listMessages(ownerUserId, targetId)
        for (m in messages) {
            account.ownedAi.delete(one.zephyr.mobile.model.AiMessageRecord.ENTITY_TYPE, m.id, ownerUserId)
        }
        if (!account.isLocalMode) {
            runCatching { account.syncEngine.syncNow() }
        }

        val history = (account.aiRuntime.history() as? ApiResult.Success)?.value.orEmpty()
        val briefList = history.map {
            one.zephyr.mobile.feature.ai.AiConversationBrief(it.id, it.title.ifBlank { "新对话" }, it.updatedAt)
        }
        val next = history.firstOrNull { it.id != targetId } ?: history.maxByOrNull { it.updatedAt }
        mutable.update {
            it.copy(
                loading = false,
                conversations = briefList,
                conversationId = next?.id,
                conversationTitle = next?.title?.ifBlank { "新对话" } ?: "新对话",
                conversation = next?.toConversation() ?: AiConversation(),
            )
        }
    }

    override fun selectProvider(providerId: String) {
        val provider = mutable.value.providers.firstOrNull { it.id == providerId } ?: return
        selectedProviderId = provider.id
        selectedModelId = provider.models.firstOrNull()?.id.orEmpty()
        persistSelectionAsync()
    }

    override fun selectModel(modelId: String) {
        val provider = mutable.value.providers.firstOrNull { it.id == selectedProviderId } ?: return
        if (provider.models.none { it.id == modelId }) return
        selectedModelId = modelId
        persistSelectionAsync()
    }

    override fun selectMode(mode: String) {
        selectedMode = normalize(mode, MODES, "standard")
        persistSelectionAsync()
    }

    override fun selectRunProfile(profile: String) {
        selectedRunProfile = normalize(profile, RUN_PROFILES, "balanced")
        persistSelectionAsync()
    }

    override fun selectPermission(mode: String) {
        selectedPermission = normalize(mode, PERMISSIONS, "ask")
        persistSelectionAsync()
    }

    override fun selectThinking(value: String) {
        selectedThinking = value.ifBlank { "medium" }
        persistSelectionAsync()
    }

    override fun setPlanEnabled(enabled: Boolean) {
        planEnabled = enabled
        persistSelectionAsync()
    }

    override suspend fun send(text: String) {
        val prompt = text.trim()
        if (prompt.isEmpty()) return
        if (!mutable.value.runtimeEnabled) return setError("主端 AI Runtime 未启用")
        if (mutable.value.running || mutable.value.waitingPermission != null) return
        val provider = mutable.value.providers.firstOrNull { it.id == selectedProviderId }
            ?: return setError("没有可用的 AI Provider")
        val model = provider.models.firstOrNull { it.id == selectedModelId }
            ?: return setError("该 Provider 没有可用模型")
        val ids = mutable.value.attachments.map { it.id }
        val runtimeSession = ensureRuntimeSession() ?: return
        val conversationId = mutable.value.conversationId ?: "conversation-${UUID.randomUUID()}"
        val userMessageId = "message-${UUID.randomUUID()}"
        val assistantMessageId = "message-${UUID.randomUUID()}"
        append(AiTranscriptItem.User(prompt))
        mutable.update { it.copy(running = true, error = null, conversationId = conversationId) }
        val effectiveMode = if (selectedMode == "standard") selectedRunProfile else selectedMode
        val options = JsonObject(
            mapOf("reasoning_effort" to JsonPrimitive(selectedThinking))
                .takeIf { model.reasoning && selectedThinking != "none" }
                .orEmpty(),
        )
        val request = AiRunRequestDto(
            sessionId = runtimeSession,
            conversationId = conversationId,
            title = titleFor(prompt),
            userMessageId = userMessageId,
            assistantMessageId = assistantMessageId,
            historyUserContent = prompt,
            message = prompt,
            attachments = ids,
            providerId = provider.id,
            model = model.id,
            options = options,
            context = context(),
            mode = if (planEnabled && effectiveMode == "balanced") "plan" else effectiveMode,
            permissionMode = selectedPermission,
            permission = AiRunPermissionDto(mode = selectedPermission),
        )
        when (val result = account.aiRuntime.startRun(request)) {
            is ApiResult.Failure -> failRun(result)
            is ApiResult.Success -> beginStream(result.value)
        }
    }

    override suspend fun stop() {
        val runId = mutable.value.runId ?: return
        streamJob?.cancel()
        streamJob = null
        when (val result = account.aiRuntime.abort(runId)) {
            is ApiResult.Failure -> fail(result)
            is ApiResult.Success -> mutable.update {
                it.copy(running = false, runId = null, waitingPermission = null)
            }
        }
    }

    override suspend fun decide(approve: Boolean) {
        val pending = mutable.value.waitingPermission ?: return
        val runId = mutable.value.runId ?: return
        val sessionId = mutable.value.runtimeSessionId ?: return
        mutable.update { it.copy(waitingPermission = null, loading = true) }
        val request = AiRunDecisionRequestDto(
            sessionId = sessionId,
            callId = pending.callId,
            tool = pending.tool,
            approve = approve,
            providerId = selectedProviderId,
            model = selectedModelId,
        )
        when (val result = account.aiRuntime.decide(runId, request)) {
            is ApiResult.Failure -> fail(result)
            is ApiResult.Success -> {
                markTraceDecision(pending.callId, approve)
                mutable.update { it.copy(loading = false, running = approve) }
                if (approve && result.value.resumed) {
                    val path = "/api/ai/runtime/runs/$runId/events?ticket=${result.value.ticket}"
                    launchStream(path, runId)
                } else if (!approve) {
                    mutable.update { it.copy(running = false, runId = null) }
                    refresh()
                }
            }
        }
    }

    override suspend fun upload(file: AiUpload) {
        file.use { owned ->
            val sessionId = ensureRuntimeSession() ?: return
            mutable.update { it.copy(loading = true, error = null) }
            when (val result = account.aiRuntime.upload(sessionId, owned.name, owned.mime, owned.bytes)) {
                is ApiResult.Failure -> fail(result)
                is ApiResult.Success -> mutable.update {
                    it.copy(
                        loading = false,
                        attachments = it.attachments + result.value.let { item ->
                            AiAttachment(item.id, item.name, item.mime, item.size, item.kind)
                        },
                    )
                }
            }
        }
    }

    override suspend fun removeAttachment(id: String) {
        val sessionId = mutable.value.runtimeSessionId ?: return
        when (val result = account.aiRuntime.deleteAttachment(sessionId, id)) {
            is ApiResult.Failure -> fail(result)
            is ApiResult.Success -> mutable.update { state ->
                state.copy(attachments = state.attachments.filterNot { it.id == id })
            }
        }
    }

    override fun clearError() = mutable.update { it.copy(error = null) }

    private suspend fun ensureRuntimeSession(): String? {
        mutable.value.runtimeSessionId?.let { return it }
        return when (val result = account.aiRuntime.createSession("Zephyr One")) {
            is ApiResult.Failure -> {
                fail(result)
                null
            }
            is ApiResult.Success -> {
                val id = result.value.session?.id ?: result.value.sessionId
                if (id.isNullOrBlank()) {
                    setError("主端没有返回 AI sessionId")
                    null
                } else {
                    mutable.update { it.copy(runtimeSessionId = id) }
                    id
                }
            }
        }
    }

    private fun beginStream(start: AiRunStartDto) {
        mutable.update {
            it.copy(
                runtimeSessionId = start.sessionId,
                conversationId = start.conversationId,
                runId = start.runId,
                running = true,
                attachments = emptyList(),
            )
        }
        lastEventId = 0
        traceIndex.clear()
        launchStream(start.sseProxyPath.ifBlank { start.ssePath }, start.runId)
    }

    private fun launchStream(path: String, runId: String) {
        streamJob?.cancel()
        streamJob = scope.launch(Dispatchers.IO) {
            try {
                when (val result = account.aiRuntime.stream(path, lastEventId, ::onEvent)) {
                    is ApiResult.Failure -> if (mutable.value.waitingPermission == null) failRun(result)
                    is ApiResult.Success -> Unit
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            }
        }
        mutable.update { it.copy(runId = runId, running = true, loading = false) }
    }

    private suspend fun onEvent(event: AiRuntimeEvent) {
        if (event.seq > 0) lastEventId = maxOf(lastEventId, event.seq)
        when (event.type) {
            "text.delta" -> appendAssistantDelta(event.data.string("text"))
            "message.completed" -> replaceAssistant(event.data.string("content"))
            "reasoning.delta" -> Unit
            "tool.pending", "tool.start" -> upsertTrace(event)
            "tool.result", "tool.error" -> completeTrace(event)
            "permission.ask" -> askPermission(event)
            "client.capture" -> {
                setError("AI 请求了原生 RDP/VNC 视觉操作；当前画面桥接正在等待该会话重新采集")
                mutable.update { it.copy(running = false) }
            }
            "run.completed" -> finishRun()
            "run.failed" -> finishRun(event.data.string("error").ifBlank { "AI 运行失败" })
            "run.aborted" -> finishRun("AI 运行已停止")
        }
    }

    private fun upsertTrace(event: AiRuntimeEvent) {
        val callId = event.data.string("callId")
        val tool = event.data.string("name").ifBlank { "tool" }
        val item = AiTranscriptItem.ToolTrace(
            title = if (event.type == "tool.pending") "准备 · $tool" else "执行 · $tool",
            command = event.data["args"]?.toString().orEmpty(),
            risk = "",
            status = if (event.type == "tool.pending") "pending" else "running",
        )
        upsert(callId, item)
    }

    private fun completeTrace(event: AiRuntimeEvent) {
        val callId = event.data.string("callId")
        val tool = event.data.string("name").ifBlank { "tool" }
        val item = AiTranscriptItem.ToolTrace(
            title = if (event.type == "tool.error") "失败 · $tool" else "完成 · $tool",
            command = "",
            status = if (event.type == "tool.error") "error" else event.data.string("status").ifBlank { "success" },
            durationMs = event.data.long("durationMs"),
            result = event.data["result"]?.toString()?.take(MAX_TRACE_RESULT),
        )
        upsert(callId, item)
    }

    private fun askPermission(event: AiRuntimeEvent) {
        val pending = AiPendingPermission(
            askId = event.data.string("askId"),
            callId = event.data.string("callId"),
            tool = event.data.string("name"),
            summary = event.data.string("summary").ifBlank { "允许执行 ${event.data.string("name")}？" },
            risk = event.data.string("risk"),
            args = event.data["args"] as? JsonObject ?: JsonObject(emptyMap()),
        )
        upsert(
            pending.callId,
            AiTranscriptItem.ToolTrace(
                title = "待确认 · ${pending.tool}",
                command = pending.args.toString(),
                risk = pending.risk,
            ),
        )
        streamJob?.cancel()
        streamJob = null
        mutable.update { it.copy(waitingPermission = pending, running = false) }
    }

    private suspend fun finishRun(message: String? = null) {
        if (!message.isNullOrBlank()) append(AiTranscriptItem.Assistant(message, "系统"))
        streamJob = null
        mutable.update { it.copy(running = false, runId = null, waitingPermission = null) }
        delay(350)
        refresh()
    }

    private fun failRun(result: ApiResult.Failure) {
        mutable.update { it.copy(running = false, runId = null, error = result.error.message) }
    }

    private fun fail(result: ApiResult.Failure) {
        mutable.update { it.copy(loading = false, error = result.error.message) }
    }

    private fun setError(message: String) = mutable.update { it.copy(error = message, loading = false) }

    private fun append(item: AiTranscriptItem) = mutable.update { state ->
        state.copy(conversation = state.conversation.copy(items = state.conversation.items + item))
    }

    private fun appendAssistantDelta(delta: String) {
        if (delta.isEmpty()) return
        mutable.update { state ->
            val items = state.conversation.items.toMutableList()
            val last = items.lastOrNull()
            if (last is AiTranscriptItem.Assistant && last.caption == selectedModelId) {
                items[items.lastIndex] = last.copy(text = last.text + delta)
            } else {
                items += AiTranscriptItem.Assistant(delta, selectedModelId)
            }
            state.copy(conversation = state.conversation.copy(items = items))
        }
    }

    private fun replaceAssistant(content: String) {
        if (content.isEmpty()) return
        mutable.update { state ->
            val items = state.conversation.items.toMutableList()
            val index = items.indexOfLast { it is AiTranscriptItem.Assistant }
            if (index >= 0) items[index] = AiTranscriptItem.Assistant(content, selectedModelId)
            else items += AiTranscriptItem.Assistant(content, selectedModelId)
            state.copy(conversation = state.conversation.copy(items = items))
        }
    }

    private fun upsert(callId: String, item: AiTranscriptItem.ToolTrace) {
        mutable.update { state ->
            val items = state.conversation.items.toMutableList()
            val index = traceIndex[callId]
            if (index != null && index in items.indices) items[index] = item
            else {
                traceIndex[callId] = items.size
                items += item
            }
            state.copy(conversation = state.conversation.copy(items = items))
        }
    }

    private fun markTraceDecision(callId: String, approve: Boolean) {
        mutable.update { state ->
            val items = state.conversation.items.toMutableList()
            val index = traceIndex[callId]
            val trace = index?.takeIf { it in items.indices }?.let { items[it] as? AiTranscriptItem.ToolTrace }
            if (trace != null) {
                items[index] = trace.copy(approved = approve, denied = !approve, status = if (approve) "approved" else "denied")
            }
            state.copy(conversation = state.conversation.copy(items = items))
        }
    }

    private suspend fun persistSelection() {
        val provider = mutable.value.providers.firstOrNull { it.id == selectedProviderId }
        val next = chrome().copy(
            providerId = selectedProviderId,
            provider = provider?.name ?: "未选择 Provider",
            model = selectedModelId.ifBlank { "未选择模型" },
            collaboration = selectedMode,
            runProfile = selectedRunProfile,
            permission = selectedPermission,
            thinking = selectedThinking,
            planEnabled = planEnabled,
            online = true,
            runtimeAvailable = mutable.value.runtimeEnabled,
        )
        persistChrome(next)
    }

    private fun persistSelectionAsync() {
        scope.launch { persistSelection() }
    }

    private fun selectConversation(history: List<AiHistoryConversationDto>): AiHistoryConversationDto? {
        val current = mutable.value.conversationId
        return history.firstOrNull { it.id == current } ?: history.maxByOrNull { it.updatedAt }
    }

    private fun AiHistoryConversationDto.toConversation(): AiConversation = AiConversation(
        messages.mapNotNull { message ->
            when (message.role.lowercase()) {
                "user" -> AiTranscriptItem.User(message.content)
                "assistant" -> AiTranscriptItem.Assistant(message.content, model)
                else -> null
            }
        },
    )

    private fun AiProviderDto.toOption(): AiProviderOption = AiProviderOption(
        id = id,
        name = name,
        owned = owned,
        models = models.filterNot { it.hidden }.map { model ->
            AiModelOption(
                id = model.id,
                label = model.label,
                reasoning = model.reasoning,
                acceptsImage = model.input.image,
                acceptsPdf = model.input.pdf,
                acceptsAudio = model.input.audio,
                acceptsVideo = model.input.video,
            )
        },
    )

    private fun titleFor(prompt: String): String = prompt.lineSequence().first().take(80).ifBlank { "新对话" }
    private fun normalize(value: String, allowed: Set<String>, fallback: String): String =
        value.takeIf(allowed::contains) ?: fallback
    private fun JsonObject.string(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
    private fun JsonObject.long(key: String): Long? = (get(key) as? JsonPrimitive)?.contentOrNull?.toLongOrNull()

    private companion object {
        val MODES = setOf("standard", "plan", "goal")
        val RUN_PROFILES = setOf("economy", "balanced", "delivery")
        val PERMISSIONS = setOf("ask", "auto", "yolo")
        const val MAX_TRACE_RESULT = 8_000
    }
}
