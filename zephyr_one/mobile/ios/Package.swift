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

 Both native dependencies are exact-revision pins:

   - OpenSSL-Package supplies OpenSSL 3.6.3 for ML-KEM. Its binary target is
     checksum-pinned to
     6c4b064d12b8de2ae77ac59fbcbbd1c20b4fecfb7fc50b8ab326347c52ecbf0c.
   - SQLiteCipher supplies SQLCipher 4.10.0 / SQLite 3.50.4. Its 0.16.0
     SQLCipher and SQLite wrapper XCFrameworks are checksum-pinned by the
     dependency manifest to
     cb13b28fecf0d651a451d29545f4904af7c2781e9774c1d4da2cd442126f420b and
     f0b61023394fbcf3c52877f4bef371c32f4098704668a5986992bcad8ce31c03.

 OpenSSL supplies the audited FIPS 203 primitive. SQLCipher supplies mature
 page encryption; ZephyrCore owns account scoping, ThisDeviceOnly key
 persistence, owner-proven plaintext migration and lifecycle erasure.
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
     dependencies: [
         .package(
             url: "https://github.com/krzyzanowskim/OpenSSL-Package.git",
             revision: "0b0cc7392a4ff6a798c9ed8f4981f1c1bbcb4722"
         ),
         .package(
             url: "https://github.com/zhuorantan/SQLiteCipher.git",
             revision: "70589046bd800e3db5c0155a558a9bc7a9f260ef"
         ),
     ],
     targets: [
         .target(name: "ZephyrContracts"),
         .target(
             name: "ZephyrCore",
             dependencies: [
                 "ZephyrContracts",
                 .product(name: "OpenSSL", package: "OpenSSL-Package"),
                 .product(name: "SQLiteCipher", package: "SQLiteCipher"),
             ]
         ),
         .target(name: "ZephyrUI", dependencies: ["ZephyrCore", "ZephyrContracts"]),
         .testTarget(
             name: "ZephyrCoreTests",
             dependencies: [
                 "ZephyrCore",
                 "ZephyrContracts",
                 .product(name: "SQLiteCipher", package: "SQLiteCipher"),
             ]
         ),
         .testTarget(name: "ZephyrUITests", dependencies: ["ZephyrUI", "ZephyrCore", "ZephyrContracts"]),
     ]
 )
