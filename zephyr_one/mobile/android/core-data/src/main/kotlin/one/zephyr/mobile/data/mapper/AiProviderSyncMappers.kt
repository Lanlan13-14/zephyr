package one.zephyr.mobile.data.mapper

import one.zephyr.mobile.data.repository.LocalAiModel
import one.zephyr.mobile.data.repository.LocalAiProvider
import one.zephyr.mobile.model.AiModel
import one.zephyr.mobile.model.AiProvider
import one.zephyr.mobile.model.AiProviderConfig

/**
 * The provider mirror round-trip: server projection -> local catalog row and back.
 *
 * These five segments (projectAiProvider -> aiProvider() -> toLocal() -> toModel() ->
 * aiProviderValues()) are the sync's weakest symmetry point, so the transformations live here
 * as a shared object instead of private bindings: production and the round-trip contract test
 * must run byte-for-byte the same mapping, and a field added on either end without its
 * counterpart fails the matrix in AiProviderRoundTripTest instead of surfacing as
 * invalid_ai_provider on a real device.
 */
object AiProviderSyncMappers {

    /** Mirror model -> local catalog row. Replaces a private copy in AiEntityBindings. */
    fun toLocal(provider: AiProvider, source: String = "main"): LocalAiProvider = LocalAiProvider(
        id = provider.id, name = provider.name, type = provider.type, baseUrl = provider.baseUrl,
        apiMode = provider.config.apiMode,
        defaultModel = provider.defaultModel,
        models = provider.models.map { m -> LocalAiModel(
            id = m.id, label = m.label, hidden = m.hidden, contextWindowTokens = m.contextWindowTokens,
            maxOutputTokens = m.maxOutputTokens, temperature = m.temperature, topP = m.topP,
            reasoning = m.reasoning, reasoningEffort = m.reasoningEffort, inputImage = m.inputImage,
            inputPdf = m.inputPdf, inputAudio = m.inputAudio, inputVideo = m.inputVideo,
            outputImage = m.outputImage, outputAudio = m.outputAudio, tools = m.tools,
            parallelToolCalls = m.parallelToolCalls, promptCache = m.promptCache,
            maxImagesPerRequest = m.maxImagesPerRequest, maxImageBytes = m.maxImageBytes,
            apiMode = m.apiMode,
        ) },
        temperature = provider.config.temperature, topP = provider.config.topP,
        maxTokens = provider.config.maxTokens ?: 4096,
        contextWindowTokens = provider.config.windowTokens, reasoningEffort = provider.config.reasoningEffort,
        visionDefault = provider.config.vision, usePreviousResponse = provider.config.usePreviousResponseId,
        presencePenalty = provider.config.presencePenalty ?: 0.0, frequencyPenalty = provider.config.frequencyPenalty ?: 0.0,
        visibility = provider.visibility, shareWithUsers = provider.shareWithUsers, shareWithAdmins = provider.shareWithAdmins,
        sharedUserIds = provider.sharedUserIds, enabled = provider.enabled, source = source, revision = provider.revision,
    )

    /** Local catalog row -> push model. Mirrors the canonical server schema; every default
     * here must be a value the server's safeConfig/safeOptions accepts, or a legitimate
     * main-end configuration gets rejected as invalid_ai_provider on push. */
    fun toModel(local: LocalAiProvider, owner: String): AiProvider = AiProvider(
        id = local.id, ownerUserId = owner, name = local.name, type = local.type,
        baseUrl = local.baseUrl.trim(), defaultModel = local.defaultModel.trim(),
        models = local.models.filter { it.id.trim().isNotEmpty() }.distinctBy { it.id.trim() }.map { m -> AiModel(
            id = m.id, label = m.label, hidden = m.hidden, contextWindowTokens = m.contextWindowTokens,
            maxOutputTokens = m.maxOutputTokens, temperature = m.temperature, topP = m.topP,
            reasoning = m.reasoning, reasoningEffort = m.reasoningEffort, inputImage = m.inputImage,
            inputPdf = m.inputPdf, inputAudio = m.inputAudio, inputVideo = m.inputVideo,
            outputImage = m.outputImage, outputAudio = m.outputAudio, tools = m.tools,
            parallelToolCalls = m.parallelToolCalls, promptCache = m.promptCache,
            maxImagesPerRequest = m.maxImagesPerRequest, maxImageBytes = m.maxImageBytes,
            apiMode = m.apiMode,
        ) },
        config = AiProviderConfig(
            apiMode = local.apiMode.takeIf { it in setOf("auto", "chat", "responses") } ?: "auto",
            temperature = local.temperature?.takeIf { it.isFinite() }, topP = local.topP?.takeIf { it.isFinite() },
            maxTokens = local.maxTokens.takeIf { it > 0 }, maxOutputTokens = local.maxOutputTokens?.takeIf { it > 0 },
            presencePenalty = local.presencePenalty.takeIf { it.isFinite() }, frequencyPenalty = local.frequencyPenalty.takeIf { it.isFinite() },
            vision = local.visionDefault, usePreviousResponseId = local.usePreviousResponse,
            reasoningEffort = local.reasoningEffort?.takeIf { it in setOf("none", "minimal", "low", "medium", "high", "xhigh", "max") },
            windowTokens = local.contextWindowTokens?.takeIf { it > 0 },
        ),
        visibility = local.visibility, shareWithUsers = local.shareWithUsers, shareWithAdmins = local.shareWithAdmins,
        sharedUserIds = local.sharedUserIds, enabled = local.enabled,
    )
}