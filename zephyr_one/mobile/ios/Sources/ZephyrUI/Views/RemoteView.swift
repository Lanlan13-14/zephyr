#if canImport(SwiftUI)
import SwiftUI

/// Demo `#page-rdp` / `#page-vnc` chrome around the remote surface.
///
/// The pixel engine is still a separate track, so the framebuffer itself is
/// an honest placeholder. The operation chrome — status pill, tools ball,
/// top strip, back button — matches the demo page rather than a system
/// navigation bar.
@MainActor
public struct RemoteView: View {

    @ObservedObject var viewModel: RemoteViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showCertificate = false
    @State private var showShortcuts = false

    public init(viewModel: RemoteViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        content
            .zephyrNavigationBarHidden(true)
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
            .confirmationDialog(
                "常用快捷键",
                isPresented: $showShortcuts,
                titleVisibility: .visible
            ) {
                ForEach(RdpShortcut.allCases, id: \.self) { shortcut in
                    Button(shortcut.label) { viewModel.sendShortcut(shortcut) }
                }
                Button("取消", role: .cancel) {}
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
            .onChange(of: viewModel.event) { event in
                guard let event else { return }
                switch event {
                case .closed, .minimised:
                    viewModel.consumeEvent()
                    dismiss()
                case .openChrome(.shortcuts):
                    viewModel.consumeEvent()
                    showShortcuts = true
                case .openChrome:
                    viewModel.consumeEvent()
                }
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
        ZStack {
            Color.black.ignoresSafeArea()
            VStack {
                Spacer()
                Image(systemName: isRdp ? "display" : "display.2")
                    .font(.largeTitle)
                    .foregroundStyle(.white)
                Text(remoteEngineMessage(value))
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(statusLine(value))
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal)
                if value.status.hasSurface {
                    Text("\(value.status.remoteWidthPx) × \(value.status.remoteHeightPx)")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.8))
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onTapGesture { viewModel.toggleToolbar() }

            VStack {
                HStack {
                    statusPill(value)
                    Spacer()
                }
                .padding(.leading, 10)
                .padding(.top, 10)
                if viewModel.toolbarVisible {
                    toolsPanel(value)
                        .padding(.horizontal, 8)
                }
                Spacer()
            }

            VStack {
                Spacer()
                HStack {
                    Button(action: { viewModel.minimise() }) {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(Color(red: 0.86, green: 0.89, blue: 0.92))
                            .frame(width: 40, height: 40)
                            .background(Color.black.opacity(0.6))
                            .clipShape(Circle())
                    }
                    Spacer()
                }
                .padding(.leading, 10)
                .padding(.bottom, 14)
            }

            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button(action: { viewModel.toggleToolbar() }) {
                        Image(systemName: "square.grid.2x2")
                            .foregroundStyle(Color(red: 0.90, green: 0.92, blue: 0.94))
                            .frame(width: 44, height: 44)
                            .background(Color(red: 0.08, green: 0.09, blue: 0.12).opacity(0.62))
                            .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 1))
                            .clipShape(Circle())
                    }
                    .padding(.trailing, 10)
                    .offset(y: -40)
                }
                Spacer()
            }
        }
        .onAppear {
            viewModel.load()
            viewModel.connect()
        }
    }

    private func statusPill(_ value: RemoteContent) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(value.status.hasSurface ? Color.green : Color.orange)
                .frame(width: 9, height: 9)
            Text(compactStatus(value))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color(red: 0.86, green: 0.89, blue: 0.92))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.6))
        .clipShape(Capsule())
    }

    private func compactStatus(_ value: RemoteContent) -> String {
        if value.status.phase.isProgressing || !value.status.hasSurface {
            return statusLine(value)
        }
        let size = value.status.remoteWidthPx > 0
            ? "\(value.status.remoteWidthPx)×\(value.status.remoteHeightPx)"
            : "-"
        let latency = value.status.latencyMs.map { "\($0) ms" } ?? "-"
        let fps = value.status.fps.map { "\($0)FPS" } ?? "30FPS"
        return [latency, size, fps].joined(separator: " · ")
    }

    private func remoteEngineMessage(_ value: RemoteContent) -> String {
        if value.status.phase.isProgressing { return "正在连接…" }
        if value.status.hasSurface { return "已连接，等待原生引擎接入后显示画面" }
        return isRdp ? "本构建未打包 FreeRDP 原生库" : "VNC 引擎尚未接入"
    }

    private func statusLine(_ value: RemoteContent) -> String {
        let phase = value.status.phase.label
        if value.status.attempt > 1 { return phase + "（第 \(value.status.attempt) 次尝试）" }
        return phase
    }

    private func toolsPanel(_ value: RemoteContent) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(value.chrome, id: \.self) { item in
                    Button {
                        viewModel.onChrome(item)
                    } label: {
                        VStack(spacing: 5) {
                            Image(systemName: chromeImage(item))
                                .font(.system(size: 16))
                            Text(item.title)
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(item == .disconnect ? Color(red: 1, green: 0.48, blue: 0.45) : Color(red: 0.76, green: 0.80, blue: 0.84))
                        .frame(width: 56)
                        .padding(.vertical, 6)
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
        }
        .background(Color(red: 0.07, green: 0.09, blue: 0.11).opacity(0.78))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private func chromeImage(_ item: RemoteChromeItem) -> String {
        switch item {
        case .keyboard: return "keyboard"
        case .pointerMode: return "cursorarrow"
        case .zoom: return "plus.magnifyingglass"
        case .fit: return "arrow.up.left.and.arrow.down.right"
        case .clipboard: return "doc.on.clipboard"
        case .resolution: return "display"
        case .quality, .vncQuality, .shortcuts: return "bolt.fill"
        case .fps: return "chart.bar"
        case .fileDrive: return "externaldrive"
        case .joystick: return "gamecontroller"
        case .cad: return "lock.shield"
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
