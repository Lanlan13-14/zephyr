import Foundation
import ZephyrContracts

/// An in-memory summary of a shared-to-me resource. The residency rule is
/// structural: this type has no persistence path anywhere, so shared data
/// cannot reach the mirror, SecretStore, preferences, files, logs or backups
/// (SHARED_RESOURCE_RESIDENCY.md 3).
public struct SharedResourceSummary: Equatable, Sendable {
    public var resourceType: String
    public var resourceId: String
    public var displayName: String
    public var ownerLabel: String
    public var capabilities: CapabilitySet
    public var usePolicy: SharedUsePolicy
    public var grantExpiresAt: Int64?
    public var `protocol`: String?

    public init(
        resourceType: String,
        resourceId: String,
        displayName: String,
        ownerLabel: String,
        capabilities: CapabilitySet,
        usePolicy: SharedUsePolicy,
        grantExpiresAt: Int64? = nil,
        protocol: String? = nil
    ) {
        self.resourceType = resourceType
        self.resourceId = resourceId
        self.displayName = displayName
        self.ownerLabel = ownerLabel
        self.capabilities = capabilities
        self.usePolicy = usePolicy
        self.grantExpiresAt = grantExpiresAt
        self.`protocol` = `protocol`
    }

    public var residency: Residency { .sharedOnlineOnly }
}

/// Shared-to-me rows for the S10 list.
///
/// Shared resources have no mirror row, so they arrive as an in-memory summary
/// and are projected onto ``Connection`` purely so one list can render both
/// origins with one card. The projection deliberately leaves ``Connection/host``
/// empty: SHARED_RESOURCE_RESIDENCY.md 2 forbids storing the endpoint of a
/// shared resource on this device, and the card shows the owner disclosure line
/// instead of an endpoint. A screen that rendered host:port for a shared row
/// would be displaying data One is not allowed to have.
public enum SharedConnectionRows {

    public static func isConnection(_ summary: SharedResourceSummary) -> Bool {
        summary.resourceType == Connection.entityType
    }

    public static func toDisplayRow(_ summary: SharedResourceSummary, ownerUserId: String) -> Connection {
        let connectionProtocol = ConnectionProtocol.fromWire(summary.`protocol`) ?? .ssh
        return Connection(
            id: summary.resourceId,
            // The bound account is not the owner; the owner label is carried
            // separately because the owner's user id is not something One is
            // told.
            ownerUserId: ownerUserId,
            protocol: connectionProtocol,
            name: summary.displayName,
            host: "",
            port: connectionProtocol.defaultPort,
            residency: .sharedOnlineOnly,
            capabilities: summary.capabilities,
            sharedOwnerLabel: summary.ownerLabel,
            sharedUsePolicy: summary.usePolicy,
            grantExpiresAt: summary.grantExpiresAt
        )
    }

    public static func rowsFrom(_ summaries: [SharedResourceSummary], ownerUserId: String) -> [Connection] {
        summaries.filter(isConnection).map { toDisplayRow($0, ownerUserId: ownerUserId) }
    }
}

/// The shared-to-me list state, as a pure function.
///
/// Split out from ``ConnectionListStates`` because the two lists disagree on
/// the one question that matters most here: what offline means. Owned rows have
/// a local mirror, so offline shows the cache with its age. Shared rows have no
/// mirror at all, so offline is terminal -- there is nothing to fall back on,
/// and rendering a remembered list would be displaying data this device is not
/// allowed to keep (SHARED_RESOURCE_RESIDENCY.md 2-3).
///
/// That is why this returns ``PageState/offlineNoCache`` rather than
/// ``PageState/offlineWithCache(value:lastSyncedAt:)``, and why there is no
/// `lastSyncedAt` parameter: an age would imply a cache exists.
public enum SharedResourceListStates {

    public static func derive(
        resources: [SharedResourceSummary],
        query: String = "",
        loaded: Bool = true,
        online: Bool = true,
        error: MobileError? = nil
    ) -> PageState<[SharedResourceSummary]> {
        /* Offline first, ahead of both the error and the loaded checks.
         *
         * A failed fetch while offline is not a server error and must not be
         * reported as one: the cause is known, and "check your connection" is
         * actionable where a request id is not. */
        if !online { return .offlineNoCache }

        if let error {
            /* A vanished grant is terminal. Offering retry would invite the
             * user to hammer an endpoint that will keep answering 404
             * (SHARED_RESOURCE_RESIDENCY.md 3.4). */
            if error.dismissesSharedResource { return .notFoundOrRevoked }
            if error.retryable || error.isRegistryRetryable {
                return .retryableError(error)
            }
            /* Non-retryable and not a revocation: a protocol or contract
             * mismatch. Retry cannot fix it, so the screen must offer an
             * upgrade path instead. */
            return .fatalIncompatible(error)
        }

        if !loaded { return .initialLoading }

        let visible = filter(resources, query: query)
        if !visible.isEmpty {
            /* No pendingSync or conflict flags, ever. Both describe a local
             * write queue, and a shared resource has none: every write goes
             * straight to the owner's main end through invoke, so there is
             * nothing local that could be pending or conflicted. */
            return .content(visible)
        }

        /* An empty result with a non-empty list is a search outcome, not an
         * empty share set. The difference decides whether the screen offers
         * "clear search" or explains that nobody has shared anything. */
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        return .empty(!trimmed.isEmpty && !resources.isEmpty ? .noMatchingFilter : .noData)
    }

    /// Local filtering over the in-memory list.
    ///
    /// Deliberately not a server query: a search term typed against shared
    /// resources would put the owner's resource names into request logs on the
    /// main end. Matching in memory keeps the term on this device, and the list
    /// is bounded by what one owner shared.
    public static func filter(_ resources: [SharedResourceSummary], query: String) -> [SharedResourceSummary] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        if needle.isEmpty { return resources }
        return resources.filter { item in
            item.displayName.range(of: needle, options: .caseInsensitive) != nil ||
                item.ownerLabel.range(of: needle, options: .caseInsensitive) != nil
        }
    }
}

/// What a shared row is allowed to offer.
///
/// Client-side gating is presentation only -- the server recomputes every
/// capability on every call (ZEPHYR_PARITY.md 4.2) -- but presenting an action
/// the grant does not carry is its own bug: the user taps it, the server
/// refuses, and the refusal reads as a fault rather than as a boundary.
public enum SharedResourceActions {

    /// True when the row can be opened at all.
    ///
    /// VIEW alone is not enough to open a session: it permits seeing that the
    /// resource exists.
    public static func canOpenSession(_ summary: SharedResourceSummary) -> Bool {
        summary.capabilities.contains(.use) || summary.capabilities.contains(.observe)
    }

    /// Notes are read through invoke; the body never arrives in a list
    /// response.
    public static func canReadContent(_ summary: SharedResourceSummary) -> Bool {
        summary.capabilities.contains(.view)
    }

    /// True only with an explicit EDIT grant.
    ///
    /// Never implied by sharing: ``CapabilitySet/implicitShare`` carries
    /// discover/view/use/observe and nothing else, so a shared note is
    /// read-only unless the owner granted edit deliberately.
    public static func canEditContent(_ summary: SharedResourceSummary) -> Bool {
        summary.capabilities.contains(.edit)
    }

    /// Whether opening this resource puts the owner's connection material into
    /// this device's memory.
    ///
    /// Surfaced so the screen can say which of the two happened. A relay
    /// session keeps the credential on the main end; a direct session decrypts
    /// it here. Both are legitimate, and MOBILE_EXPERIENCE.md forbids implying
    /// the stronger guarantee when the weaker one applies.
    public static func materialTouchesDevice(_ summary: SharedResourceSummary) -> Bool {
        summary.usePolicy.materialTouchesDevice
    }

    /// Whether the grant is still inside its window.
    ///
    /// A nil expiry means the owner set no deadline, not that the grant
    /// expired. Reading it the other way would make every open-ended share
    /// look dead.
    public static func isWithinGrantWindow(_ summary: SharedResourceSummary, nowMs: Int64) -> Bool {
        guard let expiresAt = summary.grantExpiresAt else { return true }
        return expiresAt > nowMs
    }
}
