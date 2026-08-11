import XCTest
@testable import ZephyrUI

final class ConnectionEditorDismissCoordinatorTests: XCTestCase {

    func testCleanDraftDismissesImmediatelyAndAllowsSystemNavigation() {
        let coordinator = ConnectionEditorDismissCoordinator(hasUnsavedChanges: false)
        var confirmationCount = 0
        var dismissalCount = 0

        coordinator.requestDismiss(
            confirmDiscard: { confirmationCount += 1 },
            dismiss: { dismissalCount += 1 }
        )

        XCTAssertEqual(.dismiss, coordinator.decision)
        XCTAssertTrue(coordinator.allowsSystemDismissal)
        XCTAssertEqual(0, confirmationCount)
        XCTAssertEqual(1, dismissalCount)
    }

    func testDirtyDraftRequestsConfirmationAndBlocksSystemNavigation() {
        let coordinator = ConnectionEditorDismissCoordinator(hasUnsavedChanges: true)
        var confirmationCount = 0
        var dismissalCount = 0

        coordinator.requestDismiss(
            confirmDiscard: { confirmationCount += 1 },
            dismiss: { dismissalCount += 1 }
        )

        XCTAssertEqual(.confirmDiscard, coordinator.decision)
        XCTAssertFalse(coordinator.allowsSystemDismissal)
        XCTAssertEqual(1, confirmationCount)
        XCTAssertEqual(0, dismissalCount)
    }
}
