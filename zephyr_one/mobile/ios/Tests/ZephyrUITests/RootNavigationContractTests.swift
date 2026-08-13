import XCTest
@testable import ZephyrUI

final class RootNavigationContractTests: XCTestCase {

    func testFrozenRootIslandHasExactlyFourDestinations() {
        XCTAssertEqual(RootDestination.allCases, [.home, .sessions, .library, .tools])
        XCTAssertEqual(RootDestination.allCases.map(\.title), ["首页", "会话", "资料", "工具"])
    }

    func testLibraryRootExposesEveryFrozenEntry() {
        XCTAssertEqual(LibraryDestination.allCases, [.sftp, .notes, .snippets, .downloads])
    }

    func testToolsRootExposesConcreteTypedEntries() {
        XCTAssertEqual(
            ToolDestination.allCases,
            [
                .remoteBatch,
                .proxy,
                .sshKeys,
                .aiAssistant,
                .fileSync,
                .clientToken,
                .server,
                .appearance,
                .language,
                .localUnlock,
                .diagnostics,
            ]
        )
    }

    #if canImport(SwiftUI)
    func testFrozenIslandGeometry() {
        XCTAssertEqual(ZephyrRootIslandMetrics.height, 62)
        XCTAssertEqual(ZephyrRootIslandMetrics.outerRadius, 31)
        XCTAssertEqual(ZephyrRootIslandMetrics.bottomSpacing, 18)
        XCTAssertEqual(ZephyrRootIslandMetrics.compactMaximumWidth, 340)
        XCTAssertEqual(ZephyrRootIslandMetrics.regularMaximumWidth, 360)
    }
    #endif
}
