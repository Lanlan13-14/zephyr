// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

import Foundation

/// One sync entity as frozen by contracts/registries/entity-registry.json.
public struct SyncEntitySpec: Sendable, Equatable {
    public let type: String
    public let source: String
    public let idField: String
    public let ownerField: String
    public let revisionField: String?
    public let deleteMode: String
    public let dependencyOrder: Int
    public let minimumClientVersion: Int
    public let editableFields: [String]
    public let secretFields: [String]
    public let serverAuthorityFields: [String]
    public let opaquePreserveFields: [String]
    public let deviceLocalFields: [String]
    public let capabilities: [String]
    public let status: String

    /// Fields One must never name in a fieldMask.
    public var forbiddenMaskFields: [String] {
        secretFields + serverAuthorityFields + opaquePreserveFields + deviceLocalFields
    }
}

public enum EntityRegistry {
    public static let version = 1
    public static let sourceCommit = "8dd5b98"

    public static let classification: [String] = ["editableSync", "opaquePreserve", "deviceLocal", "serverOnly"]
    public static let excludedEditableScopes: [String] = ["accountSecurity", "smtp", "captcha", "ipPolicy", "beian", "customCssJs", "multiUserAdmin"]

    public static let entities: [SyncEntitySpec] = [
        SyncEntitySpec(
            type: "connection",
            source: "ResourceService/storage.js connections",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 40,
            minimumClientVersion: 1,
            editableFields: ["name", "host", "port", "protocol", "username", "remark", "tags", "connectionMode", "proxyId", "jumpHostId", "jumpHostIds", "sshKeyId", "rdpSoundMode", "rdpClipboard", "rdpMicrophone", "rdpCamera", "rdpStorage", "rdpLocation", "rdpResolution", "rdpQuality", "rdpFps", "rdpTouchMode", "rdpTouchSensitivity", "rdpDomain", "encoding"],
            secretFields: ["password", "privateKey"],
            serverAuthorityFields: ["ownerUserId", "createdByUserId", "revision", "createdAt", "updatedAt", "lastConnectedAt", "visibility"],
            opaquePreserveFields: ["rdpPipeline"],
            deviceLocalFields: ["ephemeral"],
            capabilities: ["discover", "view", "use", "observe", "control", "execute", "fileRead", "fileWrite", "edit", "share", "delete", "revealSecret"],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "proxy",
            source: "ResourceService/storage.js proxies",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "host", "port", "type", "username"],
            secretFields: ["password"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt", "visibility"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete", "revealSecret"],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "sshKey",
            source: "ResourceService/storage.js ssh_keys",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "remark"],
            secretFields: ["privateKey", "passphrase"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt", "visibility"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete", "revealSecret"],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "jumpHost",
            source: "ResourceService/storage.js jump_hosts",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 20,
            minimumClientVersion: 1,
            editableFields: ["name", "connectionId"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt", "visibility"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete"],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "note",
            source: "NotesService/storage.js notes",
            idField: "noteId",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "soft-delete-then-tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["title", "content", "groupPath", "tags", "linkedConnectionIds", "sortOrder", "shareWithUsers", "shareWithAdmins", "allowAiRead", "allowAiWrite", "visibility"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt", "deletedAt"],
            opaquePreserveFields: ["allowAi"],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "snippet",
            source: "SnippetService/snippets",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["name", "command", "group", "autoRun"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiProvider",
            source: "AiProviderService/ai_providers",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "type", "baseUrl", "defaultModel", "models", "config", "visibility", "shareWithUsers", "shareWithAdmins", "sharedUserIds", "enabled"],
            secretFields: ["apiKey"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiMemory",
            source: "AiKnowledgeService/ai_knowledge_entities",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["title", "content", "scope", "project", "projects", "tags", "connectionIds"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiSkill",
            source: "AiKnowledgeService/ai_knowledge_entities",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["name", "description", "prompt", "enabled"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiEnv",
            source: "AiKnowledgeService/ai_knowledge_entities + ai_knowledge_env_secrets",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 20,
            minimumClientVersion: 1,
            editableFields: ["name", "enabled", "visibleToAi"],
            secretFields: ["value"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiConversation",
            source: "AiHistoryService/ai_conversations",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["title", "providerId", "model", "archived"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: ["runtimeMetadata"],
            deviceLocalFields: ["activeRunId"],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "aiMessage",
            source: "AiHistoryService/ai_messages",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 60,
            minimumClientVersion: 1,
            editableFields: ["conversationId", "role", "content", "attachments"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: ["toolEvents", "usage"],
            deviceLocalFields: ["streamState"],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "oneUserSettings",
            source: "PersonalSettingsSectionService + user_setting_sections/user_settings",
            idField: "sectionKey",
            ownerField: "userId",
            revisionField: "revision",
            deleteMode: "reset-to-default",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["appearance.theme", "appearance.autoThemeEnabled", "appearance.colorScheme", "appearance.customThemeMode", "appearance.customColors", "appearance.terminalBackground", "appearance.terminalFontColor", "appearance.terminalFontColors", "appearance.rdp", "terminal.maxWindows", "terminal.minimizedKeepAlive", "terminal.smartbarOrder", "terminal.shortcutPlatform", "terminal.allowLigatures", "notes.enabled", "notes.editorMode", "notes.fontSize", "workspace.defaultView", "workspace.sessionPersistence", "ai.panelLayout", "ai.assistantName"],
            secretFields: [],
            serverAuthorityFields: ["userId", "revision", "updatedAt"],
            opaquePreserveFields: ["appearance.customCss", "mail.notifyLogin"],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-reset-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "serverSettings",
            source: "CanonicalServerSettingsService/storage.js settings",
            idField: "sectionKey",
            ownerField: "serverId",
            revisionField: "revision",
            deleteMode: "reset-to-default",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["appearance", "notes", "ai.enabled", "ai.permissions", "ai.context", "ai.memory.enabled", "ai.memory.maxItems"],
            secretFields: [],
            serverAuthorityFields: ["serverId", "revision", "updatedAt", "requiredRole"],
            opaquePreserveFields: ["security", "mail", "captcha", "beian", "appearance.customCss", "appearance.customJs"],
            deviceLocalFields: [],
            capabilities: [],
            status: "blocked-owner-scope-change-feed-partition-mismatch"
        ),
        SyncEntitySpec(
            type: "backupMetadata",
            source: "/api/data/export + /api/data/import",
            idField: "backupId",
            ownerField: "serverId",
            revisionField: "revision",
            deleteMode: "job-retention",
            dependencyOrder: 70,
            minimumClientVersion: 1,
            editableFields: ["label", "retentionHint"],
            secretFields: [],
            serverAuthorityFields: ["serverId", "revision", "createdAt", "size", "sha256", "appVersion", "encryptionAlgorithm", "jobStatus"],
            opaquePreserveFields: [],
            deviceLocalFields: ["localDownloadUri"],
            capabilities: [],
            status: "blocked-no-durable-job-metadata-layer"
        ),
        SyncEntitySpec(
            type: "activityEvent",
            source: "CanonicalActivityEventService/storage.js activities",
            idField: "id",
            ownerField: "userId",
            revisionField: nil,
            deleteMode: "append-only",
            dependencyOrder: 80,
            minimumClientVersion: 1,
            editableFields: [],
            secretFields: [],
            serverAuthorityFields: ["id", "userId", "time", "message", "type", "sourceIp", "durationMs", "category", "outcome", "actor", "protocol", "target", "connectionId"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-read-only-canonical-service-append-only-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "resourceAcl",
            source: "ResourceAclMetadataService/resource_acl",
            idField: "grantKey",
            ownerField: "resourceOwnerUserId",
            revisionField: "revision",
            deleteMode: "revocation-tombstone",
            dependencyOrder: 30,
            minimumClientVersion: 1,
            editableFields: ["capabilities", "expiresAt"],
            secretFields: [],
            serverAuthorityFields: ["subjectType", "subjectId", "grantedByUserId", "createdAt", "revokedAt", "revision"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "observe", "control", "execute", "fileRead", "fileWrite", "edit", "share", "delete", "revealSecret", "administer"],
            status: "implemented-canonical-service-revision-revocation-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "clientToken",
            source: "AgentTokenStore/encrypted_client_tokens",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 0,
            minimumClientVersion: 1,
            editableFields: ["name"],
            secretFields: ["token"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt", "lastUsedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "workspaceState",
            source: "WorkspacePortableSyncService + workspaces/workspace_portable_identities",
            idField: "workspaceId",
            ownerField: "userId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 80,
            minimumClientVersion: 1,
            editableFields: ["name", "state"],
            secretFields: [],
            serverAuthorityFields: ["userId", "revision", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: ["clientId"],
            capabilities: [],
            status: "implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection"
        ),
        SyncEntitySpec(
            type: "fileSyncConfig",
            source: "FileSyncConfigService + mobile_devices/one_clients",
            idField: "clientId",
            ownerField: "ownerUserId",
            revisionField: "syncRevision",
            deleteMode: "revoke",
            dependencyOrder: 0,
            minimumClientVersion: 1,
            editableFields: ["deviceName", "enabled", "automaticEnabled", "syncIntervalSec"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "syncRevision", "tokenId", "platform", "appVersion", "lastSyncAt", "lastSeenAt", "createdAt", "revokedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: ["networkPolicy", "lastLocalAttemptAt", "localError"],
            capabilities: [],
            status: "implemented-canonical-service-revision-revoke-atomic-change-feed-secret-safe-projection"
        ),
    ]

    public static let byType: [String: SyncEntitySpec] = Dictionary(
        uniqueKeysWithValues: entities.map { ($0.type, $0) }
    )

    /// Push topology order: dependencies first, ties broken by type name.
    public static let pushOrder: [String] = ["clientToken", "fileSyncConfig", "aiProvider", "proxy", "sshKey", "aiEnv", "jumpHost", "resourceAcl", "connection", "aiConversation", "aiMemory", "aiSkill", "note", "oneUserSettings", "serverSettings", "snippet", "aiMessage", "backupMetadata", "activityEvent", "workspaceState"]

    public static func spec(for type: String) throws -> SyncEntitySpec {
        guard let spec = byType[type] else { throw ContractError.unknownEntityType(type) }
        return spec
    }

    public static func isEditableScope(_ scope: String) -> Bool {
        !excludedEditableScopes.contains(scope)
    }
}

public enum ContractError: Error, Equatable {
    case unknownEntityType(String)
    case forbiddenMaskField(entityType: String, field: String)
    case unknownMaskField(entityType: String, field: String)
}
