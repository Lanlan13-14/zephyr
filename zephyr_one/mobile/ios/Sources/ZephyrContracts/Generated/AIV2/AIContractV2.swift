// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.

import Foundation

public enum AIContractV2 {
    public static let schemaVersion = 2
}

public enum ProviderFamily: String, Sendable, CaseIterable, Codable {
    case openai = "openai"
    case anthropic = "anthropic"
    case google = "google"
    case deepseek = "deepseek"
    case ollama = "ollama"
    case custom = "custom"
}

public enum ProviderAPI: String, Sendable, CaseIterable, Codable {
    case openaiResponses = "openai-responses"
    case openaiChatCompletions = "openai-chat-completions"
    case anthropicMessages = "anthropic-messages"
    case googleGenerativeAi = "google-generative-ai"
    case ollamaOpenai = "ollama-openai"
}

public enum AuthKind: String, Sendable, CaseIterable, Codable {
    case apiKey = "api-key"
    case bearerToken = "bearer-token"
    case deviceEnvelope = "device-envelope"
    case none = "none"
}

public enum SharingVisibility: String, Sendable, CaseIterable, Codable {
    case `private` = "private"
    case shared = "shared"
}

public enum PromptCache: String, Sendable, CaseIterable, Codable {
    case unsupported = "unsupported"
    case auto = "auto"
    case explicit = "explicit"
}

public enum ReasoningLevel: String, Sendable, CaseIterable, Codable {
    case minimal = "minimal"
    case low = "low"
    case medium = "medium"
    case high = "high"
}

public enum PerformanceTier: String, Sendable, CaseIterable, Codable {
    case fast = "fast"
    case balanced = "balanced"
    case quality = "quality"
}

public enum ModelProvenance: String, Sendable, CaseIterable, Codable {
    case builtin = "builtin"
    case catalogRemote = "catalog-remote"
    case user = "user"
}

public enum DNSMode: String, Sendable, CaseIterable, Codable {
    case system = "system"
    case hostResolved = "host-resolved"
    case literal = "literal"
}

public enum TLSMinVersion: String, Sendable, CaseIterable, Codable {
    case v12 = "1.2"
    case v13 = "1.3"
}

public enum IPFamily: String, Sendable, CaseIterable, Codable {
    case ipv4 = "ipv4"
    case ipv6 = "ipv6"
}

public enum ResolutionSource: String, Sendable, CaseIterable, Codable {
    case androidJvmDns = "android-jvm-dns"
    case iosSystemDns = "ios-system-dns"
    case desktopSystemDns = "desktop-system-dns"
    case literal = "literal"
}

public enum StopReason: String, Sendable, CaseIterable, Codable {
    case stop = "stop"
    case length = "length"
    case toolUse = "tool_use"
    case contentFilter = "content_filter"
    case cancelled = "cancelled"
    case error = "error"
}

public enum StreamEventType: String, Sendable, CaseIterable, Codable {
    case start = "start"
    case textStart = "text_start"
    case textDelta = "text_delta"
    case textEnd = "text_end"
    case reasoningStart = "reasoning_start"
    case reasoningDelta = "reasoning_delta"
    case reasoningEnd = "reasoning_end"
    case toolCallStart = "tool_call_start"
    case toolCallDelta = "tool_call_delta"
    case toolCallEnd = "tool_call_end"
    case usage = "usage"
    case done = "done"
    case error = "error"
}

public enum TristateMode: String, Sendable, CaseIterable, Codable {
    case inherit = "inherit"
    case omit = "omit"
    case value = "value"
}

public enum ExecutionFallback: String, Sendable, CaseIterable, Codable {
    case ask = "ask"
    case deny = "deny"
    case automatic = "automatic"
}

public enum CellScope: String, Sendable, CaseIterable, Codable {
    case conversation = "conversation"
    case group = "group"
}

public enum RetentionPolicy: String, Sendable, CaseIterable, Codable {
    case retain = "retain"
    case purgeOnDelete = "purge-on-delete"
}

public enum CellBindingStatus: String, Sendable, CaseIterable, Codable {
    case active = "active"
    case retaining = "retaining"
    case migrating = "migrating"
    case destroyed = "destroyed"
}

public enum AIEntityType: String, Sendable, CaseIterable, Codable {
    case aiConversation = "aiConversation"
    case aiConversationBranch = "aiConversationBranch"
    case aiMessage = "aiMessage"
    case aiAttachmentManifest = "aiAttachmentManifest"
    case aiToolRun = "aiToolRun"
    case aiConversationGroup = "aiConversationGroup"
    case aiCellBinding = "aiCellBinding"
    case aiProviderAccount = "aiProviderAccount"
    case aiSecretBinding = "aiSecretBinding"
    case aiModelOverride = "aiModelOverride"
    case aiBehaviorProfile = "aiBehaviorProfile"
    case aiCellProfile = "aiCellProfile"
    case aiExecutionPolicy = "aiExecutionPolicy"
}

public enum AIClientAction: String, Sendable, CaseIterable, Codable {
    case fixInput = "fix_input"
    case reauthenticate = "reauthenticate"
    case retry = "retry"
    case abort = "abort"
    case upgrade = "upgrade"
}

public struct AIErrorSpec: Sendable, Equatable, Codable {
    public let code: String
    public let httpStatus: Int
    public let retryable: Bool
    public let clientAction: AIClientAction

    public init(_ code: String, _ httpStatus: Int, _ retryable: Bool, _ clientAction: AIClientAction) {
        self.code = code
        self.httpStatus = httpStatus
        self.retryable = retryable
        self.clientAction = clientAction
    }
}

public enum AIErrorTaxonomy {
    public static let version = 2
    public static let errors: [AIErrorSpec] = [
        AIErrorSpec("ai_invalid_request", 400, false, .fixInput),
        AIErrorSpec("ai_auth_failed", 401, false, .reauthenticate),
        AIErrorSpec("ai_forbidden", 403, false, .abort),
        AIErrorSpec("ai_dns_failed", 503, true, .retry),
        AIErrorSpec("ai_tls_hostname_mismatch", 502, false, .abort),
        AIErrorSpec("ai_rate_limited", 429, true, .retry),
        AIErrorSpec("ai_upstream_unavailable", 503, true, .retry),
        AIErrorSpec("ai_context_length_exceeded", 400, false, .fixInput),
        AIErrorSpec("ai_content_filtered", 400, false, .abort),
        AIErrorSpec("ai_tool_timeout", 504, true, .retry),
        AIErrorSpec("ai_cell_unavailable", 503, true, .retry),
        AIErrorSpec("ai_lease_rejected", 409, false, .abort),
        AIErrorSpec("ai_contract_version_unsupported", 400, false, .upgrade),
        AIErrorSpec("ai_sync_quarantined", 409, false, .fixInput),
        AIErrorSpec("ai_cancelled", 499, false, .abort),
    ]

    public static func byCode(_ code: String) -> AIErrorSpec? {
        errors.first { $0.code == code }
    }
}
