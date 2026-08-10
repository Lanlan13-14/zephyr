import Foundation
@testable import ZephyrUI

/// Builders for the S20/S21 screen-logic tests. Mirrors the Android
/// `SessionTestSupport`.
enum SessionTestSupport {

    static func row(
        sessionId: String = "s-1",
        connectionId: String = "c-1",
        `protocol`: ConnectionProtocol = .ssh,
        name: String = "prod-web",
        host: String = "10.0.0.1",
        port: Int? = nil,
        transport: SessionTransport = .connected,
        execution: SessionExecution = .local,
        capabilities: CapabilitySet = .owner,
        residency: Residency = .owned,
        minimised: Bool = false,
        revoked: Bool = false,
        revokedReason: String? = nil,
        startedAt: Int64 = 1,
        endedAt: Int64? = nil,
        latencyMs: Int64? = nil,
        unreadOutput: Bool = false,
        restoredFromWorkspace: Bool = false
    ) -> SessionRow {
        SessionRow(
            sessionId: sessionId,
            connectionId: connectionId,
            protocol: `protocol`,
            name: name,
            host: host,
            port: port ?? `protocol`.defaultPort,
            transport: transport,
            execution: execution,
            capabilities: capabilities,
            residency: residency,
            minimised: minimised,
            revoked: revoked,
            revokedReason: revokedReason,
            startedAt: startedAt,
            endedAt: endedAt,
            latencyMs: latencyMs,
            unreadOutput: unreadOutput,
            restoredFromWorkspace: restoredFromWorkspace
        )
    }
}