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
            source: "storage.js connections + resource-service.js",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 40,
            minimumClientVersion: 1,
            editableFields: ["name", "host", "port", "protocol", "username", "remark", "tags", "connectionMode", "proxyId", "jumpHostId", "jumpHostIds", "sshKeyId", "rdpSoundMode", "rdpClipboard", "rdpMicrophone", "rdpCamera", "rdpStorage", "rdpLocation", "rdpResolution", "rdpQuality", "rdpFps", "rdpTouchMode", "rdpTouchSensitivity", "rdpDomain", "encoding", "visibility"],
            secretFields: ["password", "privateKey"],
            serverAuthorityFields: ["ownerUserId", "createdByUserId", "revision", "createdAt", "updatedAt", "lastConnectedAt"],
            opaquePreserveFields: ["rdpPipeline"],
            deviceLocalFields: ["ephemeral"],
            capabilities: ["discover", "view", "use", "observe", "control", "execute", "fileRead", "fileWrite", "edit", "share", "delete", "revealSecret"],
            status: "source-ready-needs-tombstone-hook"
        ),
        SyncEntitySpec(
            type: "proxy",
            source: "storage.js proxies + resource-service.js",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "host", "port", "type", "username", "visibility"],
            secretFields: ["password"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete", "revealSecret"],
            status: "source-ready-needs-tombstone-hook"
        ),
        SyncEntitySpec(
            type: "sshKey",
            source: "storage.js ssh_keys + resource-service.js",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "remark", "visibility"],
            secretFields: ["privateKey", "passphrase"],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete", "revealSecret"],
            status: "source-ready-needs-tombstone-hook"
        ),
        SyncEntitySpec(
            type: "jumpHost",
            source: "storage.js jump_hosts + resource-service.js",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 20,
            minimumClientVersion: 1,
            editableFields: ["name", "connectionId", "visibility"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "edit", "share", "delete"],
            status: "source-ready-needs-tombstone-hook"
        ),
        SyncEntitySpec(
            type: "note",
            source: "storage.js notes + notes-service.js",
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
            status: "source-ready-soft-delete-exists"
        ),
        SyncEntitySpec(
            type: "snippet",
            source: "user_settings.snippets + ai-snippet-tools.js",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["name", "command", "group", "autoRun"],
            secretFields: [],
            serverAuthorityFields: ["revision", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "requires-normalization-out-of-settings-bag"
        ),
        SyncEntitySpec(
            type: "aiProvider",
            source: "ai-provider-service.js ai_providers",
            idField: "id",
            ownerField: "ownerUserId",
            revisionField: "revision",
            deleteMode: "tombstone",
            dependencyOrder: 10,
            minimumClientVersion: 1,
            editableFields: ["name", "type", "baseUrl", "defaultModel", "models", "config", "visibility", "shareWithUsers", "shareWithAdmins", "sharedUserIds", "enabled"],
            secretFields: ["apiKey"],
            serverAuthorityFields: ["ownerUserId", "createdAt", "updatedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: [],
            status: "requires-revision-and-change-hook"
        ),
        SyncEntitySpec(
            type: "aiMemory",
            source: "settings.ai.memories",
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
            status: "requires-normalization-out-of-global-settings"
        ),
        SyncEntitySpec(
            type: "aiSkill",
            source: "settings.ai.skills",
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
            status: "requires-normalization-out-of-global-settings"
        ),
        SyncEntitySpec(
            type: "aiEnv",
            source: "settings.ai.envVars",
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
            status: "requires-normalization-out-of-global-settings"
        ),
        SyncEntitySpec(
            type: "aiConversation",
            source: "AI runtime session service",
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
            status: "blocked-no-canonical-server-schema"
        ),
        SyncEntitySpec(
            type: "aiMessage",
            source: "AI runtime session service",
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
            status: "blocked-no-canonical-server-schema"
        ),
        SyncEntitySpec(
            type: "oneUserSettings",
            source: "user-settings-service.js user_settings",
            idField: "sectionKey",
            ownerField: "userId",
            revisionField: "revision",
            deleteMode: "reset-to-default",
            dependencyOrder: 50,
            minimumClientVersion: 1,
            editableFields: ["appearance.theme", "appearance.autoThemeEnabled", "appearance.colorScheme", "appearance.customThemeMode", "appearance.customColors", "appearance.terminalBackground", "appearance.terminalFontColor", "appearance.terminalFontColors", "appearance.rdp", "terminal.maxWindows", "terminal.minimizedKeepAlive", "terminal.smartbarOrder", "terminal.shortcutPlatform", "terminal.allowLigatures", "notes.enabled", "notes.editorMode", "notes.fontSize", "workspace.defaultView", "workspace.sessionPersistence", "ai.panelLayout", "ai.assistantName"],
            secretFields: [],
            serverAuthorityFields: ["userId", "updatedAt"],
            opaquePreserveFields: ["appearance.customCss", "mail.notifyLogin"],
            deviceLocalFields: [],
            capabilities: [],
            status: "requires-per-key-revision"
        ),
        SyncEntitySpec(
            type: "serverSettings",
            source: "storage.js settings + /api/settings sections",
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
            status: "role-gated-adapter-required-ai-provider-memory-skill-env-are-separate-entities"
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
            status: "requires-job-and-metadata-layer"
        ),
        SyncEntitySpec(
            type: "activityEvent",
            source: "storage.js activities",
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
            status: "source-ready-add-change-hook"
        ),
        SyncEntitySpec(
            type: "resourceAcl",
            source: "authz.js resource_acl",
            idField: "grantKey",
            ownerField: "resourceOwnerUserId",
            revisionField: "revision",
            deleteMode: "revocation-tombstone",
            dependencyOrder: 30,
            minimumClientVersion: 1,
            editableFields: ["subjectType", "subjectId", "capabilities", "expiresAt"],
            secretFields: [],
            serverAuthorityFields: ["grantedByUserId", "createdAt", "revokedAt", "revision"],
            opaquePreserveFields: [],
            deviceLocalFields: [],
            capabilities: ["discover", "view", "use", "observe", "control", "execute", "fileRead", "fileWrite", "edit", "share", "delete", "revealSecret", "administer"],
            status: "source-ready-add-revision-and-change-hook"
        ),
        SyncEntitySpec(
            type: "clientToken",
            source: "file-agent-manager.js agent-tokens.json v2",
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
            status: "blocked-migrate-plaintext-json-to-encrypted-sqlite"
        ),
        SyncEntitySpec(
            type: "workspaceState",
            source: "workspace-service.js workspaces",
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
            status: "source-ready-mobile-state-adapter-required"
        ),
        SyncEntitySpec(
            type: "fileSyncConfig",
            source: "one-client-manager.js one_clients",
            idField: "clientId",
            ownerField: "ownerUserId",
            revisionField: "syncRevision",
            deleteMode: "revoke",
            dependencyOrder: 0,
            minimumClientVersion: 1,
            editableFields: ["deviceName", "enabled", "automaticEnabled", "syncIntervalSec", "networkPolicy"],
            secretFields: [],
            serverAuthorityFields: ["ownerUserId", "tokenId", "platform", "appVersion", "lastSyncAt", "lastSeenAt", "createdAt", "revokedAt"],
            opaquePreserveFields: [],
            deviceLocalFields: ["lastLocalAttemptAt", "localError"],
            capabilities: [],
            status: "source-partial-needs-automatic-flag-and-v1-credentials"
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
