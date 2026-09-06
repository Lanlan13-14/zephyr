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
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.repository.LocalAiCatalog
import one.zephyr.mobile.data.repository.LocalAiProvider
import one.zephyr.mobile.feature.ai.*
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.AiRuntimeEvent

/** Local-first Android AI controller backed by the packaged Zephyr Go agent loop. */
internal class LocalAndroidAiRuntimeController(
    private val account: AccountContainer,
    private val scope: CoroutineScope,
    private val context: () -> JsonObject,
    private val persistChrome: suspend (AiWorkspaceChrome) -> Unit,
    private val platformHost: AndroidAiPlatformHost,
) : AiRuntimeController {
    private val api = EmbeddedAiRuntimeApi(account.appContainer().embeddedAiRuntime, platformHost)
    private val mutable = MutableStateFlow(AiRuntimeState())
    override val state: StateFlow<AiRuntimeState> = mutable.asStateFlow()
    private var catalog = LocalAiCatalog()
    private var providerId = ""
    private var modelId = ""
    private var mode = "standard"
    private var profile = "balanced"
    private var permission = "ask"
    private var thinking = "medium"
    private var plan = false
    private var streamJob: Job? = null
    private var lastSeq = 0L
    private val traces = mutableMapOf<String, Int>()

    override suspend fun refresh() {
        mutable.update { it.copy(loading = true, error = null) }
        catalog = account.localAi.load()
        val providers = catalog.providers.filter { it.enabled }.map { p -> p.option() }
        providerId = providerId.takeIf { id -> providers.any { it.id == id } }
            ?: catalog.defaultProviderId.takeIf { id -> providers.any { it.id == id } }
            ?: providers.firstOrNull()?.id.orEmpty()
        val selected = providers.firstOrNull { it.id == providerId }
        modelId = modelId.takeIf { id -> selected?.models?.any { it.id == id } == true }
            ?: catalog.defaultModel.takeIf { id -> selected?.models?.any { it.id == id } == true }
            ?: catalog.providers.firstOrNull { it.id == providerId }?.defaultModel?.takeIf { id -> selected?.models?.any { it.id == id } == true }
            ?: selected?.models?.firstOrNull()?.id.orEmpty()
        val sessions = (api.listSessions(account.binding.userId, account.generation) as? ApiResult.Success)?.value.orEmpty()
        val session = sessions.maxByOrNull { it.updatedAt }
        val briefList = sessions.map {
            one.zephyr.mobile.feature.ai.AiConversationBrief(it.id, it.title.ifBlank { "新对话" }, it.updatedAt)
        }
        val conversation = session?.let { api.messages(account.binding.userId, account.generation, it.id) }
            .let { result -> (result as? ApiResult.Success)?.value?.mapNotNull { m -> when (m.role) { "user" -> AiTranscriptItem.User(m.content); "assistant" -> AiTranscriptItem.Assistant(m.content, modelId); else -> null } }.orEmpty() }
        mutable.value = mutable.value.copy(
            runtimeEnabled = catalog.enabled && providers.isNotEmpty(),
            loading = false,
            providers = providers,
            conversationId = session?.id,
            conversationTitle = session?.title?.ifBlank { "新对话" } ?: "新对话",
            conversations = briefList,
            runtimeSessionId = session?.id,
            conversation = AiConversation(conversation),
        )
        persist()
    }

    override fun selectConversation(id: String) {
        scope.launch {
            val messages = api.messages(account.binding.userId, account.generation, id)
            val conversation = (messages as? ApiResult.Success)?.value?.mapNotNull { m ->
                when (m.role) {
                    "user" -> AiTranscriptItem.User(m.content)
                    "assistant" -> AiTranscriptItem.Assistant(m.content, modelId)
                    else -> null
                }
            }.orEmpty()
            val sessions = (api.listSessions(account.binding.userId, account.generation) as? ApiResult.Success)?.value.orEmpty()
            val target = sessions.firstOrNull { it.id == id }
            mutable.update {
                it.copy(
                    conversationId = id,
                    runtimeSessionId = id,
                    conversationTitle = target?.title?.ifBlank { "新对话" } ?: "新对话",
                    conversation = AiConversation(conversation),
                    error = null,
                )
            }
        }
    }

    override fun newConversation() {
        val newId = "session-${UUID.randomUUID()}"
        mutable.update {
            it.copy(
                conversationId = newId,
                runtimeSessionId = newId,
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
        account.ownedAi.delete(one.zephyr.mobile.model.AiConversationRecord.ENTITY_TYPE, targetId, ownerUserId)
        val messages = account.ownedAi.listMessages(ownerUserId, targetId)
        for (m in messages) {
            account.ownedAi.delete(one.zephyr.mobile.model.AiMessageRecord.ENTITY_TYPE, m.id, ownerUserId)
        }
        val sessions = (api.listSessions(account.binding.userId, account.generation) as? ApiResult.Success)?.value.orEmpty()
        val briefList = sessions.filter { it.id != targetId }.map {
            one.zephyr.mobile.feature.ai.AiConversationBrief(it.id, it.title.ifBlank { "新对话" }, it.updatedAt)
        }
        val next = sessions.filter { it.id != targetId }.maxByOrNull { it.updatedAt }
        if (next != null) {
            selectConversation(next.id)
        } else {
            newConversation()
        }
        mutable.update { it.copy(loading = false, conversations = briefList) }
    }

    override fun selectProvider(providerId: String) { if (catalog.providers.any { it.id == providerId && it.enabled }) { this.providerId = providerId; modelId = catalog.providers.first { it.id == providerId }.models.firstOrNull { !it.hidden }?.id.orEmpty(); persistAsync() } }
    override fun selectModel(modelId: String) { if (catalog.providers.firstOrNull { it.id == providerId }?.models?.any { it.id == modelId && !it.hidden } == true) { this.modelId = modelId; persistAsync() } }
    override fun selectMode(mode: String) { this.mode = mode.takeIf { it in setOf("standard","plan","goal") } ?: "standard"; persistAsync() }
    override fun selectRunProfile(profile: String) { this.profile = profile.takeIf { it in setOf("economy","balanced","delivery") } ?: "balanced"; persistAsync() }
    override fun selectPermission(mode: String) { permission = mode.takeIf { it in setOf("ask","auto","yolo") } ?: "ask"; persistAsync() }
    override fun selectThinking(value: String) { thinking = value; persistAsync() }
    override fun setPlanEnabled(enabled: Boolean) { plan = enabled; persistAsync() }

    override suspend fun send(text: String) {
        val prompt = text.trim(); if (prompt.isEmpty() || mutable.value.running) return
        catalog = account.localAi.load()
        val provider = catalog.providers.firstOrNull { it.id == providerId && it.enabled } ?: return error("没有可用的本机 AI Provider")
        val model = provider.models.firstOrNull { it.id == modelId && !it.hidden } ?: return error("没有可用模型")
        val apiKey = account.localAi.providerApiKey(provider.id)
        val envValues = linkedMapOf<String, CharArray>()
        try {
            val sessionId = mutable.value.runtimeSessionId ?: when (val created = api.createSession(account.binding.userId, account.generation, "Zephyr One")) {
                is ApiResult.Success -> created.value.id
                is ApiResult.Failure -> return fail(created)
            }
            catalog.environment.filter { it.enabled && it.visibleToAi }.forEach { e -> account.localAi.environmentValue(e.id)?.let { envValues[e.id] = it } }
            val p = provider.wire(apiKey?.concatToString().orEmpty())
            val selectedMode = if (plan || catalog.planner.requirePlanBeforeTools) "plan" else if (mode == "standard") profile else mode
            val options = buildJsonObject {
                model.temperature?.let { put("temperature", it) }; model.topP?.let { put("top_p", it) }
                put("max_tokens", model.maxOutputTokens ?: provider.maxTokens)
                if (model.reasoning && thinking != "none") put("reasoning_effort", thinking)
            }
            val rules = catalog.permissionRules
            val request = EmbeddedStartRun(
                userId = account.binding.userId, sessionId = sessionId, provider = p, model = model.id,
                message = prompt, options = options, maxSteps = catalog.context.maxToolRounds,
                permission = EmbeddedPermission(permission.ifBlank { rules.mode }, rules.deny, rules.ask, rules.allow),
                autoConfirm = catalog.sensitive.autoConfirm, autoConfirmDelayMs = catalog.sensitive.autoConfirmDelayMs,
                mode = selectedMode, systemCompose = EmbeddedCompose(
                    assistantName = catalog.assistantName, defaultSystemPrompt = DEFAULT_GUIDANCE,
                    customSystemPrompt = catalog.systemPrompt, contextText = context().toString(), locale = "zh-CN",
                    skills = catalog.skills.filter { it.enabled }.map { EmbeddedSkill(it.id,it.name,it.description,it.prompt,it.enabled) },
                    memories = catalog.memories.filter { it.enabled }.take(catalog.context.memoryItems).map { EmbeddedMemory(it.title,it.content,it.scope,it.project,it.tags) },
                    envVars = catalog.environment.filter { it.enabled && it.visibleToAi }.map { e -> EmbeddedEnv(e.name,e.description,envValues[e.id]?.concatToString().orEmpty(),e.valueVisibleToAi) },
                ), context = context(), mcpServers = catalog.mcpServers.filter { it.enabled }.map { s ->
                    val headers = account.localAi.mcpHeaders(s.id)?.let { chars -> try { parseHeaders(chars.concatToString()) } finally { chars.fill('\u0000') } }.orEmpty()
                    EmbeddedMcpServer(s.name,s.type,s.command,s.args,s.env,s.url,headers,s.timeoutSeconds,s.trustedReadOnly)
                }, databaseGeneration = account.generation, runNonce = UUID.randomUUID().toString(),
                contextWindowTokens = model.contextWindowTokens ?: provider.contextWindowTokens ?: catalog.context.windowTokens,
                outputReserveTokens = model.maxOutputTokens ?: provider.maxTokens,
            )
            append(AiTranscriptItem.User(prompt)); mutable.update { it.copy(running = true, runtimeSessionId = sessionId, conversationId = sessionId, error = null) }
            when (val started = api.start(request)) { is ApiResult.Failure -> failRun(started); is ApiResult.Success -> begin(started.value) }
        } finally { apiKey?.fill('\u0000'); envValues.values.forEach { it.fill('\u0000') } }
    }

    override suspend fun stop() { val id = mutable.value.runId ?: return; streamJob?.cancel(); when (val r = api.abort(id)) { is ApiResult.Failure -> fail(r); is ApiResult.Success -> mutable.update { it.copy(running=false,runId=null,waitingPermission=null) } } }
    override suspend fun decide(approve: Boolean) {
        val pending = mutable.value.waitingPermission ?: return; val run = mutable.value.runId ?: return; val session = mutable.value.runtimeSessionId ?: return
        val provider = catalog.providers.firstOrNull { it.id == providerId } ?: return; val key = account.localAi.providerApiKey(provider.id)
        try { when (val r = api.decide(run, EmbeddedPermissionDecision(account.binding.userId,session,pending.callId,pending.tool,approve,provider=provider.wire(key?.concatToString().orEmpty())))) {
            is ApiResult.Failure -> fail(r); is ApiResult.Success -> { mark(pending.callId,approve); mutable.update { it.copy(waitingPermission=null,loading=false,running=approve) }; if (approve && r.value.resumed) launch("/v1/runs/$run/events?ticket=${r.value.ticket}",run) else if (!approve) refresh() }
        } } finally { key?.fill('\u0000') }
    }
    override suspend fun upload(file: AiUpload) { file.use { owned ->
        val safe = owned.name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
        account.localAiWorkspace.importUpload(safe, owned.bytes)
        mutable.update { it.copy(attachments = it.attachments + AiAttachment("local:$safe", safe, owned.mime, owned.bytes.size.toLong(), "document")) }
    } }
    override suspend fun removeAttachment(id: String) { mutable.update { it.copy(attachments=it.attachments.filterNot { a -> a.id==id }) } }
    override fun clearError() { mutable.update { it.copy(error=null) } }

    fun close() { streamJob?.cancel(); platformHost.close() }

    private fun begin(start: one.zephyr.mobile.network.AiRunStartDto) { mutable.update { it.copy(runtimeSessionId=start.sessionId,conversationId=start.sessionId,runId=start.runId,running=true) }; lastSeq=0; traces.clear(); launch(start.ssePath,start.runId) }
    private fun launch(path: String, run: String) { streamJob?.cancel(); streamJob=scope.launch(Dispatchers.IO) { try { when (val r=api.stream(path,lastSeq,::event)) { is ApiResult.Failure -> if (mutable.value.waitingPermission==null) failRun(r); else -> Unit } } catch (c: CancellationException) { throw c } }; mutable.update { it.copy(runId=run,running=true,loading=false) } }
    private suspend fun event(e: AiRuntimeEvent) { if(e.seq>0)lastSeq=maxOf(lastSeq,e.seq); when(e.type){ "text.delta"->delta(e.data.string("text")); "message.completed"->replace(e.data.string("content")); "tool.pending","tool.start"->trace(e,false); "tool.result","tool.error"->trace(e,true); "permission.ask"->ask(e); "run.completed"->finish(); "run.failed"->finish(e.data.string("error").ifBlank{"AI 运行失败"}); "run.aborted"->finish("AI 运行已停止") } }
    private fun trace(e: AiRuntimeEvent, done:Boolean){ val id=e.data.string("callId"); upsert(id,AiTranscriptItem.ToolTrace(if(done)"完成 · ${e.data.string("name")}" else "执行 · ${e.data.string("name")}",e.data["args"]?.toString().orEmpty(),status=if(done)e.data.string("status").ifBlank{"success"} else "running",result=e.data["result"]?.toString()?.take(8000))) }
    private fun ask(e: AiRuntimeEvent){ val p=AiPendingPermission(e.data.string("askId"),e.data.string("callId"),e.data.string("name"),e.data.string("summary"),e.data.string("risk"),e.data["args"] as? JsonObject ?: JsonObject(emptyMap())); upsert(p.callId,AiTranscriptItem.ToolTrace("待确认 · ${p.tool}",p.args.toString(),p.risk)); streamJob?.cancel(); mutable.update { it.copy(waitingPermission=p,running=false) } }
    private suspend fun finish(message:String?=null){ message?.let{append(AiTranscriptItem.Assistant(it,"系统"))}; mutable.update { it.copy(running=false,runId=null,waitingPermission=null) }; delay(200); refresh() }
    private fun append(i:AiTranscriptItem)=mutable.update { it.copy(conversation=it.conversation.copy(items=it.conversation.items+i)) }
    private fun delta(s:String){ if(s.isEmpty())return; mutable.update { st->val l=st.conversation.items.toMutableList(); val x=l.lastOrNull(); if(x is AiTranscriptItem.Assistant&&x.caption==modelId)l[l.lastIndex]=x.copy(text=x.text+s)else l+=AiTranscriptItem.Assistant(s,modelId); st.copy(conversation=st.conversation.copy(items=l)) } }
    private fun replace(s:String){if(s.isBlank())return;mutable.update{st->val l=st.conversation.items.toMutableList();val i=l.indexOfLast{it is AiTranscriptItem.Assistant};if(i>=0)l[i]=AiTranscriptItem.Assistant(s,modelId)else l+=AiTranscriptItem.Assistant(s,modelId);st.copy(conversation=st.conversation.copy(items=l))}}
    private fun upsert(id:String,t:AiTranscriptItem.ToolTrace){mutable.update{st->val l=st.conversation.items.toMutableList();val i=traces[id];if(i!=null&&i in l.indices)l[i]=t else{traces[id]=l.size;l+=t};st.copy(conversation=st.conversation.copy(items=l))}}
    private fun mark(id:String,yes:Boolean){mutable.update{st->val l=st.conversation.items.toMutableList();val i=traces[id];val t=i?.takeIf{it in l.indices}?.let{l[it] as? AiTranscriptItem.ToolTrace};if(t!=null)l[i]=t.copy(approved=yes,denied=!yes,status=if(yes)"approved" else "denied");st.copy(conversation=st.conversation.copy(items=l))}}
    private fun fail(r:ApiResult.Failure){mutable.update{it.copy(loading=false,error=r.error.message)}}; private fun failRun(r:ApiResult.Failure){mutable.update{it.copy(running=false,runId=null,error=r.error.message)}}; private fun error(s:String){mutable.update{it.copy(loading=false,error=s)}}
    private fun persistAsync(){scope.launch{persist()}}; private suspend fun persist(){val p=catalog.providers.firstOrNull{it.id==providerId};persistChrome(AiWorkspaceChrome(enabled=catalog.enabled,providerId=providerId,provider=p?.name?:"未选择 Provider",model=modelId.ifBlank{"未选择模型"},collaboration=mode,runProfile=profile,permission=permission,thinking=thinking,planEnabled=plan,memoryEnabled=catalog.memoryEnabled,memoryCount=catalog.memories.size,skillsEnabled=catalog.skills.any{it.enabled},online=true,runtimeAvailable=catalog.enabled&&p!=null))}
    private fun LocalAiProvider.option()=AiProviderOption(id,name,models.filterNot{it.hidden}.map{AiModelOption(it.id,it.label,it.reasoning,it.inputImage,it.inputPdf,it.inputAudio,it.inputVideo)},true)
    private fun LocalAiProvider.wire(key:String)=EmbeddedProvider(id,name,type,baseUrl,key,defaultModel,models.map{it.id},apiMode,organization,parseHeaders(extraHeadersJson),buildJsonObject{temperature?.let{put("temperature",it)};topP?.let{put("top_p",it)};put("max_tokens",maxTokens);reasoningEffort?.let{put("reasoning_effort",it)};put("presence_penalty",presencePenalty);put("frequency_penalty",frequencyPenalty);put("use_previous_response_id",usePreviousResponse)})
    private fun parseHeaders(raw: String): Map<String, String> = runCatching {
        one.zephyr.mobile.network.MobileJson.instance.decodeFromString<Map<String, String>>(raw)
    }.getOrElse {
        raw.lineSequence().mapNotNull { line ->
            line.split(':', limit = 2).takeIf { parts -> parts.size == 2 }
                ?.let { parts -> parts[0].trim() to parts[1].trim() }
        }.toMap()
    }
    private fun JsonObject.string(k:String)=(this[k] as? JsonPrimitive)?.contentOrNull.orEmpty()
    companion object { const val DEFAULT_GUIDANCE="你是 Zephyr One 本机 AI 运维代理。能用工具完成的任务必须实际调用工具；先取事实，再执行；写操作遵守确认策略。" }
}
