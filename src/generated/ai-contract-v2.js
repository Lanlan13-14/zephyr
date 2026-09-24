// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.

export const AI_CONTRACT_SCHEMA_VERSION = 2;

export const ProviderFamily = Object.freeze({
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  OPENAI_COMPATIBLE: "openai-compatible",
  CUSTOM: "custom",
});

export const ProviderAPI = Object.freeze({
  OPENAI_RESPONSES: "openai-responses",
  OPENAI_CHAT_COMPLETIONS: "openai-chat-completions",
  ANTHROPIC_MESSAGES: "anthropic-messages",
});

export const AuthKind = Object.freeze({
  API_KEY: "api-key",
  BEARER_TOKEN: "bearer-token",
  DEVICE_ENVELOPE: "device-envelope",
  NONE: "none",
});

export const SharingVisibility = Object.freeze({
  PRIVATE: "private",
  SHARED: "shared",
});

export const PromptCache = Object.freeze({
  UNSUPPORTED: "unsupported",
  AUTO: "auto",
  EXPLICIT: "explicit",
});

export const ReasoningLevel = Object.freeze({
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

export const PerformanceTier = Object.freeze({
  FAST: "fast",
  BALANCED: "balanced",
  QUALITY: "quality",
});

export const ModelProvenance = Object.freeze({
  BUILTIN: "builtin",
  CATALOG_REMOTE: "catalog-remote",
  USER: "user",
});

export const DNSMode = Object.freeze({
  SYSTEM: "system",
  HOST_RESOLVED: "host-resolved",
  LITERAL: "literal",
});

export const TLSMinVersion = Object.freeze({
  V1_2: "1.2",
  V1_3: "1.3",
});

export const IPFamily = Object.freeze({
  IPV4: "ipv4",
  IPV6: "ipv6",
});

export const ResolutionSource = Object.freeze({
  ANDROID_JVM_DNS: "android-jvm-dns",
  IOS_SYSTEM_DNS: "ios-system-dns",
  DESKTOP_SYSTEM_DNS: "desktop-system-dns",
  LITERAL: "literal",
});

export const StopReason = Object.freeze({
  STOP: "stop",
  LENGTH: "length",
  TOOL_USE: "tool_use",
  CONTENT_FILTER: "content_filter",
  CANCELLED: "cancelled",
  ERROR: "error",
});

export const StreamEventType = Object.freeze({
  START: "start",
  TEXT_START: "text_start",
  TEXT_DELTA: "text_delta",
  TEXT_END: "text_end",
  REASONING_START: "reasoning_start",
  REASONING_DELTA: "reasoning_delta",
  REASONING_END: "reasoning_end",
  TOOL_CALL_START: "tool_call_start",
  TOOL_CALL_DELTA: "tool_call_delta",
  TOOL_CALL_END: "tool_call_end",
  USAGE: "usage",
  DONE: "done",
  ERROR: "error",
});

export const TristateMode = Object.freeze({
  INHERIT: "inherit",
  OMIT: "omit",
  VALUE: "value",
});

export const ExecutionFallback = Object.freeze({
  ASK: "ask",
  DENY: "deny",
  AUTOMATIC: "automatic",
});

export const CellScope = Object.freeze({
  CONVERSATION: "conversation",
  GROUP: "group",
});

export const RetentionPolicy = Object.freeze({
  RETAIN: "retain",
  PURGE_ON_DELETE: "purge-on-delete",
});

export const CellBindingStatus = Object.freeze({
  ACTIVE: "active",
  RETAINING: "retaining",
  MIGRATING: "migrating",
  DESTROYED: "destroyed",
});

export const AIEntityType = Object.freeze({
  AICONVERSATION: "aiConversation",
  AICONVERSATIONBRANCH: "aiConversationBranch",
  AIMESSAGE: "aiMessage",
  AIATTACHMENTMANIFEST: "aiAttachmentManifest",
  AITOOLRUN: "aiToolRun",
  AICONVERSATIONGROUP: "aiConversationGroup",
  AICELLBINDING: "aiCellBinding",
  AIPROVIDERACCOUNT: "aiProviderAccount",
  AISECRETBINDING: "aiSecretBinding",
  AIMODELOVERRIDE: "aiModelOverride",
  AIBEHAVIORPROFILE: "aiBehaviorProfile",
  AICELLPROFILE: "aiCellProfile",
  AIEXECUTIONPOLICY: "aiExecutionPolicy",
});

export const AIClientAction = Object.freeze({
  FIX_INPUT: "fix_input",
  REAUTHENTICATE: "reauthenticate",
  RETRY: "retry",
  ABORT: "abort",
  UPGRADE: "upgrade",
});

export const AI_ERROR_TAXONOMY = Object.freeze({
  "version": 2,
  "errors": [
    {
      "code": "ai_invalid_request",
      "httpStatus": 400,
      "retryable": false,
      "clientAction": "fix_input"
    },
    {
      "code": "ai_auth_failed",
      "httpStatus": 401,
      "retryable": false,
      "clientAction": "reauthenticate"
    },
    {
      "code": "ai_forbidden",
      "httpStatus": 403,
      "retryable": false,
      "clientAction": "abort"
    },
    {
      "code": "ai_dns_failed",
      "httpStatus": 503,
      "retryable": true,
      "clientAction": "retry"
    },
    {
      "code": "ai_tls_hostname_mismatch",
      "httpStatus": 502,
      "retryable": false,
      "clientAction": "abort"
    },
    {
      "code": "ai_rate_limited",
      "httpStatus": 429,
      "retryable": true,
      "clientAction": "retry"
    },
    {
      "code": "ai_upstream_unavailable",
      "httpStatus": 503,
      "retryable": true,
      "clientAction": "retry"
    },
    {
      "code": "ai_context_length_exceeded",
      "httpStatus": 400,
      "retryable": false,
      "clientAction": "fix_input"
    },
    {
      "code": "ai_content_filtered",
      "httpStatus": 400,
      "retryable": false,
      "clientAction": "abort"
    },
    {
      "code": "ai_tool_timeout",
      "httpStatus": 504,
      "retryable": true,
      "clientAction": "retry"
    },
    {
      "code": "ai_cell_unavailable",
      "httpStatus": 503,
      "retryable": true,
      "clientAction": "retry"
    },
    {
      "code": "ai_lease_rejected",
      "httpStatus": 409,
      "retryable": false,
      "clientAction": "abort"
    },
    {
      "code": "ai_contract_version_unsupported",
      "httpStatus": 400,
      "retryable": false,
      "clientAction": "upgrade"
    },
    {
      "code": "ai_sync_quarantined",
      "httpStatus": 409,
      "retryable": false,
      "clientAction": "fix_input"
    },
    {
      "code": "ai_cancelled",
      "httpStatus": 499,
      "retryable": false,
      "clientAction": "abort"
    }
  ]
});

const byCode = new Map(AI_ERROR_TAXONOMY.errors.map((item) => [item.code, item]));

export function aiErrorSpec(code) {
  const spec = byCode.get(code);
  if (!spec) throw new Error("unknown AI error code: " + code);
  return spec;
}

export function isRetryableAIError(code) {
  return aiErrorSpec(code).retryable;
}

function assertEnum(kind, value, allowed) {
  if (!allowed.includes(value)) throw new Error(kind + " has unsupported value: " + value);
}

export function assertProviderAccountEnums(account) {
  assertEnum("family", account.family, Object.values(ProviderFamily));
  assertEnum("api", account.api, Object.values(ProviderAPI));
  assertEnum("auth.kind", account.auth && account.auth.kind, Object.values(AuthKind));
  if (account.sharing) assertEnum("sharing.visibility", account.sharing.visibility, Object.values(SharingVisibility));
}
