import Combine
import Foundation

/// The four root destinations frozen by SCREEN_CATALOG.md 1. The root
/// switcher only swaps between these; second-level features push inside one
/// of them and never add a fifth.
public enum RootDestination: String, Sendable, CaseIterable, Hashable {
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
        case .tools: return "square.grid.2x2"
        }
    }
}

/// Concrete destinations surfaced by the S30 library root.
///
/// The owning host supplies the destination view because file providers,
/// notes and download managers live outside ZephyrUI. Keeping these typed
/// prevents a visible root row from becoming a string route or a no-op.
public enum LibraryDestination: String, Sendable, CaseIterable, Identifiable, Hashable {
    case sftp
    case notes
    case snippets
    case downloads

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .sftp: return "文件 SFTP"
        case .notes: return "笔记"
        case .snippets: return "代码片段"
        case .downloads: return "下载"
        }
    }

    public var subtitle: String {
        switch self {
        case .sftp: return "浏览服务器文件"
        case .notes: return "运维记录与 Markdown"
        case .snippets: return "可复用命令与脚本"
        case .downloads: return "传输进度与历史"
        }
    }

    public var systemImage: String {
        switch self {
        case .sftp: return "doc"
        case .notes: return "note.text"
        case .snippets: return "bolt"
        case .downloads: return "arrow.down.circle"
        }
    }
}

/// Concrete destinations surfaced by the S40 tools root.
public enum ToolDestination: String, Sendable, CaseIterable, Identifiable, Hashable {
    case remoteBatch
    case proxy
    case sshKeys
    case aiAssistant
    case fileSync
    case clientToken
    case server
    case appearance
    case language
    case localUnlock
    case diagnostics

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .remoteBatch: return "远程批量"
        case .proxy: return "Proxy"
        case .sshKeys: return "SSH Key"
        case .aiAssistant: return "AI 助理"
        case .fileSync: return "Zephyr Link"
        case .clientToken: return "Client Token"
        case .server: return "服务器"
        case .appearance: return "外观"
        case .language: return "语言"
        case .localUnlock: return "本地解锁"
        case .diagnostics: return "关于与诊断"
        }
    }

    public var subtitle: String {
        switch self {
        case .remoteBatch: return "多主机执行与任务状态"
        case .proxy: return "代理资源"
        case .sshKeys: return "密钥与指纹"
        case .aiAssistant: return "模型、权限与协作模式"
        case .fileSync: return "目录、间隔与同步状态"
        case .clientToken: return "查看与旋转凭据"
        case .server: return "设置、备份与恢复"
        case .appearance: return "Frost 与显示设置"
        case .language: return "跟随系统"
        case .localUnlock: return "生物识别与锁定策略"
        case .diagnostics: return "版本、许可与日志导出"
        }
    }

    public var systemImage: String {
        switch self {
        case .remoteBatch: return "bolt"
        case .proxy: return "globe"
        case .sshKeys: return "key"
        case .aiAssistant: return "sparkles"
        case .fileSync: return "arrow.triangle.2.circlepath"
        case .clientToken: return "ticket"
        case .server: return "server.rack"
        case .appearance: return "paintpalette"
        case .language: return "character.bubble"
        case .localUnlock: return "lock"
        case .diagnostics: return "waveform.path.ecg"
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
