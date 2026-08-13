#!/usr/bin/env bash

set -euo pipefail

OUTPUT_PATH="${1:-$PWD/zephyr-one-ios-unsigned.ipa}"
IOS_PACKAGE_PATH="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../ios" && pwd)}"
mkdir -p "$(dirname "$OUTPUT_PATH")"
OUTPUT_PATH="$(cd "$(dirname "$OUTPUT_PATH")" && pwd)/$(basename "$OUTPUT_PATH")"
IOS_PACKAGE_PATH="$(cd "$IOS_PACKAGE_PATH" && pwd)"
RAW_MARKETING_VERSION="${MARKETING_VERSION:-1.0.0}"
if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" && "$RAW_MARKETING_VERSION" != zom-v* ]]; then
  echo "Workflow dispatch version must start with zom-v: $RAW_MARKETING_VERSION" >&2
  exit 1
fi
MARKETING_VERSION="${RAW_MARKETING_VERSION#zom-v}"
BUNDLE_VERSION="${GITHUB_RUN_NUMBER:-1}"
WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zephyr-one-ios.XXXXXX")"
HOST_DIR="$WORK_DIR/host"
BUILD_DIR="$WORK_DIR/build"
STAGING_DIR="$WORK_DIR/staging"
APP_DIR="$STAGING_DIR/Payload/ZephyrOne.app"
EXECUTABLE_NAME="ZephyrOneMobileApp"
PACKAGED_IPA="$WORK_DIR/zephyr-one-ios-unsigned.ipa"

if [[ ! "$MARKETING_VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "Invalid iOS marketing version after removing zom-v prefix: $RAW_MARKETING_VERSION" >&2
  exit 1
fi
if [[ ! "$BUNDLE_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid iOS bundle version: $BUNDLE_VERSION" >&2
  exit 1
fi

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$HOST_DIR/Sources/$EXECUTABLE_NAME" "$APP_DIR"

cat > "$HOST_DIR/Package.swift" <<'SWIFT'
// swift-tools-version:5.9
import Foundation
import PackageDescription

let zephyrPackagePath = ProcessInfo.processInfo.environment["ZEPHYR_IOS_PACKAGE_PATH"]!

let package = Package(
    name: "ZephyrOneMobileHost",
    platforms: [.iOS(.v17), .macOS(.v14)],
    dependencies: [
        .package(name: "ZephyrOne", path: zephyrPackagePath),
    ],
    targets: [
        .executableTarget(
            name: "ZephyrOneMobileApp",
            dependencies: [
                .product(name: "ZephyrCore", package: "ZephyrOne"),
                .product(name: "ZephyrUI", package: "ZephyrOne"),
            ]
        ),
    ]
)
SWIFT

cat > "$HOST_DIR/Sources/$EXECUTABLE_NAME/ZephyrOneMobileApp.swift" <<'SWIFT'
import Foundation
import Security
import SwiftUI
import UIKit
import ZephyrCore
import ZephyrUI

@main
@MainActor
struct ZephyrOneMobileApp: App {
    @StateObject private var composition = LocalComposition()

    var body: some Scene {
        WindowGroup {
            ZephyrOneRootView(
                appLock: composition.appLock,
                navigation: composition.navigation,
                listViewModel: composition.connectionList,
                sessionViewModel: composition.sessionList,
                makeEditorViewModel: composition.makeEditorViewModel,
                makeBindingViewModel: composition.makeBindingViewModel,
                onConnect: composition.openConnection,
                connectionActions: ConnectionHostActions(
                    duplicate: composition.duplicateConnection,
                    test: composition.testConnection,
                    share: composition.shareConnection
                ),
                sessionActions: SessionHostActions(
                    openTerminal: composition.openTerminal,
                    openRemote: composition.openRemote,
                    reconnect: composition.reconnect,
                    showDetails: composition.showSessionDetails
                ),
                featureActions: FeatureHostActions(
                    openLibrary: composition.openLibrary,
                    openTool: composition.openTool
                )
            )
            .alert(item: $composition.notice) { notice in
                Alert(
                    title: Text(notice.title),
                    message: Text(notice.message),
                    dismissButton: .default(Text("好"))
                )
            }
        }
    }
}

@MainActor
private final class LocalComposition: ObservableObject {
    let appLock: AppLock
    let navigation = RootNavigationModel()
    let connectionList: ConnectionListViewModel
    let sessionList: SessionListViewModel
    @Published var notice: HostNotice?

    private let ownerUserId = "local"
    private let connections: LocalConnectionStore
    private let sessions: SessionRegistry

    init() {
        let connections = LocalConnectionStore()
        let preferences = LocalPreferenceStore()
        let connectionList = ConnectionListViewModel(
            ownerUserId: ownerUserId,
            connections: connections,
            preferences: preferences
        )
        let sessions = SessionRegistry()
        let sessionList = SessionListViewModel(
            registry: sessions,
            closeTransport: { _ in },
            clock: LocalComposition.nowMs
        )

        self.connections = connections
        self.sessions = sessions
        self.connectionList = connectionList
        self.sessionList = sessionList
        self.appLock = AppLock(
            authenticator: LocalDeviceAuthenticator(),
            clock: LocalComposition.nowMs
        )

        connections.onChange = { [weak connectionList] rows in
            DispatchQueue.main.async {
                connectionList?.updateOwnedRows(rows)
            }
        }
        connectionList.updateOwnedRows(connections.snapshot())
        connectionList.updateBinding(bound: false, lastSyncedAt: nil)
        sessionList.markRestoreComplete()
    }

    func makeEditorViewModel(connectionId: String?) -> ConnectionEditorViewModel {
        ConnectionEditorViewModel(
            connections: connections,
            ownerUserId: ownerUserId,
            connectionId: connectionId,
            newId: { UUID().uuidString.lowercased() },
            tester: UnavailableConnectionTester(),
            clock: LocalComposition.nowMs
        )
    }

    func makeBindingViewModel() -> ServerBindingViewModel {
        ServerBindingViewModel(
            makeCoordinator: { _ in throw LocalModeUnavailable() },
            onBound: { _, _ in }
        )
    }

    func openConnection(_ connection: Connection, persisted: Bool) {
        let sessionId = UUID().uuidString.lowercased()
        sessions.upsert(SessionRow(
            sessionId: sessionId,
            connectionId: connection.id,
            protocol: connection.`protocol`,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            transport: .closed,
            startedAt: Self.nowMs(),
            endedAt: Self.nowMs(),
            detail: "此预发布包尚未链接原生协议引擎"
        ))
        navigation.selectedRoot = .sessions
        showUnavailable("连接", detail: "连接已保存到本机，但当前 iOS 包尚未链接原生 SSH/Telnet/RDP/VNC 引擎。")
    }

    func duplicateConnection(_ connection: Connection) {
        Task { @MainActor in
            var copy = connection
            copy.id = UUID().uuidString.lowercased()
            copy.name = connection.name + " 副本"
            copy.revision = 0
            copy.updatedAt = Self.nowMs()
            copy.lastConnectedAt = nil
            copy.syncState = .pendingLocal
            do {
                try await connections.save(
                    connection: copy,
                    mask: [],
                    secrets: [:],
                    ownerUserId: ownerUserId,
                    createdLocally: true
                )
                notice = HostNotice(title: "已复制", message: "\(copy.name) 已保存到本机。")
            } catch {
                notice = HostNotice(title: "复制失败", message: error.localizedDescription)
            }
        }
    }

    func testConnection(_ connection: Connection) {
        showUnavailable("连接测试", detail: "原生协议引擎尚未链接，不能伪造测试成功。")
    }

    func shareConnection(_ connection: Connection) {
        let text = "\(connection.name)\n\(connection.`protocol`.rawValue)://\(connection.host):\(connection.port)"
        guard let presenter = Self.presentingViewController() else {
            notice = HostNotice(title: "无法分享", message: "当前没有可显示系统分享面板的窗口。")
            return
        }
        let controller = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = presenter.view
        controller.popoverPresentationController?.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.maxY,
            width: 1,
            height: 1
        )
        presenter.present(controller, animated: true)
    }

    func openTerminal(_ sessionId: String, _ connectionId: String) {
        showUnavailable("终端", detail: "原生终端引擎尚未链接。")
    }

    func openRemote(_ sessionId: String, _ connectionId: String) {
        showUnavailable("远程桌面", detail: "原生 RDP/VNC 引擎尚未链接。")
    }

    func reconnect(_ sessionId: String, _ connectionId: String, _ protocol: ConnectionProtocol) {
        showUnavailable("重新连接", detail: "原生 \(`protocol`.rawValue.uppercased()) 引擎尚未链接。")
    }

    func showSessionDetails(_ sessionId: String) {
        let detail = sessions.row(sessionId)?.detail ?? "没有更多会话详情。"
        notice = HostNotice(title: "会话详情", message: detail)
    }

    func openLibrary(_ destination: LibraryDestination) {
        showUnavailable(destination.title, detail: "此资料页面尚未接入 iOS 本地数据宿主。")
    }

    func openTool(_ destination: ToolDestination) {
        if destination == .fileSync {
            notice = HostNotice(
                title: "文件同步",
                message: "同步是可选能力。当前处于本地模式，连接库仍可正常创建、编辑、复制和删除。"
            )
        } else {
            showUnavailable(destination.title, detail: "此工具页面尚未接入 iOS 宿主。")
        }
    }

    private func showUnavailable(_ title: String, detail: String) {
        notice = HostNotice(title: title, message: detail)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }

    private static func presentingViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        return controller
    }
}

private struct HostNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

private struct LocalModeUnavailable: LocalizedError {
    var errorDescription: String? { "Server binding is unavailable in local mode." }
}

private final class LocalDeviceAuthenticator: DeviceAuthenticator {
    func availability() -> BiometricAvailability { .unsupported }

    func authenticate(title: String, subtitle: String) async -> AuthResult {
        .failed(availability: .unsupported, message: "Device authentication is unavailable.")
    }
}

private final class LocalPreferenceStore: PreferenceStore {
    private let defaults = UserDefaults.standard

    func preference(_ key: String) -> String? { defaults.string(forKey: key) }

    func putPreference(_ key: String, _ value: String) {
        defaults.set(value, forKey: key)
    }
}

private final class LocalConnectionStore: ConnectionStore {
    var onChange: (([Connection]) -> Void)?
    private var rows: [String: Connection] = [:]
    private let fileURL: URL

    init() {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!.appendingPathComponent("ZephyrOne", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        fileURL = directory.appendingPathComponent("connections.json")
        if let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([Connection].self, from: data) {
            rows = Dictionary(uniqueKeysWithValues: saved.map { ($0.id, $0) })
        }
    }

    func snapshot() -> [Connection] {
        rows.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func find(_ connectionId: String) -> Connection? {
        rows[connectionId]
    }

    func save(
        connection: Connection,
        mask: [String],
        secrets: [String: SecretState],
        ownerUserId: String,
        createdLocally: Bool
    ) async throws {
        var stored = connection
        stored.password = try LocalSecretStore.apply(
            secrets["password"],
            existing: connection.password,
            connectionId: connection.id,
            field: "password"
        )
        stored.privateKey = try LocalSecretStore.apply(
            secrets["privateKey"],
            existing: connection.privateKey,
            connectionId: connection.id,
            field: "privateKey"
        )
        rows[connection.id] = stored
        try persist()
        onChange?(snapshot())
    }

    func delete(_ connection: Connection, ownerUserId: String) async throws {
        rows.removeValue(forKey: connection.id)
        try LocalSecretStore.remove(connectionId: connection.id, field: "password")
        try LocalSecretStore.remove(connectionId: connection.id, field: "privateKey")
        try persist()
        onChange?(snapshot())
    }

    func setFileSyncIntent(
        _ connectionId: String,
        _ intent: FileSyncDirectoryIntent,
        _ nowMs: Int64
    ) async throws {
        guard var connection = rows[connectionId] else { return }
        connection.fileSyncIntent = intent
        rows[connectionId] = connection
        try persist()
        onChange?(snapshot())
    }

    private func persist() throws {
        let data = try JSONEncoder().encode(snapshot())
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}

private enum LocalStoreError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status): return "Keychain operation failed (\(status))."
        }
    }
}

private enum LocalSecretStore {
    private static let service = "one.zephyr.mobile.local-connection"

    static func apply(
        _ state: SecretState?,
        existing: SecretPresence,
        connectionId: String,
        field: String
    ) throws -> SecretPresence {
        guard let state else { return existing }
        switch state {
        case .unchanged:
            return existing
        case .clear:
            try remove(connectionId: connectionId, field: field)
            return .absent
        case .replace(let value):
            try put(Data(value.utf8), account: account(connectionId, field))
            return SecretPresence(hasValue: true, secretRef: "keychain:\(field)")
        }
    }

    static func remove(connectionId: String, field: String) throws {
        let status = SecItemDelete(query(account(connectionId, field)) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw LocalStoreError.keychain(status)
        }
    }

    private static func put(_ data: Data, account: String) throws {
        let base = query(account)
        let update = SecItemUpdate(
            base as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw LocalStoreError.keychain(update) }
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let add = SecItemAdd(item as CFDictionary, nil)
        guard add == errSecSuccess else { throw LocalStoreError.keychain(add) }
    }

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func account(_ connectionId: String, _ field: String) -> String {
        connectionId + ":" + field
    }
}
SWIFT

SDK_PATH="$(xcrun --sdk iphoneos --show-sdk-path)"
export ZEPHYR_IOS_PACKAGE_PATH="$IOS_PACKAGE_PATH"

SWIFT_BUILD_ARGS=(
  --package-path "$HOST_DIR"
  --scratch-path "$BUILD_DIR"
  --configuration release
  --triple arm64-apple-ios17.0
  --sdk "$SDK_PATH"
  --product "$EXECUTABLE_NAME"
)

swift build "${SWIFT_BUILD_ARGS[@]}" -v
BIN_DIR="$(swift build "${SWIFT_BUILD_ARGS[@]}" --show-bin-path)"
BUILT_EXECUTABLE="$BIN_DIR/$EXECUTABLE_NAME"

test -f "$BUILT_EXECUTABLE"
file "$BUILT_EXECUTABLE" | grep -Eq 'Mach-O.*arm64'
xcrun otool -hv "$BUILT_EXECUTABLE" | grep -q 'EXECUTE'
xcrun vtool -show-build "$BUILT_EXECUTABLE" | grep -q 'platform IOS'
install -m 0755 "$BUILT_EXECUTABLE" "$APP_DIR/$EXECUTABLE_NAME"

framework_queue=()
embedded_frameworks=()
while IFS= read -r framework_name; do
  framework_queue+=("$framework_name")
done < <(
  otool -L "$BUILT_EXECUTABLE" |
    sed -nE 's|^[[:space:]]+@rpath/([^/]+\.framework)/.*|\1|p' |
    sort -u
)

framework_index=0
while (( framework_index < ${#framework_queue[@]} )); do
  framework_name="${framework_queue[$framework_index]}"
  framework_index=$((framework_index + 1))

  already_embedded=false
  for embedded_name in "${embedded_frameworks[@]}"; do
    if [[ "$embedded_name" == "$framework_name" ]]; then
      already_embedded=true
      break
    fi
  done
  if [[ "$already_embedded" == true ]]; then
    continue
  fi

  framework_path=""
  framework_executable=""
  while IFS= read -r candidate; do
    candidate_executable="$candidate/${framework_name%.framework}"
    if [[ -f "$candidate/Info.plist" ]]; then
      plist_executable="$(plutil -extract CFBundleExecutable raw "$candidate/Info.plist" 2>/dev/null || true)"
      if [[ -n "$plist_executable" ]]; then
        candidate_executable="$candidate/$plist_executable"
      fi
    fi
    if [[ -f "$candidate_executable" ]] &&
       file "$candidate_executable" | grep -Eq 'Mach-O.*arm64' &&
       xcrun vtool -show-build "$candidate_executable" 2>/dev/null | grep -Eq 'platform IOS$'; then
      framework_path="$candidate"
      framework_executable="$candidate_executable"
      break
    fi
  done < <(find "$BUILD_DIR" -type d -name "$framework_name" -print)

  if [[ -z "$framework_path" ]]; then
    echo "Missing linked framework: $framework_name" >&2
    exit 1
  fi
  mkdir -p "$APP_DIR/Frameworks"
  ditto "$framework_path" "$APP_DIR/Frameworks/$framework_name"
  embedded_frameworks+=("$framework_name")

  while IFS= read -r dependency_name; do
    framework_queue+=("$dependency_name")
  done < <(
    otool -L "$framework_executable" |
      sed -nE 's|^[[:space:]]+@rpath/([^/]+\.framework)/.*|\1|p' |
      sort -u
  )
done

linked_frameworks="$WORK_DIR/linked-frameworks.txt"
printf '%s\n' "${embedded_frameworks[@]}" | sed '/^$/d' | sort -u > "$linked_frameworks"

while IFS= read -r framework_name; do
  framework_dir="$APP_DIR/Frameworks/$framework_name"
  framework_executable="$(plutil -extract CFBundleExecutable raw "$framework_dir/Info.plist" 2>/dev/null || true)"
  if [[ -z "$framework_executable" ]]; then
    framework_executable="${framework_name%.framework}"
  fi
  test -f "$framework_dir/$framework_executable"
  file "$framework_dir/$framework_executable" | grep -Eq 'Mach-O.*arm64'
  xcrun vtool -show-build "$framework_dir/$framework_executable" | grep -Eq 'platform IOS$'
  codesign --remove-signature "$framework_dir/$framework_executable" 2>/dev/null || true
done < "$linked_frameworks"

codesign --remove-signature "$APP_DIR/$EXECUTABLE_NAME" 2>/dev/null || true
find "$APP_DIR" -type d -name _CodeSignature -prune -exec rm -rf {} +
find "$APP_DIR" -type f -name embedded.mobileprovision -delete

plutil -create xml1 "$APP_DIR/Info.plist"
plutil -insert CFBundleDisplayName -string 'Zephyr One' "$APP_DIR/Info.plist"
plutil -insert CFBundleExecutable -string "$EXECUTABLE_NAME" "$APP_DIR/Info.plist"
plutil -insert CFBundleIdentifier -string 'one.zephyr.mobile' "$APP_DIR/Info.plist"
plutil -insert CFBundleInfoDictionaryVersion -string '6.0' "$APP_DIR/Info.plist"
plutil -insert CFBundleName -string 'Zephyr One' "$APP_DIR/Info.plist"
plutil -insert CFBundlePackageType -string 'APPL' "$APP_DIR/Info.plist"
plutil -insert CFBundleShortVersionString -string "$MARKETING_VERSION" "$APP_DIR/Info.plist"
plutil -insert CFBundleVersion -string "$BUNDLE_VERSION" "$APP_DIR/Info.plist"
plutil -insert CFBundleSupportedPlatforms -json '["iPhoneOS"]' "$APP_DIR/Info.plist"
plutil -insert LSRequiresIPhoneOS -bool YES "$APP_DIR/Info.plist"
plutil -insert MinimumOSVersion -string '17.0' "$APP_DIR/Info.plist"
plutil -insert UIDeviceFamily -json '[1,2]' "$APP_DIR/Info.plist"
plutil -insert UILaunchScreen -json '{}' "$APP_DIR/Info.plist"

plutil -lint "$APP_DIR/Info.plist"
test "$(plutil -extract CFBundleExecutable raw "$APP_DIR/Info.plist")" = "$EXECUTABLE_NAME"
test -x "$APP_DIR/$EXECUTABLE_NAME"

rm -f "$PACKAGED_IPA"
(
  cd "$STAGING_DIR"
  /usr/bin/zip -qry "$PACKAGED_IPA" Payload
)

unzip -tq "$PACKAGED_IPA"
unzip -Z1 "$PACKAGED_IPA" | grep -qx 'Payload/ZephyrOne.app/Info.plist'
unzip -Z1 "$PACKAGED_IPA" | grep -qx "Payload/ZephyrOne.app/$EXECUTABLE_NAME"
while IFS= read -r framework_name; do
  unzip -Z1 "$PACKAGED_IPA" | grep -q "^Payload/ZephyrOne.app/Frameworks/$framework_name/"
done < "$linked_frameworks"

VERIFY_DIR="$WORK_DIR/verify"
mkdir -p "$VERIFY_DIR"
unzip -q "$PACKAGED_IPA" -d "$VERIFY_DIR"
ARCHIVED_APP_DIR="$VERIFY_DIR/Payload/ZephyrOne.app"
test "$(plutil -extract CFBundleShortVersionString raw "$ARCHIVED_APP_DIR/Info.plist")" = "$MARKETING_VERSION"
test "$(plutil -extract CFBundleVersion raw "$ARCHIVED_APP_DIR/Info.plist")" = "$BUNDLE_VERSION"
test "$(plutil -extract CFBundleExecutable raw "$ARCHIVED_APP_DIR/Info.plist")" = "$EXECUTABLE_NAME"
test -x "$ARCHIVED_APP_DIR/$EXECUTABLE_NAME"
xcrun otool -hv "$ARCHIVED_APP_DIR/$EXECUTABLE_NAME" | grep -q 'EXECUTE'
xcrun vtool -show-build "$ARCHIVED_APP_DIR/$EXECUTABLE_NAME" | grep -Eq 'platform IOS$'
test ! -d "$ARCHIVED_APP_DIR/_CodeSignature"
test ! -f "$ARCHIVED_APP_DIR/embedded.mobileprovision"
! codesign -dv "$ARCHIVED_APP_DIR" >/dev/null 2>&1
test -s "$PACKAGED_IPA"

trap - EXIT
mkdir -p "$(dirname "$OUTPUT_PATH")"
rm -f "$OUTPUT_PATH"
install -m 0644 "$PACKAGED_IPA" "$OUTPUT_PATH"
test -s "$OUTPUT_PATH"
rm -rf "$WORK_DIR"

echo "Created unsigned IPA: $OUTPUT_PATH"
