import XCTest
import ZephyrContracts
@testable import ZephyrUI

/// The S10 action gate decision table (SCREEN_CATALOG.md 2/5) and the
/// shared-to-me state machine.
final class ConnectionActionTests: XCTestCase {

    private func capabilities(_ values: Capability...) -> CapabilitySet {
        CapabilitySet(Set(values))
    }

    func testOwnerRowGetsEveryAction() {
        let connection = UiTestData.connection()
        for action in ConnectionAction.allCases {
            XCTAssertEqual(
                .allowed,
                ConnectionActions.gate(connection, action: action),
                "\(action) should be allowed on an owned row"
            )
        }
    }

    func testMissingCapabilityHides() {
        let connection = UiTestData.connection(capabilities: capabilities(.view))
        XCTAssertEqual(.hidden(missing: .use), ConnectionActions.gate(connection, action: .use))
        XCTAssertEqual(.hidden(missing: .edit), ConnectionActions.gate(connection, action: .edit))
        XCTAssertEqual(.hidden(missing: .delete), ConnectionActions.gate(connection, action: .delete))
        XCTAssertEqual(.hidden(missing: .use), ConnectionActions.gate(connection, action: .test))
        XCTAssertEqual(.hidden(missing: .share), ConnectionActions.gate(connection, action: .share))
    }

    func testDuplicateAndShareOnSharedRowsAreDisabledWithReasons() {
        let connection = UiTestData.shared()
        XCTAssertEqual(
            .disabled(missing: .edit, reason: ConnectionActions.reasonSharedNoCopy),
            ConnectionActions.gate(connection, action: .duplicate)
        )
        XCTAssertEqual(
            .disabled(missing: .share, reason: ConnectionActions.reasonSharedNoReshare),
            ConnectionActions.gate(connection, action: .share)
        )
        // But use stays: implicitShare carries USE.
        XCTAssertEqual(.allowed, ConnectionActions.gate(connection, action: .use))
    }

    func testVisibleActionsExcludeHidden() {
        let connection = UiTestData.shared()
        let visible = ConnectionActions.visibleActions(connection)
        XCTAssertTrue(visible.contains(.use))
        XCTAssertTrue(visible.contains(.duplicate))
        XCTAssertFalse(visible.contains(.edit))
        XCTAssertFalse(visible.contains(.delete))
    }

    func testSharedUseDisclosure() {
        XCTAssertNil(ConnectionActions.sharedUseDisclosure(UiTestData.connection()))
        XCTAssertEqual(
            ConnectionActions.disclosureRelay,
            ConnectionActions.sharedUseDisclosure(UiTestData.shared(usePolicy: .relayOnly))
        )
        XCTAssertEqual(
            ConnectionActions.disclosureDirect,
            ConnectionActions.sharedUseDisclosure(UiTestData.shared(usePolicy: .directAllowed))
        )
    }

    func testGatePredicates() {
        XCTAssertTrue(ActionGate.allowed.isAllowed)
        XCTAssertTrue(ActionGate.allowed.isVisible)
        XCTAssertFalse(ActionGate.hidden(missing: .use).isVisible)
        XCTAssertFalse(ActionGate.hidden(missing: .use).isAllowed)
        XCTAssertTrue(ActionGate.disabled(missing: .use, reason: "r").isVisible)
        XCTAssertFalse(ActionGate.disabled(missing: .use, reason: "r").isAllowed)
    }
}
