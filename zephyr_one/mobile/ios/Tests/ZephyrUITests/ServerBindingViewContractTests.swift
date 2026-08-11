import Foundation
import XCTest
@testable import ZephyrUI

final class ServerBindingViewContractTests: XCTestCase {

    func testSecureFieldsUseViewLocalBuffersAndNeverBindDraftSecrets() throws {
        let source = try bindingViewSource()

        XCTAssertTrue(source.contains("@StateObject private var sensitiveText"))
        XCTAssertTrue(source.contains("SecureField(\"密码\", text: $sensitiveText.password)"))
        XCTAssertTrue(source.contains("text: $sensitiveText.totpCode"))
        XCTAssertFalse(source.contains("$viewModel.draft.password"))
        XCTAssertFalse(source.contains("$viewModel.draft.totpCode"))
        XCTAssertFalse(source.contains("var sensitiveGrant"))
        XCTAssertFalse(source.contains("var grant"))
    }

    func testNativeAccessibilityAndProgressContractsRemainVisible() throws {
        let source = try bindingViewSource()

        XCTAssertTrue(source.contains("Form {"))
        XCTAssertTrue(source.contains("@FocusState"))
        XCTAssertTrue(source.contains(".accessibilityAction(.escape)"))
        XCTAssertTrue(source.contains(".accessibilityValue"))
        XCTAssertTrue(source.contains("ProgressView"))
        XCTAssertTrue(source.contains(".zephyrInteractivePopGesture()"))
    }

    func testFrequentBindingFlowHasNoDecorativeAnimation() throws {
        let source = try bindingViewSource()

        XCTAssertFalse(source.contains(".animation("))
        XCTAssertFalse(source.contains("withAnimation"))
        XCTAssertFalse(source.contains("matchedGeometryEffect"))
    }

    func testErrorViewRendersOnlyPresentationSafeFailure() throws {
        let source = try bindingViewSource()

        XCTAssertTrue(source.contains("Text(failure.message)"))
        XCTAssertTrue(source.contains("Text(failure.diagnosticText)"))
        XCTAssertFalse(source.contains("MobileApiError"))
        XCTAssertFalse(source.contains("failure.details"))
    }

    private func bindingViewSource() throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let packageDirectory = testsDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = packageDirectory
            .appendingPathComponent("Sources")
            .appendingPathComponent("ZephyrUI")
            .appendingPathComponent("Views")
            .appendingPathComponent("ServerBindingView.swift")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }
}
