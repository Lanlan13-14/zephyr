import XCTest
@testable import ZephyrUI

/// S21 page-state derivation and the surface state machine.
final class TerminalStateTests: XCTestCase {

    private var conn: Connection { UiTestData.connection() }
    private var surface: TerminalSurfaceState { TerminalSurfaceState() }

    func testNotLoadedIsInitialLoading() {
        let state = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: nil,
            loaded: false,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case .initialLoading = state else {
            return XCTFail("expected initialLoading, got \(state)")
        }
    }

    func testMissingConnectionIsNotFoundOrRevoked() {
        let state = TerminalStates.derive(
            connection: nil,
            surface: surface,
            row: nil,
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        XCTAssertEqual(state, .notFoundOrRevoked)
    }

    func testRevokedRowIsNotFoundOrRevoked() {
        let state = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: SessionTestSupport.row(revoked: true),
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        XCTAssertEqual(state, .notFoundOrRevoked)
    }

    func testNoUseIsPermissionDenied() {
        let noUse = UiTestData.connection(capabilities: CapabilitySet([.view]))
        let state = TerminalStates.derive(
            connection: noUse,
            surface: surface,
            row: nil,
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case let .permissionDenied(missing, _) = state else {
            return XCTFail("expected permissionDenied, got \(state)")
        }
        XCTAssertEqual(missing, .use)
    }

    func testEngineUnavailableIsFatal() {
        let state = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: nil,
            loaded: true,
            error: UnavailableTerminalEmulator.blocked,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case let .fatalIncompatible(error) = state else {
            return XCTFail("expected fatalIncompatible, got \(state)")
        }
        XCTAssertEqual(error.code, "engine_unavailable")
    }

    func testRetryableErrorStaysRetryable() {
        let state = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: nil,
            loaded: true,
            error: MobileError.offline,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case .retryableError = state else {
            return XCTFail("expected retryableError, got \(state)")
        }
    }

    func testContentDefaultsToDisconnectedWithoutRow() {
        let state = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: nil,
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case let .content(value, _, _, _) = state else {
            return XCTFail("expected content, got \(state)")
        }
        XCTAssertEqual(value.transport, .disconnected)
        XCTAssertTrue(value.canReconnect)
    }

    func testTelnetRemovesFilesDockAndAddsCleartextWarning() {
        let telnet = UiTestData.connection(`protocol`: .telnet)
        let state = TerminalStates.derive(
            connection: telnet,
            surface: surface,
            row: nil,
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        )
        guard case let .content(value, _, _, _) = state else {
            return XCTFail("expected content, got \(state)")
        }
        XCTAssertFalse(value.dock.contains(.files))
        XCTAssertEqual(value.cleartextWarning, TerminalStates.cleartextWarning)
        XCTAssertTrue(value.encodingSelectable)
    }

    func testSshHasFilesDockAndNoCleartextWarning() {
        guard case let .content(value, _, _, _) = TerminalStates.derive(
            connection: conn,
            surface: surface,
            row: nil,
            loaded: true,
            error: nil,
            hostKeyPrompt: nil,
            autoLoginStatus: nil
        ) else { return XCTFail("expected content") }
        XCTAssertTrue(value.dock.contains(.files))
        XCTAssertNil(value.cleartextWarning)
        XCTAssertFalse(value.encodingSelectable)
    }

    func testSharedDisclosure() {
        let relay = UiTestData.connection(residency: .sharedOnlineOnly, sharedUsePolicy: .relayOnly)
        let direct = UiTestData.connection(residency: .sharedOnlineOnly, sharedUsePolicy: .directAllowed)
        guard case let .content(relayValue, _, _, _) = TerminalStates.derive(
            connection: relay, surface: surface, row: nil, loaded: true, error: nil, hostKeyPrompt: nil, autoLoginStatus: nil
        ) else { return XCTFail("expected content") }
        guard case let .content(directValue, _, _, _) = TerminalStates.derive(
            connection: direct, surface: surface, row: nil, loaded: true, error: nil, hostKeyPrompt: nil, autoLoginStatus: nil
        ) else { return XCTFail("expected content") }
        XCTAssertEqual(relayValue.executionDisclosure, SessionActions.disclosureRelay)
        XCTAssertEqual(directValue.executionDisclosure, SessionActions.disclosureDirect)
    }

    // ---- surface state machine -------------------------------------------------------------------

    func testSurfaceReadingAndMissedOutput() {
        var state = TerminalSurfaceState()
        XCTAssertTrue(state.followingBottom)
        state.beginReading()
        XCTAssertFalse(state.followingBottom)
        state.noteOutput(rows: 2)
        state.noteOutput(rows: 3)
        XCTAssertEqual(state.missedOutputRows, 5)
    }

    func testSurfaceFollowsWhileAtBottom() {
        var state = TerminalSurfaceState()
        state.noteOutput(rows: 4)
        XCTAssertEqual(state.missedOutputRows, 0)
        XCTAssertTrue(state.followingBottom)
    }

    func testJumpToBottomClearsMissedRows() {
        var state = TerminalSurfaceState()
        state.beginReading()
        state.noteOutput(rows: 7)
        state.jumpToBottom()
        XCTAssertTrue(state.followingBottom)
        XCTAssertEqual(state.missedOutputRows, 0)
    }
}