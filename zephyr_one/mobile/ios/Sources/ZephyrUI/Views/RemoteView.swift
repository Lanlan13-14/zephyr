#if canImport(SwiftUI)
import SwiftUI

/// S22 RDP / S23 VNC 会话.
///
/// The remote surface is an honest placeholder: the pixel engine is a
/// separate blocked track, so this renders the chrome toolbar, the phase
/// status, the certificate gate and the permission channels while reporting
/// the engine's absence instead of faking a screen. Every decision routes
/// through ``RemoteViewModel``.
@MainActor
public struct RemoteView: View {

    @ObservedObject var viewModel: RemoteViewModel

    @State private var showCertificate = false

    public init(viewModel: RemoteViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        content
            .navigationTitle(viewModel.page.contentValue?.connection.name ?? (isRdp ? "RDP" : "VNC"))
            .zephyrInlineTitle()
            .toolbar {
                ToolbarItem(placement: .zephyrNavLeading) {
                    Button("会话列表") { viewModel.minimise() }
                }
                ToolbarItem(placement: .zephyrNavTrailing) {
                    Button("断开") { viewModel.disconnect() }
                }
            }
            .confirmationDialog(
                "证书确认",
                isPresented: $showCertificate,
                titleVisibility: .visible
            ) {
                Button("信任该证书") { viewModel.trustCertificate() }
                Button("拒绝", role: .destructive) { viewModel.rejectCertificate() }
                Button("取消", role: .cancel) {}
            } message: {
                Text(certificateMessage)
            }
            .alert(
                "提示",
                isPresented: Binding(
                    get: { viewModel.message != nil },
                    set: { if !$0 { viewModel.consumeMessage() } }
                )
            ) {
                Button("好", role: .cancel) {}
            } message: {
                Text(viewModel.message ?? "")
            }
            .onChange(of: viewModel.page) { _ in
                showCertificate = viewModel.page.contentValue?.certificate != nil
            }
    }

    private var isRdp: Bool {
        viewModel.page.contentValue?.connection.`protocol` == .rdp
    }

    private var certificateMessage: String {
        guard let cert = viewModel.page.contentValue?.certificate else { return "" }
        let change = cert.changed ? "证书指纹与上次不同，默认阻断。" : "该服务器尚未被本机信任。"
        return change + "指纹 SHA-256：" + cert.sha256
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.page {
        case .initialLoading:
            ProgressView("正在载入会话…")
        case let .content(value, _, _, _):
            surface(value)
        case .notFoundOrRevoked:
            Text("会话权限已撤销或已不存在")
        case let .permissionDenied(_, reason):
            Text(reason ?? "无使用权限")
        case let .retryableError(error):
            errorView(error)
        case let .fatalIncompatible(error):
            errorView(error)
        case .empty, .offlineWithCache, .offlineNoCache:
            EmptyView()
        }
    }

    private func surface(_ value: RemoteContent) -> some View {
        VStack(spacing: 0) {
            if let disclosure = value.disclosure {
                Text(disclosure)
                    .font(.footnote)
                    .padding(4)
            }
            VStack {
                Spacer()
                Image(systemName: isRdp ? "display" : "display.2")
                    .font(.largeTitle)
                Text(remoteEngineMessage(value))
                    .font(.headline)
                Text(statusLine(value))
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                if value.status.hasSurface {
                    Text("\(value.status.remoteWidthPx) × \(value.status.remoteHeightPx)")
                        .font(.footnote)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onTapGesture {
                viewModel.toggleToolbar()
            }

            if viewModel.toolbarVisible {
                chrome(value)
            }
        }
        .onAppear {
            viewModel.load()
        }
    }

    private func remoteEngineMessage(_ value: RemoteContent) -> String {
        if value.status.phase.isProgressing { return "正在连接…" }
        if value.status.hasSurface { return "已连接，等待原生引擎接入后显示画面" }
        return isRdp ? "RDP 引擎尚未接入" : "VNC 引擎尚未接入"
    }

    private func statusLine(_ value: RemoteContent) -> String {
        let phase = value.status.phase.label
        if value.status.attempt > 1 { return phase + "（第 \(value.status.attempt) 次尝试）" }
        return phase
    }

    private func chrome(_ value: RemoteContent) -> some View {
        HStack {
            ForEach(value.chrome, id: \.self) { item in
                Button {
                    viewModel.onChrome(item)
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: chromeImage(item))
                        Text(item.title)
                            .font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func chromeImage(_ item: RemoteChromeItem) -> String {
        switch item {
        case .keyboard: return "keyboard"
        case .pointerMode: return "cursorarrow"
        case .zoom: return "plus.magnifyingglass"
        case .clipboard: return "doc.on.clipboard"
        case .sound: return "speaker.wave.2"
        case .resolution: return "rectangle.arrowtriangle.2.inward"
        case .quality: return "wand.and.stars"
        case .fileDrive: return "externaldrive"
        case .certificate: return "lock.shield"
        case .reconnect: return "arrow.clockwise"
        case .disconnect: return "xmark.circle"
        }
    }

    private func errorView(_ error: MobileError) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
            Text(error.message)
            Text(error.diagnosticText())
                .font(.footnote)
            if error.retryable || error.isRegistryRetryable {
                Button("重试连接") { viewModel.connect() }
            }
        }
        .padding()
    }
}

extension PageState where Value == RemoteContent {
    fileprivate var contentValue: RemoteContent? {
        if case let .content(value, _, _, _) = self { return value }
        return nil
    }
}
#endif
