import Combine
import Foundation

/// The four root destinations frozen by SCREEN_CATALOG.md 1. The root
/// switcher only swaps between these; second-level features push inside one
/// of them and never add a fifth.
public enum RootDestination: String, Sendable, CaseIterable {
    /// 首页: 连接库、最近连接、搜索/筛选、活动摘要、同步状态.
    case home

    /// 会话: SSH/Telnet/RDP/VNC 运行会话.
    case sessions

    /// 资料: SFTP 最近文件、下载、笔记、代码片段.
    case library

    /// 工具: AI、远程批量、文件同步、服务器、备份恢复、外观、One 设置.
    case tools

    public var title: String {
        switch self {
        case .home: return "首页"
        case .sessions: return "会话"
        case .library: return "资料"
        case .tools: return "工具"
        }
    }

    public var systemImage: String {
        switch self {
        case .home: return "house"
        case .sessions: return "terminal"
        case .library: return "folder"
        case .tools: return "wrench.and.screwdriver"
        }
    }
}

/// Where the S11 editor was opened from. `nil` connection id is a create.
public struct EditorTarget: Equatable, Sendable {
    public let connectionId: String?

    public init(connectionId: String?) {
        self.connectionId = connectionId
    }
}

/// The app's only navigation authority.
///
/// Navigation is a saved value rather than a stack of closures. Two reasons,
/// both structural: a root destination replaces rather than pushes (back from
/// a root leaves the app instead of walking a history the root switcher never
/// showed), and a pushed editor carries a typed target rather than a route
/// string, so a typo is a compile error rather than a blank screen.
public final class RootNavigationModel: ObservableObject {

    @Published public var selectedRoot: RootDestination = .home

    /// The pushed editor inside the home stack, when one is open.
    @Published public var editorTarget: EditorTarget?

    /// S02 is pushed from the account menu and from the not-yet-synced empty
    /// state.
    @Published public var showsServerBinding = false

    public init() {}

    public func openEditor(connectionId: String?) {
        editorTarget = EditorTarget(connectionId: connectionId)
    }

    public func closeEditor() {
        editorTarget = nil
    }

    public func openServerBinding() {
        showsServerBinding = true
    }

    public func closeServerBinding() {
        showsServerBinding = false
    }
}
