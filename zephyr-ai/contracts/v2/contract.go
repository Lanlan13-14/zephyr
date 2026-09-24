// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.

package contractv2

const SchemaVersion = 2

type ProviderFamily string

const (
	ProviderFamilyOpenAI ProviderFamily = "openai"
	ProviderFamilyAnthropic ProviderFamily = "anthropic"
	ProviderFamilyOpenAICompatible ProviderFamily = "openai-compatible"
	ProviderFamilyCustom ProviderFamily = "custom"
)

func (v ProviderFamily) Valid() bool {
	switch v {
	case ProviderFamilyOpenAI, ProviderFamilyAnthropic, ProviderFamilyOpenAICompatible, ProviderFamilyCustom:
		return true
	default:
		return false
	}
}

type ProviderAPI string

const (
	ProviderAPIOpenAIResponses ProviderAPI = "openai-responses"
	ProviderAPIOpenAIChatCompletions ProviderAPI = "openai-chat-completions"
	ProviderAPIAnthropicMessages ProviderAPI = "anthropic-messages"
)

func (v ProviderAPI) Valid() bool {
	switch v {
	case ProviderAPIOpenAIResponses, ProviderAPIOpenAIChatCompletions, ProviderAPIAnthropicMessages:
		return true
	default:
		return false
	}
}

type AuthKind string

const (
	AuthKindAPIKey AuthKind = "api-key"
	AuthKindBearerToken AuthKind = "bearer-token"
	AuthKindDeviceEnvelope AuthKind = "device-envelope"
	AuthKindNone AuthKind = "none"
)

func (v AuthKind) Valid() bool {
	switch v {
	case AuthKindAPIKey, AuthKindBearerToken, AuthKindDeviceEnvelope, AuthKindNone:
		return true
	default:
		return false
	}
}

type SharingVisibility string

const (
	SharingVisibilityPrivate SharingVisibility = "private"
	SharingVisibilityShared SharingVisibility = "shared"
)

func (v SharingVisibility) Valid() bool {
	switch v {
	case SharingVisibilityPrivate, SharingVisibilityShared:
		return true
	default:
		return false
	}
}

type PromptCache string

const (
	PromptCacheUnsupported PromptCache = "unsupported"
	PromptCacheAuto PromptCache = "auto"
	PromptCacheExplicit PromptCache = "explicit"
)

func (v PromptCache) Valid() bool {
	switch v {
	case PromptCacheUnsupported, PromptCacheAuto, PromptCacheExplicit:
		return true
	default:
		return false
	}
}

type ReasoningLevel string

const (
	ReasoningLevelMinimal ReasoningLevel = "minimal"
	ReasoningLevelLow ReasoningLevel = "low"
	ReasoningLevelMedium ReasoningLevel = "medium"
	ReasoningLevelHigh ReasoningLevel = "high"
)

func (v ReasoningLevel) Valid() bool {
	switch v {
	case ReasoningLevelMinimal, ReasoningLevelLow, ReasoningLevelMedium, ReasoningLevelHigh:
		return true
	default:
		return false
	}
}

type PerformanceTier string

const (
	PerformanceTierFast PerformanceTier = "fast"
	PerformanceTierBalanced PerformanceTier = "balanced"
	PerformanceTierQuality PerformanceTier = "quality"
)

func (v PerformanceTier) Valid() bool {
	switch v {
	case PerformanceTierFast, PerformanceTierBalanced, PerformanceTierQuality:
		return true
	default:
		return false
	}
}

type ModelProvenance string

const (
	ModelProvenanceBuiltin ModelProvenance = "builtin"
	ModelProvenanceCatalogRemote ModelProvenance = "catalog-remote"
	ModelProvenanceUser ModelProvenance = "user"
)

func (v ModelProvenance) Valid() bool {
	switch v {
	case ModelProvenanceBuiltin, ModelProvenanceCatalogRemote, ModelProvenanceUser:
		return true
	default:
		return false
	}
}

type DNSMode string

const (
	DNSModeSystem DNSMode = "system"
	DNSModeHostResolved DNSMode = "host-resolved"
	DNSModeLiteral DNSMode = "literal"
)

func (v DNSMode) Valid() bool {
	switch v {
	case DNSModeSystem, DNSModeHostResolved, DNSModeLiteral:
		return true
	default:
		return false
	}
}

type TLSMinVersion string

const (
	TLSMinVersionV12 TLSMinVersion = "1.2"
	TLSMinVersionV13 TLSMinVersion = "1.3"
)

func (v TLSMinVersion) Valid() bool {
	switch v {
	case TLSMinVersionV12, TLSMinVersionV13:
		return true
	default:
		return false
	}
}

type IPFamily string

const (
	IPFamilyIPv4 IPFamily = "ipv4"
	IPFamilyIPv6 IPFamily = "ipv6"
)

func (v IPFamily) Valid() bool {
	switch v {
	case IPFamilyIPv4, IPFamilyIPv6:
		return true
	default:
		return false
	}
}

type ResolutionSource string

const (
	ResolutionSourceAndroidJVMDNS ResolutionSource = "android-jvm-dns"
	ResolutionSourceIOSSystemDNS ResolutionSource = "ios-system-dns"
	ResolutionSourceDesktopSystemDNS ResolutionSource = "desktop-system-dns"
	ResolutionSourceLiteral ResolutionSource = "literal"
)

func (v ResolutionSource) Valid() bool {
	switch v {
	case ResolutionSourceAndroidJVMDNS, ResolutionSourceIOSSystemDNS, ResolutionSourceDesktopSystemDNS, ResolutionSourceLiteral:
		return true
	default:
		return false
	}
}

type StopReason string

const (
	StopReasonStop StopReason = "stop"
	StopReasonLength StopReason = "length"
	StopReasonToolUse StopReason = "tool_use"
	StopReasonContentFilter StopReason = "content_filter"
	StopReasonCancelled StopReason = "cancelled"
	StopReasonError StopReason = "error"
)

func (v StopReason) Valid() bool {
	switch v {
	case StopReasonStop, StopReasonLength, StopReasonToolUse, StopReasonContentFilter, StopReasonCancelled, StopReasonError:
		return true
	default:
		return false
	}
}

type StreamEventType string

const (
	StreamEventTypeStart StreamEventType = "start"
	StreamEventTypeTextStart StreamEventType = "text_start"
	StreamEventTypeTextDelta StreamEventType = "text_delta"
	StreamEventTypeTextEnd StreamEventType = "text_end"
	StreamEventTypeReasoningStart StreamEventType = "reasoning_start"
	StreamEventTypeReasoningDelta StreamEventType = "reasoning_delta"
	StreamEventTypeReasoningEnd StreamEventType = "reasoning_end"
	StreamEventTypeToolCallStart StreamEventType = "tool_call_start"
	StreamEventTypeToolCallDelta StreamEventType = "tool_call_delta"
	StreamEventTypeToolCallEnd StreamEventType = "tool_call_end"
	StreamEventTypeUsage StreamEventType = "usage"
	StreamEventTypeDone StreamEventType = "done"
	StreamEventTypeError StreamEventType = "error"
)

func (v StreamEventType) Valid() bool {
	switch v {
	case StreamEventTypeStart, StreamEventTypeTextStart, StreamEventTypeTextDelta, StreamEventTypeTextEnd, StreamEventTypeReasoningStart, StreamEventTypeReasoningDelta, StreamEventTypeReasoningEnd, StreamEventTypeToolCallStart, StreamEventTypeToolCallDelta, StreamEventTypeToolCallEnd, StreamEventTypeUsage, StreamEventTypeDone, StreamEventTypeError:
		return true
	default:
		return false
	}
}

type TristateMode string

const (
	TristateModeInherit TristateMode = "inherit"
	TristateModeOmit TristateMode = "omit"
	TristateModeValue TristateMode = "value"
)

func (v TristateMode) Valid() bool {
	switch v {
	case TristateModeInherit, TristateModeOmit, TristateModeValue:
		return true
	default:
		return false
	}
}

type ExecutionFallback string

const (
	ExecutionFallbackAsk ExecutionFallback = "ask"
	ExecutionFallbackDeny ExecutionFallback = "deny"
	ExecutionFallbackAutomatic ExecutionFallback = "automatic"
)

func (v ExecutionFallback) Valid() bool {
	switch v {
	case ExecutionFallbackAsk, ExecutionFallbackDeny, ExecutionFallbackAutomatic:
		return true
	default:
		return false
	}
}

type CellScope string

const (
	CellScopeConversation CellScope = "conversation"
	CellScopeGroup CellScope = "group"
)

func (v CellScope) Valid() bool {
	switch v {
	case CellScopeConversation, CellScopeGroup:
		return true
	default:
		return false
	}
}

type RetentionPolicy string

const (
	RetentionPolicyRetain RetentionPolicy = "retain"
	RetentionPolicyPurgeOnDelete RetentionPolicy = "purge-on-delete"
)

func (v RetentionPolicy) Valid() bool {
	switch v {
	case RetentionPolicyRetain, RetentionPolicyPurgeOnDelete:
		return true
	default:
		return false
	}
}

type CellBindingStatus string

const (
	CellBindingStatusActive CellBindingStatus = "active"
	CellBindingStatusRetaining CellBindingStatus = "retaining"
	CellBindingStatusMigrating CellBindingStatus = "migrating"
	CellBindingStatusDestroyed CellBindingStatus = "destroyed"
)

func (v CellBindingStatus) Valid() bool {
	switch v {
	case CellBindingStatusActive, CellBindingStatusRetaining, CellBindingStatusMigrating, CellBindingStatusDestroyed:
		return true
	default:
		return false
	}
}

type AIEntityType string

const (
	AIEntityTypeAIConversation AIEntityType = "aiConversation"
	AIEntityTypeAIConversationBranch AIEntityType = "aiConversationBranch"
	AIEntityTypeAIMessage AIEntityType = "aiMessage"
	AIEntityTypeAIAttachmentManifest AIEntityType = "aiAttachmentManifest"
	AIEntityTypeAIToolRun AIEntityType = "aiToolRun"
	AIEntityTypeAIConversationGroup AIEntityType = "aiConversationGroup"
	AIEntityTypeAICellBinding AIEntityType = "aiCellBinding"
	AIEntityTypeAIProviderAccount AIEntityType = "aiProviderAccount"
	AIEntityTypeAISecretBinding AIEntityType = "aiSecretBinding"
	AIEntityTypeAIModelOverride AIEntityType = "aiModelOverride"
	AIEntityTypeAIBehaviorProfile AIEntityType = "aiBehaviorProfile"
	AIEntityTypeAICellProfile AIEntityType = "aiCellProfile"
	AIEntityTypeAIExecutionPolicy AIEntityType = "aiExecutionPolicy"
)

func (v AIEntityType) Valid() bool {
	switch v {
	case AIEntityTypeAIConversation, AIEntityTypeAIConversationBranch, AIEntityTypeAIMessage, AIEntityTypeAIAttachmentManifest, AIEntityTypeAIToolRun, AIEntityTypeAIConversationGroup, AIEntityTypeAICellBinding, AIEntityTypeAIProviderAccount, AIEntityTypeAISecretBinding, AIEntityTypeAIModelOverride, AIEntityTypeAIBehaviorProfile, AIEntityTypeAICellProfile, AIEntityTypeAIExecutionPolicy:
		return true
	default:
		return false
	}
}

type AIClientAction string

const (
	AIClientActionFixInput AIClientAction = "fix_input"
	AIClientActionReauthenticate AIClientAction = "reauthenticate"
	AIClientActionRetry AIClientAction = "retry"
	AIClientActionAbort AIClientAction = "abort"
	AIClientActionUpgrade AIClientAction = "upgrade"
)

func (v AIClientAction) Valid() bool {
	switch v {
	case AIClientActionFixInput, AIClientActionReauthenticate, AIClientActionRetry, AIClientActionAbort, AIClientActionUpgrade:
		return true
	default:
		return false
	}
}

type AIErrorSpec struct {
	Code string
	HTTPStatus int
	Retryable bool
	ClientAction AIClientAction
}

var AIErrorTaxonomy = []AIErrorSpec{
	{Code: "ai_invalid_request", HTTPStatus: 400, Retryable: false, ClientAction: "fix_input"},
	{Code: "ai_auth_failed", HTTPStatus: 401, Retryable: false, ClientAction: "reauthenticate"},
	{Code: "ai_forbidden", HTTPStatus: 403, Retryable: false, ClientAction: "abort"},
	{Code: "ai_dns_failed", HTTPStatus: 503, Retryable: true, ClientAction: "retry"},
	{Code: "ai_tls_hostname_mismatch", HTTPStatus: 502, Retryable: false, ClientAction: "abort"},
	{Code: "ai_rate_limited", HTTPStatus: 429, Retryable: true, ClientAction: "retry"},
	{Code: "ai_upstream_unavailable", HTTPStatus: 503, Retryable: true, ClientAction: "retry"},
	{Code: "ai_context_length_exceeded", HTTPStatus: 400, Retryable: false, ClientAction: "fix_input"},
	{Code: "ai_content_filtered", HTTPStatus: 400, Retryable: false, ClientAction: "abort"},
	{Code: "ai_tool_timeout", HTTPStatus: 504, Retryable: true, ClientAction: "retry"},
	{Code: "ai_cell_unavailable", HTTPStatus: 503, Retryable: true, ClientAction: "retry"},
	{Code: "ai_lease_rejected", HTTPStatus: 409, Retryable: false, ClientAction: "abort"},
	{Code: "ai_contract_version_unsupported", HTTPStatus: 400, Retryable: false, ClientAction: "upgrade"},
	{Code: "ai_sync_quarantined", HTTPStatus: 409, Retryable: false, ClientAction: "fix_input"},
	{Code: "ai_cancelled", HTTPStatus: 499, Retryable: false, ClientAction: "abort"},
}

func AIErrorByCode(code string) (AIErrorSpec, bool) {
	for _, item := range AIErrorTaxonomy {
		if item.Code == code {
			return item, true
		}
	}
	return AIErrorSpec{}, false
}
