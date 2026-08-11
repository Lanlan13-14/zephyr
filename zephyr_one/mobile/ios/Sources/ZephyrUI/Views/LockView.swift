#if canImport(SwiftUI)
import SwiftUI

/// S01 启动与本地解锁.
///
/// Shown by the root whenever ``AppLock/state`` is locked. All policy -- when
/// to lock, which delay applies, what clears on lock -- lives in ``AppLock``;
/// this view only renders the platform prompt result. When the platform cannot
/// authenticate, the screen says so precisely instead of offering a One-built
/// password, which the product contract forbids.
@MainActor
public struct LockView: View {

    @ObservedObject var appLock: AppLock

    @State private var failureMessage: String?
    @State private var authenticating = false

    public init(appLock: AppLock) {
        self.appLock = appLock
    }

    public var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.largeTitle)
            Text("Zephyr One 已锁定")
                .font(.headline)
            if let failureMessage {
                Text(failureMessage)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
            Button(authenticating ? "正在验证…" : "解锁") {
                Task { await unlock() }
            }
            .disabled(authenticating)
            Spacer()
        }
        .padding()
    }

    private func unlock() async {
        authenticating = true
        let result = await appLock.unlock(title: "解锁 Zephyr One", subtitle: "使用设备凭据继续")
        authenticating = false
        switch result {
        case .success, .cancelled:
            // Cancelled stays locked without scolding the user.
            failureMessage = nil
        case let .failed(availability, message):
            failureMessage = availability.canAuthenticate ? message : "系统认证不可用：\(message)"
        }
    }
}
#endif
