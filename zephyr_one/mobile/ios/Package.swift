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

 ZephyrUI was added after the core: the SwiftUI presentation layer (root
 navigation, S01/S02/S10/S11) plus the view models and pure screen logic the
 Kotlin feature-connections module mirrors. Two rules keep it honest on the
 macOS CI runner, where `swift build` compiles for the host and UIKit does
 not exist:

   - Every rule the product contract freezes (page-state derivation, filter
     semantics, the editor field mask, the binding state machine, the lock
     policy) is Foundation/Combine-only code, so `swift test` exercises it on
     the runner. SwiftUI views are a thin rendering of those types.
   - View files are wrapped in `#if canImport(SwiftUI)` and compile for
     macOS 12 as well as iOS 15, so the compiler still reads them; only the
     UIKit bridge (interactive pop gesture) and iOS-specific modifiers sit
     behind `canImport(UIKit)` shims.

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
         .library(name: "ZephyrUI", targets: ["ZephyrUI"]),
     ],
     targets: [
         .target(name: "ZephyrContracts"),
         .target(name: "ZephyrCore", dependencies: ["ZephyrContracts"]),
         .target(name: "ZephyrUI", dependencies: ["ZephyrCore", "ZephyrContracts"]),
         .testTarget(name: "ZephyrCoreTests", dependencies: ["ZephyrCore", "ZephyrContracts"]),
         .testTarget(name: "ZephyrUITests", dependencies: ["ZephyrUI", "ZephyrCore", "ZephyrContracts"]),
     ]
 )
