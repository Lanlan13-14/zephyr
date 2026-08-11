#if canImport(SwiftUI)
import Combine
import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The root view, and the app's only navigation authority.
///
/// Three contract shapes live here:
///
///  - S01 gates everything: while ``AppLock/state`` is locked the whole app
///    is replaced by ``LockView``, which is also what keeps decrypted content
///    out of the app-switcher snapshot path.
///  - The root switcher swaps exactly the four frozen destinations
///    (SCREEN_CATALOG.md 1). Selecting a root replaces rather than pushes, so
///    back from a root never walks a history the switcher never showed.
///  - Second-level pages (S02, S11) push inside the home stack's
///    NavigationView, which on iOS drives a UINavigationController whose
///    interactive pop gesture the platform bridge keeps enabled
///    (MOBILE_EXPERIENCE.md: 优先使用原生 interactive pop).
@MainActor
public struct ZephyrOneRootView: View {

    @ObservedObject var appLock: AppLock
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var navigation: RootNavigationModel
    @StateObject private var listViewModel: ConnectionListViewModel

    private let makeEditorViewModel: (String?) -> ConnectionEditorViewModel
    private let makeBindingViewModel: () -> ServerBindingViewModel
    private let onConnect: (Connection, Bool) -> Void

    public init(
        appLock: AppLock,
        navigation: @autoclosure @escaping () -> RootNavigationModel,
        listViewModel: @autoclosure @escaping () -> ConnectionListViewModel,
        makeEditorViewModel: @escaping (String?) -> ConnectionEditorViewModel,
        makeBindingViewModel: @escaping () -> ServerBindingViewModel,
        onConnect: @escaping (Connection, Bool) -> Void
    ) {
        self.appLock = appLock
        _navigation = StateObject(wrappedValue: navigation())
        _listViewModel = StateObject(wrappedValue: listViewModel())
        self.makeEditorViewModel = makeEditorViewModel
        self.makeBindingViewModel = makeBindingViewModel
        self.onConnect = onConnect
    }

    public var body: some View {
        Group {
            if appLock.state == .locked {
                LockView(appLock: appLock)
            } else {
                rootTabs
            }
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .background:
                appLock.onEnterBackground()
            case .active:
                appLock.onEnterForeground()
            case .inactive:
                break
            @unknown default:
                appLock.clearSensitiveMaterial()
            }
        }
        .zephyrProtectedDataLifecycle(appLock)
    }

    private var rootTabs: some View {
        TabView(selection: $navigation.selectedRoot) {
            homeRoot
                .tabItem { Label("首页", systemImage: RootDestination.home.systemImage) }
                .tag(RootDestination.home)
            placeholder(RootDestination.sessions)
                .tabItem { Label("会话", systemImage: RootDestination.sessions.systemImage) }
                .tag(RootDestination.sessions)
            placeholder(RootDestination.library)
                .tabItem { Label("资料", systemImage: RootDestination.library.systemImage) }
                .tag(RootDestination.library)
            placeholder(RootDestination.tools)
                .tabItem { Label("工具", systemImage: RootDestination.tools.systemImage) }
                .tag(RootDestination.tools)
        }
    }

    private var homeRoot: some View {
        NavigationView {
            ConnectionListView(
                viewModel: listViewModel,
                onOpenConnection: { onConnect($0, true) },
                onEditConnection: { navigation.openEditor(connectionId: $0) },
                onOpenBinding: { navigation.openServerBinding() }
            )
            .background(editorLink)
            .background(bindingLink)
        }
        .zephyrNavigationStackStyle()
    }

    /// The pushed S11 editor. `isActive` plus a typed target: a route-string
    /// typo here would be a blank screen at runtime, a wrong id type is a
    /// compile error.
    private var editorLink: some View {
        NavigationLink(
            isActive: Binding(
                get: { navigation.editorTarget != nil },
                set: { if !$0 { navigation.closeEditor() } }
            )
        ) {
            EditorContainerView(
                connectionId: navigation.editorTarget?.connectionId,
                makeViewModel: makeEditorViewModel,
                appLock: appLock,
                onConnect: onConnect
            )
            /* A new target must produce a new view identity, or the
             * StateObject inside would keep the previous row's draft. */
            .id(navigation.editorTarget?.connectionId ?? "create")
        } label: {
            EmptyView()
        }
    }

    /// The pushed S02 bind flow.
    private var bindingLink: some View {
        NavigationLink(
            isActive: Binding(
                get: { navigation.showsServerBinding },
                set: { if !$0 { navigation.closeServerBinding() } }
            )
        ) {
            ServerBindingContainerView(
                makeViewModel: makeBindingViewModel,
                appLock: appLock
            )
        } label: {
            EmptyView()
        }
    }

    /// Sessions, library and tools are root destinations whose screens are
    /// outside this package's current scope; the destination must still exist
    /// so the switcher honours the frozen four-entry contract.
    private func placeholder(_ destination: RootDestination) -> some View {
        NavigationView {
            Text("\(destination.title)（尚未实现）")
                .navigationTitle(destination.title)
        }
        .zephyrNavigationStackStyle()
    }
}

/// Owns the editor view model for the pushed editor's lifetime.
///
/// StateObject rather than a let: the destination closure of a NavigationLink
/// re-runs on every parent render, and a plain `let` would drop the in-flight
/// draft each time.
@MainActor
struct EditorContainerView: View {

    let connectionId: String?
    let makeViewModel: (String?) -> ConnectionEditorViewModel
    let appLock: AppLock
    let onConnect: (Connection, Bool) -> Void

    @StateObject private var viewModel: ConnectionEditorViewModel

    init(
        connectionId: String?,
        makeViewModel: @escaping (String?) -> ConnectionEditorViewModel,
        appLock: AppLock,
        onConnect: @escaping (Connection, Bool) -> Void
    ) {
        self.connectionId = connectionId
        self.makeViewModel = makeViewModel
        self.appLock = appLock
        self.onConnect = onConnect
        _viewModel = StateObject(wrappedValue: makeViewModel(connectionId))
    }

    var body: some View {
        ConnectionEditorView(viewModel: viewModel, onConnect: onConnect)
            .onAppear { viewModel.attachSensitiveLifecycle(to: appLock) }
            .onDisappear { viewModel.detachSensitiveLifecycle() }
    }
}

/// Keeps the binding draft and its lock registration scoped to one pushed
/// destination, matching the editor container's ownership.
@MainActor
struct ServerBindingContainerView: View {

    let makeViewModel: () -> ServerBindingViewModel
    let appLock: AppLock

    @StateObject private var viewModel: ServerBindingViewModel

    init(makeViewModel: @escaping () -> ServerBindingViewModel, appLock: AppLock) {
        self.makeViewModel = makeViewModel
        self.appLock = appLock
        _viewModel = StateObject(wrappedValue: makeViewModel())
    }

    var body: some View {
        ServerBindingView(viewModel: viewModel)
            .onAppear { viewModel.attachSensitiveLifecycle(to: appLock) }
            .onDisappear { viewModel.detachSensitiveLifecycle() }
    }
}

extension View {

    @MainActor
    @ViewBuilder
    func zephyrProtectedDataLifecycle(_ appLock: AppLock) -> some View {
        #if canImport(UIKit)
        onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.protectedDataWillBecomeUnavailableNotification
            )
        ) { _ in
            appLock.onProtectedDataUnavailable()
        }
        #else
        self
        #endif
    }

    /// Single-column navigation on iOS so the compact-column interactive pop
    /// gesture applies; a no-op on the macOS host build.
    func zephyrNavigationStackStyle() -> some View {
        #if canImport(UIKit)
        return AnyView(navigationViewStyle(.stack))
        #else
        return AnyView(self)
        #endif
    }
}
#endif
