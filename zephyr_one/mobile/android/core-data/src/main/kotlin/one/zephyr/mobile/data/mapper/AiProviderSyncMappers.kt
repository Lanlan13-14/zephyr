package one.zephyr.mobile.data.mapper

import one.zephyr.mobile.data.repository.LocalAiModel
import one.zephyr.mobile.data.repository.LocalAiProvider
import one.zephyr.mobile.model.AiProvider

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
    fun AiProvider.toLocal(source: String = "main"): LocalAiProvider = LocalAiProvider(
        id = id, name = name, type = type, baseUrl = baseUrl, apiMode = config.apiMode,
        defaultModel = defaultModel,
        models = models.map { m -> LocalAiModel(
            id = m.id, label = m.label, hidden = m.hidden, contextWindowTokens = m.contextWindowTokens,
            maxOutputTokens = m.maxOutputTokens, temperature = m.temperature, topP = m.topP,
            reasoning = m.reasoning, reasoningEffort = m.reasoningEffort, inputImage = m.inputImage,
            inputPdf = m.inputPdf, inputAudio = m.inputAudio, inputVideo = m.inputVideo,
            outputImage = m.outputImage, outputAudio = m.outputAudio, tools = m.tools,
            parallelToolCalls = m.parallelToolCalls, promptCache = m.promptCache,
            maxImagesPerRequest = m.maxImagesPerRequest, maxImageBytes = m.maxImageBytes,
            apiMode = m.apiMode,
        ) },
        temperature = config.temperature, topP = config.topP, maxTokens = config.maxTokens ?: 4096,
        contextWindowTokens = config.windowTokens, reasoningEffort = config.reasoningEffort,
        visionDefault = config.vision, usePreviousResponse = config.usePreviousResponseId,
        presencePenalty = config.presencePenalty ?: 0.0, frequencyPenalty = config.frequencyPenalty ?: 0.0,
        visibility = visibility, shareWithUsers = shareWithUsers, shareWithAdmins = shareWithAdmins,
        sharedUserIds = sharedUserIds, enabled = enabled, source = source, revision = revision,
    )

    /** Local catalog row -> push model. Mirrors the canonical server schema; every default
     * here must be a value the server's safeConfig/safeOptions accepts, or a legitimate
     * main-end configuration gets rejected as invalid_ai_provider on push. */
    fun LocalAiProvider.toModel(owner: String): AiProvider = AiProvider(
        id = id, ownerUserId = owner, name = name, type = type,
        baseUrl = baseUrl.trim(), defaultModel = defaultModel.trim(),
        models = models.filter { it.id.trim().isNotEmpty() }.distinctBy { it.id.trim() }.map { m -> one.zephyr.mobile.model.AiModel(
            id = m.id, label = m.label, hidden = m.hidden, contextWindowTokens = m.contextWindowTokens,
            maxOutputTokens = m.maxOutputTokens, temperature = m.temperature, topP = m.topP,
            reasoning = m.reasoning, reasoningEffort = m.reasoningEffort, inputImage = m.inputImage,
            inputPdf = m.inputPdf, inputAudio = m.inputAudio, inputVideo = m.inputVideo,
            outputImage = m.outputImage, outputAudio = m.outputAudio, tools = m.tools,
            parallelToolCalls = m.parallelToolCalls, promptCache = m.promptCache,
            maxImagesPerRequest = m.maxImagesPerRequest, maxImageBytes = m.maxImageBytes,
            apiMode = m.apiMode,
        ) },
        config = one.zephyr.mobile.model.AiProviderConfig(
            apiMode = apiMode.takeIf { it in setOf("auto", "chat", "responses") } ?: "auto",
            temperature = temperature?.takeIf { it.isFinite() }, topP = topP?.takeIf { it.isFinite() },
            maxTokens = maxTokens.takeIf { it > 0 }, maxOutputTokens = maxOutputTokens?.takeIf { it > 0 },
            presencePenalty = presencePenalty.takeIf { it.isFinite() }, frequencyPenalty = frequencyPenalty.takeIf { it.isFinite() },
            vision = visionDefault, usePreviousResponseId = usePreviousResponse,
            reasoningEffort = reasoningEffort?.takeIf { it in setOf("none", "minimal", "low", "medium", "high", "xhigh", "max") },
            windowTokens = contextWindowTokens?.takeIf { it > 0 },
        ),
        visibility = visibility, shareWithUsers = shareWithUsers, shareWithAdmins = shareWithAdmins,
        sharedUserIds = sharedUserIds, enabled = enabled,
    )
}