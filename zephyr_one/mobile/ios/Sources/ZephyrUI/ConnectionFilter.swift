import Foundation

/// Ownership facet for the S10 list.
///
/// SCREEN_CATALOG.md 5 lists ownership as a first-class filter, and
/// SHARED_RESOURCE_RESIDENCY.md makes the two sides behave differently
/// offline, so the distinction has to survive into the state rather than being
/// a cosmetic badge.
public enum OwnershipFacet: String, Sendable, CaseIterable {
    case all
    case owned
    case shared
}

/// The S10 filter set.
///
/// Kept as a value type with no SwiftUI dependency so the whole filter matrix
/// is unit testable: the list screen's correctness is mostly
/// ``ConnectionFilters/apply(_:filter:favouriteIds:)``, not the view.
public struct ConnectionFilter: Equatable, Sendable {
    public var query: String
    public var protocols: Set<ConnectionProtocol>
    public var tags: Set<String>
    public var ownership: OwnershipFacet
    public var favouritesOnly: Bool

    public init(
        query: String = "",
        protocols: Set<ConnectionProtocol> = [],
        tags: Set<String> = [],
        ownership: OwnershipFacet = .all,
        favouritesOnly: Bool = false
    ) {
        self.query = query
        self.protocols = protocols
        self.tags = tags
        self.ownership = ownership
        self.favouritesOnly = favouritesOnly
    }

    public var isActive: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty ||
            !protocols.isEmpty ||
            !tags.isEmpty ||
            ownership != .all ||
            favouritesOnly
    }

    public func withProtocolToggled(_ value: ConnectionProtocol) -> ConnectionFilter {
        var copy = self
        if copy.protocols.contains(value) {
            copy.protocols.remove(value)
        } else {
            copy.protocols.insert(value)
        }
        return copy
    }

    public func withTagToggled(_ tag: String) -> ConnectionFilter {
        var copy = self
        if copy.tags.contains(tag) {
            copy.tags.remove(tag)
        } else {
            copy.tags.insert(tag)
        }
        return copy
    }

    /// Keeps the query: clearing facets while wiping what the user typed reads
    /// as a bug.
    public func cleared() -> ConnectionFilter {
        ConnectionFilter(query: query)
    }
}

/// Pure filtering and ordering for the connection library.
///
/// Deliberately not a database query: the list combines the owned mirror with
/// shared-to-me rows that exist only in memory (SHARED_RESOURCE_RESIDENCY.md
/// 2), and a SQL WHERE clause could not see the latter. Doing it in Swift keeps
/// one ordering rule for both origins.
public enum ConnectionFilters {

    /// Multi-field match.
    ///
    /// Remark and tags are included because ZEPHYR_PARITY.md treats them as
    /// user-visible identity, but the username is not: matching it would
    /// surface accounts while the user types a hostname.
    public static func matchesQuery(_ connection: Connection, rawQuery: String) -> Bool {
        let query = rawQuery.trimmingCharacters(in: .whitespaces)
        if query.isEmpty { return true }
        let needle = query.lowercased()
        if connection.name.lowercased().contains(needle) { return true }
        if connection.host.lowercased().contains(needle) { return true }
        if connection.remark.lowercased().contains(needle) { return true }
        if connection.tags.contains(where: { $0.lowercased().contains(needle) }) { return true }
        // "host:port" is how the card renders the endpoint, so it must also be
        // searchable.
        return connection.displayAddress.lowercased().contains(needle)
    }

    public static func matches(
        _ connection: Connection,
        filter: ConnectionFilter,
        favouriteIds: Set<String>
    ) -> Bool {
        if !filter.protocols.isEmpty && !filter.protocols.contains(connection.`protocol`) {
            return false
        }
        // Tag facets are OR within the facet: selecting two tags widens the
        // result, matching how the chips read to the user.
        if !filter.tags.isEmpty && !filter.tags.contains(where: { connection.tags.contains($0) }) {
            return false
        }
        let ownershipOk: Bool
        switch filter.ownership {
        case .all:
            ownershipOk = true
        case .owned:
            ownershipOk = connection.residency == .owned
        case .shared:
            ownershipOk = connection.residency == .sharedOnlineOnly
        }
        if !ownershipOk { return false }
        if filter.favouritesOnly && !favouriteIds.contains(connection.id) { return false }
        return matchesQuery(connection, rawQuery: filter.query)
    }

    /// Deleted rows are dropped here rather than at the query.
    ///
    /// A tombstoned row still exists in the mirror until retention prunes it,
    /// and it may still be the subject of a pending restore, so the repository
    /// keeps it while the list hides it.
    public static func apply(
        _ connections: [Connection],
        filter: ConnectionFilter,
        favouriteIds: Set<String> = []
    ) -> [Connection] {
        connections
            .filter { !$0.isDeleted }
            .filter { matches($0, filter: filter, favouriteIds: favouriteIds) }
            .sorted { lhs, rhs in
                /* Ordering: favourites, then name. Name uses a case-insensitive
                 * comparison so an upper-case entry does not sort into a
                 * separate block from its lower-case neighbours. */
                let lhsFavourite = favouriteIds.contains(lhs.id)
                let rhsFavourite = favouriteIds.contains(rhs.id)
                if lhsFavourite != rhsFavourite { return lhsFavourite }
                let byName = lhs.name.caseInsensitiveCompare(rhs.name)
                if byName != .orderedSame { return byName == .orderedAscending }
                return lhs.id < rhs.id
            }
    }

    /// Recents strip.
    ///
    /// Never-connected rows are excluded rather than sorted last: "recent" with
    /// an entry that was never used would be a lie, and the empty strip is a
    /// legitimate state.
    public static func recents(_ connections: [Connection], limit: Int = maxRecents) -> [Connection] {
        Array(
            connections
                .filter { !$0.isDeleted && $0.lastConnectedAt != nil }
                .sorted { ($0.lastConnectedAt ?? 0) > ($1.lastConnectedAt ?? 0) }
                .prefix(limit)
        )
    }

    /// Tag facet values, sorted, from whatever is actually present.
    public static func availableTags(_ connections: [Connection]) -> [String] {
        var seen: Set<String> = []
        var tags: [String] = []
        for connection in connections where !connection.isDeleted {
            for tag in connection.tags where seen.insert(tag).inserted {
                tags.append(tag)
            }
        }
        return tags.sorted { $0.caseInsensitiveCompare($1) == .orderedAscending }
    }

    public static let maxRecents = 8
}

/// Device-local favourites.
///
/// A favourite is a per-device preference, not account data: the frozen entity
/// registry has no favourite field on connection, so pushing one would be
/// inventing a contract. Stored through the preference seam, which never enters
/// a fieldMask.
public enum FavouriteConnections {

    public static let preferenceKey = "one.connections.favourites"

    /// Tolerant decode: a corrupt preference reads as no favourites rather
    /// than failing the list.
    public static func decode(_ value: String?) -> Set<String> {
        guard
            let value,
            let data = value.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let ids = object["ids"] as? [Any]
        else { return [] }
        return Set(ids.compactMap { $0 as? String }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
    }

    public static func encode(_ ids: Set<String>) -> String {
        let object: [String: Any] = ["ids": ids.sorted()]
        guard
            let data = try? JSONSerialization.data(withJSONObject: object),
            let text = String(data: data, encoding: .utf8)
        else { return "{\"ids\":[]}" }
        return text
    }

    public static func toggled(_ ids: Set<String>, connectionId: String) -> Set<String> {
        var copy = ids
        if copy.contains(connectionId) {
            copy.remove(connectionId)
        } else {
            copy.insert(connectionId)
        }
        return copy
    }
}
