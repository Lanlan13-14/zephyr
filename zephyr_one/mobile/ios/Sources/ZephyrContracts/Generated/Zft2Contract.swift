// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

import Foundation

/// ZFT2 wire constants frozen by ZEPHYR_PARITY.md 10.2.
public enum Zft2Contract {
    public static let magic: [UInt8] = [0x5A, 0x46, 0x54, 0x32]
    public static let version: UInt8 = 2
    public static let headerBytes = 20
    public static let flagError: UInt16 = 0x0001
    public static let flagResponse: UInt16 = 0x0002
    public static let maxMetaBytes = 262144
    public static let maxPayloadBytes = 1048576
    public static let maxInflightMin = 1
    public static let maxInflightMax = 16
    public static let maxInflightDefault = 8
}

public enum Zft2Op: UInt8, Sendable, CaseIterable {
    case open = 0x01
    case read = 0x02
    case write = 0x03
    case close = 0x04
    case stat = 0x05
    case list = 0x06
    case mkdir = 0x07
    case delete = 0x08
    case rename = 0x09
    case truncate = 0x0a
    case cancel = 0x0b
    case ping = 0x0c

    /// Write semantics a readOnly provider must reject at the provider layer.
    public var isWrite: Bool {
        [.write, .mkdir, .delete, .rename, .truncate].contains(self)
    }
}
