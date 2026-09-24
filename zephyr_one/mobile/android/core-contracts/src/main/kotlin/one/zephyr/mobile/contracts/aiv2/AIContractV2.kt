// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.

package one.zephyr.mobile.contracts.aiv2

const val AI_CONTRACT_SCHEMA_VERSION: Int = 2

enum class ProviderFamily(val wire: String) {
    OPENAI("openai"),
    ANTHROPIC("anthropic"),
    GOOGLE("google"),
    DEEPSEEK("deepseek"),
    OLLAMA("ollama"),
    CUSTOM("custom");
    companion object {
        fun fromWire(value: String): ProviderFamily =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ProviderFamily has unsupported value: $value")
    }
}

enum class ProviderAPI(val wire: String) {
    OPENAI_RESPONSES("openai-responses"),
    OPENAI_CHAT_COMPLETIONS("openai-chat-completions"),
    ANTHROPIC_MESSAGES("anthropic-messages"),
    GOOGLE_GENERATIVE_AI("google-generative-ai"),
    OLLAMA_OPENAI("ollama-openai");
    companion object {
        fun fromWire(value: String): ProviderAPI =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ProviderAPI has unsupported value: $value")
    }
}

enum class AuthKind(val wire: String) {
    API_KEY("api-key"),
    BEARER_TOKEN("bearer-token"),
    DEVICE_ENVELOPE("device-envelope"),
    NONE("none");
    companion object {
        fun fromWire(value: String): AuthKind =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("AuthKind has unsupported value: $value")
    }
}

enum class SharingVisibility(val wire: String) {
    PRIVATE("private"),
    SHARED("shared");
    companion object {
        fun fromWire(value: String): SharingVisibility =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("SharingVisibility has unsupported value: $value")
    }
}

enum class PromptCache(val wire: String) {
    UNSUPPORTED("unsupported"),
    AUTO("auto"),
    EXPLICIT("explicit");
    companion object {
        fun fromWire(value: String): PromptCache =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("PromptCache has unsupported value: $value")
    }
}

enum class ReasoningLevel(val wire: String) {
    MINIMAL("minimal"),
    LOW("low"),
    MEDIUM("medium"),
    HIGH("high");
    companion object {
        fun fromWire(value: String): ReasoningLevel =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ReasoningLevel has unsupported value: $value")
    }
}

enum class PerformanceTier(val wire: String) {
    FAST("fast"),
    BALANCED("balanced"),
    QUALITY("quality");
    companion object {
        fun fromWire(value: String): PerformanceTier =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("PerformanceTier has unsupported value: $value")
    }
}

enum class ModelProvenance(val wire: String) {
    BUILTIN("builtin"),
    CATALOG_REMOTE("catalog-remote"),
    USER("user");
    companion object {
        fun fromWire(value: String): ModelProvenance =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ModelProvenance has unsupported value: $value")
    }
}

enum class DNSMode(val wire: String) {
    SYSTEM("system"),
    HOST_RESOLVED("host-resolved"),
    LITERAL("literal");
    companion object {
        fun fromWire(value: String): DNSMode =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("DNSMode has unsupported value: $value")
    }
}

enum class TLSMinVersion(val wire: String) {
    V1_2("1.2"),
    V1_3("1.3");
    companion object {
        fun fromWire(value: String): TLSMinVersion =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("TLSMinVersion has unsupported value: $value")
    }
}

enum class IPFamily(val wire: String) {
    IPV4("ipv4"),
    IPV6("ipv6");
    companion object {
        fun fromWire(value: String): IPFamily =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("IPFamily has unsupported value: $value")
    }
}

enum class ResolutionSource(val wire: String) {
    ANDROID_JVM_DNS("android-jvm-dns"),
    IOS_SYSTEM_DNS("ios-system-dns"),
    DESKTOP_SYSTEM_DNS("desktop-system-dns"),
    LITERAL("literal");
    companion object {
        fun fromWire(value: String): ResolutionSource =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ResolutionSource has unsupported value: $value")
    }
}

enum class StopReason(val wire: String) {
    STOP("stop"),
    LENGTH("length"),
    TOOL_USE("tool_use"),
    CONTENT_FILTER("content_filter"),
    CANCELLED("cancelled"),
    ERROR("error");
    companion object {
        fun fromWire(value: String): StopReason =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("StopReason has unsupported value: $value")
    }
}

enum class StreamEventType(val wire: String) {
    START("start"),
    TEXT_START("text_start"),
    TEXT_DELTA("text_delta"),
    TEXT_END("text_end"),
    REASONING_START("reasoning_start"),
    REASONING_DELTA("reasoning_delta"),
    REASONING_END("reasoning_end"),
    TOOL_CALL_START("tool_call_start"),
    TOOL_CALL_DELTA("tool_call_delta"),
    TOOL_CALL_END("tool_call_end"),
    USAGE("usage"),
    DONE("done"),
    ERROR("error");
    companion object {
        fun fromWire(value: String): StreamEventType =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("StreamEventType has unsupported value: $value")
    }
}

enum class TristateMode(val wire: String) {
    INHERIT("inherit"),
    OMIT("omit"),
    VALUE("value");
    companion object {
        fun fromWire(value: String): TristateMode =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("TristateMode has unsupported value: $value")
    }
}

enum class ExecutionFallback(val wire: String) {
    ASK("ask"),
    DENY("deny"),
    AUTOMATIC("automatic");
    companion object {
        fun fromWire(value: String): ExecutionFallback =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("ExecutionFallback has unsupported value: $value")
    }
}

enum class CellScope(val wire: String) {
    CONVERSATION("conversation"),
    GROUP("group");
    companion object {
        fun fromWire(value: String): CellScope =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("CellScope has unsupported value: $value")
    }
}

enum class RetentionPolicy(val wire: String) {
    RETAIN("retain"),
    PURGE_ON_DELETE("purge-on-delete");
    companion object {
        fun fromWire(value: String): RetentionPolicy =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("RetentionPolicy has unsupported value: $value")
    }
}

enum class CellBindingStatus(val wire: String) {
    ACTIVE("active"),
    RETAINING("retaining"),
    MIGRATING("migrating"),
    DESTROYED("destroyed");
    companion object {
        fun fromWire(value: String): CellBindingStatus =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("CellBindingStatus has unsupported value: $value")
    }
}

enum class AIEntityType(val wire: String) {
    AICONVERSATION("aiConversation"),
    AICONVERSATIONBRANCH("aiConversationBranch"),
    AIMESSAGE("aiMessage"),
    AIATTACHMENTMANIFEST("aiAttachmentManifest"),
    AITOOLRUN("aiToolRun"),
    AICONVERSATIONGROUP("aiConversationGroup"),
    AICELLBINDING("aiCellBinding"),
    AIPROVIDERACCOUNT("aiProviderAccount"),
    AISECRETBINDING("aiSecretBinding"),
    AIMODELOVERRIDE("aiModelOverride"),
    AIBEHAVIORPROFILE("aiBehaviorProfile"),
    AICELLPROFILE("aiCellProfile"),
    AIEXECUTIONPOLICY("aiExecutionPolicy");
    companion object {
        fun fromWire(value: String): AIEntityType =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("AIEntityType has unsupported value: $value")
    }
}

enum class AIClientAction(val wire: String) {
    FIX_INPUT("fix_input"),
    REAUTHENTICATE("reauthenticate"),
    RETRY("retry"),
    ABORT("abort"),
    UPGRADE("upgrade");
    companion object {
        fun fromWire(value: String): AIClientAction =
            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("AIClientAction has unsupported value: $value")
    }
}

data class AIErrorSpec(
    val code: String,
    val httpStatus: Int,
    val retryable: Boolean,
    val clientAction: AIClientAction,
)

object AIErrorTaxonomy {
    const val VERSION: Int = 2
    val errors: List<AIErrorSpec> = listOf(
        AIErrorSpec("ai_invalid_request", 400, false, AIClientAction.FIX_INPUT),
        AIErrorSpec("ai_auth_failed", 401, false, AIClientAction.REAUTHENTICATE),
        AIErrorSpec("ai_forbidden", 403, false, AIClientAction.ABORT),
        AIErrorSpec("ai_dns_failed", 503, true, AIClientAction.RETRY),
        AIErrorSpec("ai_tls_hostname_mismatch", 502, false, AIClientAction.ABORT),
        AIErrorSpec("ai_rate_limited", 429, true, AIClientAction.RETRY),
        AIErrorSpec("ai_upstream_unavailable", 503, true, AIClientAction.RETRY),
        AIErrorSpec("ai_context_length_exceeded", 400, false, AIClientAction.FIX_INPUT),
        AIErrorSpec("ai_content_filtered", 400, false, AIClientAction.ABORT),
        AIErrorSpec("ai_tool_timeout", 504, true, AIClientAction.RETRY),
        AIErrorSpec("ai_cell_unavailable", 503, true, AIClientAction.RETRY),
        AIErrorSpec("ai_lease_rejected", 409, false, AIClientAction.ABORT),
        AIErrorSpec("ai_contract_version_unsupported", 400, false, AIClientAction.UPGRADE),
        AIErrorSpec("ai_sync_quarantined", 409, false, AIClientAction.FIX_INPUT),
        AIErrorSpec("ai_cancelled", 499, false, AIClientAction.ABORT),
    )

    fun byCode(code: String): AIErrorSpec =
        errors.firstOrNull { it.code == code } ?: throw IllegalArgumentException("unknown AI error code: $code")
}
