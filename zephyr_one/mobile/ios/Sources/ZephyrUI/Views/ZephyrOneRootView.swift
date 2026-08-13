#if canImport(SwiftUI)
import Combine
import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Host-owned connection operations that ZephyrUI can gate and present but
/// cannot execute without protocol engines or share-sheet composition.
public struct ConnectionHostActions {
    public let duplicate: (Connection) -> Void
    public let test: (Connection) -> Void
    public let share: (Connection) -> Void

    public init(
        duplicate: @escaping (Connection) -> Void,
        test: @escaping (Connection) -> Void,
        share: @escaping (Connection) -> Void
    ) {
        self.duplicate = duplicate
        self.test = test
        self.share = share
    }
}

/// Native session destinations are composed by the app host because the
/// terminal and remote engines own their view lifetimes.
public struct SessionHostActions {
    public let openTerminal: (String, String) -> Void
    public let openRemote: (String, String) -> Void
    public let reconnect: (String, String, ConnectionProtocol) -> Void
    public let showDetails: (String) -> Void

    public init(
        openTerminal: @escaping (String, String) -> Void,
        openRemote: @escaping (String, String) -> Void,
        reconnect: @escaping (String, String, ConnectionProtocol) -> Void,
        showDetails: @escaping (String) -> Void
    ) {
        self.openTerminal = openTerminal
        self.openRemote = openRemote
        self.reconnect = reconnect
        self.showDetails = showDetails
    }
}

/// Routes whose dependencies live outside ZephyrUI.
public struct FeatureHostActions {
    public let openLibrary: (LibraryDestination) -> Void
    public let openTool: (ToolDestination) -> Void

    public init(
        openLibrary: @escaping (LibraryDestination) -> Void,
        openTool: @escaping (ToolDestination) -> Void
    ) {
        self.openLibrary = openLibrary
        self.openTool = openTool
    }
}

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
    @StateObject private var sessionViewModel: SessionListViewModel

    private let makeEditorViewModel: (String?) -> ConnectionEditorViewModel
    private let makeBindingViewModel: () -> ServerBindingViewModel
    private let onConnect: (Connection, Bool) -> Void
    private let connectionActions: ConnectionHostActions
    private let sessionActions: SessionHostActions
    private let featureActions: FeatureHostActions

    public init(
        appLock: AppLock,
        navigation: @autoclosure @escaping () -> RootNavigationModel,
        listViewModel: @autoclosure @escaping () -> ConnectionListViewModel,
        sessionViewModel: @autoclosure @escaping () -> SessionListViewModel,
        makeEditorViewModel: @escaping (String?) -> ConnectionEditorViewModel,
        makeBindingViewModel: @escaping () -> ServerBindingViewModel,
        onConnect: @escaping (Connection, Bool) -> Void,
        connectionActions: ConnectionHostActions,
        sessionActions: SessionHostActions,
        featureActions: FeatureHostActions
    ) {
        self.appLock = appLock
        _navigation = StateObject(wrappedValue: navigation())
        _listViewModel = StateObject(wrappedValue: listViewModel())
        _sessionViewModel = StateObject(wrappedValue: sessionViewModel())
        self.makeEditorViewModel = makeEditorViewModel
        self.makeBindingViewModel = makeBindingViewModel
        self.onConnect = onConnect
        self.connectionActions = connectionActions
        self.sessionActions = sessionActions
        self.featureActions = featureActions
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
        ZStack(alignment: .bottom) {
            rootLayer(homeRoot, destination: .home)
            rootLayer(sessionsRoot, destination: .sessions)
            rootLayer(libraryRoot, destination: .library)
            rootLayer(toolsRoot, destination: .tools)

            if showsRootIsland {
                ZephyrRootIsland(selection: $navigation.selectedRoot)
                    .padding(.bottom, ZephyrRootIslandMetrics.bottomSpacing)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(10)
            }
        }
        .background(ZephyrRootBackground())
        .animation(.spring(response: 0.34, dampingFraction: 0.88), value: showsRootIsland)
    }

    private var showsRootIsland: Bool {
        navigation.editorTarget == nil && !navigation.showsServerBinding
    }

    private func rootLayer<Content: View>(
        _ content: Content,
        destination: RootDestination
    ) -> some View {
        content
            .opacity(navigation.selectedRoot == destination ? 1 : 0)
            .allowsHitTesting(navigation.selectedRoot == destination)
            .accessibilityHidden(navigation.selectedRoot != destination)
            .zIndex(navigation.selectedRoot == destination ? 1 : 0)
    }

    private var homeRoot: some View {
        NavigationView {
            ConnectionListView(
                viewModel: listViewModel,
                onOpenConnection: { onConnect($0, true) },
                onEditConnection: { navigation.openEditor(connectionId: $0) },
                onOpenBinding: { navigation.openServerBinding() },
                onDuplicateConnection: connectionActions.duplicate,
                onTestConnection: connectionActions.test,
                onShareConnection: connectionActions.share
            )
            .background(editorLink)
            .background(bindingLink)
        }
        .zephyrNavigationStackStyle()
    }

    private var sessionsRoot: some View {
        NavigationView {
            SessionListView(
                viewModel: sessionViewModel,
                onOpenTerminal: sessionActions.openTerminal,
                onOpenRemote: sessionActions.openRemote,
                onReconnect: sessionActions.reconnect,
                onDetails: sessionActions.showDetails
            )
        }
        .zephyrNavigationStackStyle()
    }

    private var libraryRoot: some View {
        NavigationView {
            LibraryRootView(onOpen: featureActions.openLibrary)
        }
        .zephyrNavigationStackStyle()
    }

    private var toolsRoot: some View {
        NavigationView {
            ToolsRootView(onOpen: featureActions.openTool)
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
