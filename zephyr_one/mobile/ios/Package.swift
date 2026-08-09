// swift-tools-version:5.9
import PackageDescription

/*
 Zephyr One iOS.

 Before this manifest existed, `mobile/ios` held six generated contract files
 and nothing else: no Package.swift, no Xcode project, no way to compile a line
 of it. IMPLEMENTATION_STATUS.md recorded that honestly as `missing`. The
 consequence was not merely that iOS was unstarted -- it was that the generated
 Swift could not even be type-checked, so `node mobile/tools/generate.mjs` was
 free to emit Swift that does not compile and nothing would notice. The Kotlin
 side had exactly that class of defect (four symbols referenced but never
 declared) and it took wiring up a real compiler to find them.

 Three targets, deliberately separated:

   ZephyrContracts  generated, never hand-edited. Its own target so a codegen
                    change that breaks compilation fails on its own rather than
                    inside application code.
   ZephyrCore       hand-written protocol and crypto logic that must agree
                    byte-for-byte with the Kotlin, JS and Dart implementations.
   ZephyrCoreTests  runs the frozen vectors from contracts/generated/ against
                    ZephyrCore, so the Swift port is checked against the same
                    bytes Kotlin is.

 The vectors are read from contracts/generated/ at test time via #filePath
 rather than declared as SwiftPM `resources`. Two reasons, and the first is
 decisive: SwiftPM can only bundle files inside the package directory, so a
 resource declaration would require copying the JSON into Tests/. That copy
 would be a second source of truth for bytes that three languages must agree
 on, and it would go stale silently -- exactly what the generated-manifest
 drift gate exists to prevent.

 No external dependencies. The Node contract suite is deliberately stdlib-only
 so nothing can drift between a local run and CI; the same reasoning applies
 here, and SHA-256 comes from CryptoKit, which ships with the OS.
*/
let package = Package(
    name: "ZephyrOne",
    platforms: [
        // iOS 15 is the product floor. macOS is listed because `swift test`
        // builds for the host, and without it the tests cannot run in CI.
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "ZephyrContracts", targets: ["ZephyrContracts"]),
        .library(name: "ZephyrCore", targets: ["ZephyrCore"]),
    ],
    targets: [
        .target(name: "ZephyrContracts"),
        .target(name: "ZephyrCore", dependencies: ["ZephyrContracts"]),
        .testTarget(name: "ZephyrCoreTests", dependencies: ["ZephyrCore", "ZephyrContracts"]),
    ]
)
