import XCTest
@testable import ZephyrUI

final class RootSurfaceStyleTests: XCTestCase {

    func testCardModifierHasNoStroke() throws {
        let source = try readSource("ZephyrStyle.swift")
        XCTAssertFalse(source.contains(".stroke(ZephyrStyle.separator"))
        XCTAssertTrue(source.contains("func zephyrCard()"))
    }

    func testIslandLabelIsNotHeightClipped() throws {
        let source = try readSource("RootSurfaces.swift")
        XCTAssertFalse(source.contains(".frame(height: selected ? 11 : 0)"))
        XCTAssertTrue(source.contains("if selected {"))
        XCTAssertTrue(source.contains(".fixedSize(horizontal: true, vertical: true)"))
    }

    private func readSource(_ name: String) throws -> String {
        let here = URL(fileURLWithPath: #filePath)
        let views = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/ZephyrUI/Views")
        return try String(contentsOf: views.appendingPathComponent(name), encoding: .utf8)
    }
}
