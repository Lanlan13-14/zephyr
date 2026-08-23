#if canImport(SwiftUI)
import SwiftUI

struct ZephyrRootBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZephyrStyle.background(colorScheme).ignoresSafeArea()
    }
}

struct ZephyrRootIsland: View {
    @Binding var selection: RootDestination

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { geometry in
            let regular = geometry.size.width >= 768
            let width = min(
                geometry.size.width * (regular
                    ? ZephyrRootIslandMetrics.regularWidthRatio
                    : ZephyrRootIslandMetrics.compactWidthRatio),
                regular
                    ? ZephyrRootIslandMetrics.regularMaximumWidth
                    : ZephyrRootIslandMetrics.compactMaximumWidth
            )

            island(width: width)
                .position(x: geometry.size.width / 2, y: ZephyrRootIslandMetrics.height / 2)
        }
        .frame(height: ZephyrRootIslandMetrics.height)
        .accessibilityElement(children: .contain)
    }

    private func island(width: CGFloat) -> some View {
        let itemWidth = (width - (ZephyrRootIslandMetrics.inset * 2)) / 4
        return ZStack(alignment: .leading) {
            Capsule()
                .fill(ZephyrStyle.accent.opacity(colorScheme == .dark ? 0.16 : 0.14))
                .frame(width: itemWidth, height: ZephyrRootIslandMetrics.height - 10)
                .offset(x: ZephyrRootIslandMetrics.inset + itemWidth * CGFloat(selectionIndex))
                .animation(selectionAnimation, value: selection)

            HStack(spacing: 0) {
                ForEach(RootDestination.allCases, id: \.self) { destination in
                    islandButton(destination)
                        .frame(width: itemWidth, height: ZephyrRootIslandMetrics.height - 10)
                }
            }
            .padding(.horizontal, ZephyrRootIslandMetrics.inset)
        }
        .frame(width: width, height: ZephyrRootIslandMetrics.height)
        .zephyrGlassCapsule()
    }

    private var selectionIndex: Int {
        RootDestination.allCases.firstIndex(of: selection) ?? 0
    }

    private var selectionAnimation: Animation? {
        reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.34, dampingFraction: 1)
    }

    private func islandButton(_ destination: RootDestination) -> some View {
        let selected = selection == destination
        return Button {
            selection = destination
        } label: {
            VStack(spacing: 2) {
                Image(systemName: destination.systemImage)
                    .font(.system(size: selected
                        ? ZephyrRootIslandMetrics.selectedIconSize
                        : ZephyrRootIslandMetrics.iconSize, weight: .semibold))
                    .frame(height: selected ? 19 : 25)

                Text(destination.title)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                    .frame(height: selected ? 11 : 0)
                    .opacity(selected ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundColor(selected ? ZephyrStyle.accent : ZephyrStyle.tertiaryText(colorScheme))
            .contentShape(Capsule())
            .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: selected)
        }
        .buttonStyle(ZephyrIslandButtonStyle())
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ZephyrIslandButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct LibraryRootView: View {
    let onOpen: (LibraryDestination) -> Void

    var body: some View {
        ZephyrRootScrollView(title: RootDestination.library.title) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(LibraryDestination.allCases) { destination in
                    Button { onOpen(destination) } label: {
                        ZephyrEntryTile(
                            title: destination.title,
                            subtitle: destination.subtitle,
                            systemImage: destination.systemImage,
                            tint: tint(destination)
                        )
                    }
                    .buttonStyle(ZephyrPressButtonStyle())
                }
            }

            ZephyrSectionTitle("最近资料")
            ZephyrEmptyPanel(
                systemImage: "clock",
                title: "暂无最近资料",
                detail: "主动浏览、下载或编辑后会显示在这里"
            )
        }
    }

    private func tint(_ destination: LibraryDestination) -> Color {
        switch destination {
        case .sftp: return ZephyrStyle.sftp
        case .notes: return ZephyrStyle.warning
        case .snippets: return ZephyrStyle.accent
        case .downloads: return ZephyrStyle.success
        }
    }
}

struct ToolsRootView: View {
    let onOpen: (ToolDestination) -> Void

    var body: some View {
        ZephyrRootScrollView(title: RootDestination.tools.title) {
            toolSection("远程操作", destinations: [.remoteBatch])
            toolSection("资源", destinations: [.proxy, .sshKeys])
            toolSection("AI", destinations: [.aiAssistant])
            toolSection("Zephyr Link", destinations: [.fileSync])
            toolSection("服务器", destinations: [.server])
            toolSection("One", destinations: [.appearance, .language, .localUnlock, .diagnostics])
        }
    }

    @ViewBuilder
    private func toolSection(_ title: String, destinations: [ToolDestination]) -> some View {
        ZephyrSectionTitle(title)
        VStack(spacing: 0) {
            ForEach(destinations.indices, id: \.self) { index in
                let destination = destinations[index]
                Button { onOpen(destination) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: destination.systemImage)
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(destination == .aiAssistant ? ZephyrStyle.accent : .secondary)
                            .frame(width: 30, height: 30)
                            .background(Color.primary.opacity(0.055))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                        VStack(alignment: .leading, spacing: 2) {
                            Text(destination.title)
                                .font(.system(size: 14))
                                .foregroundColor(.primary)
                            Text(destination.subtitle)
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ZephyrPressButtonStyle())

                if index < destinations.count - 1 {
                    Divider().padding(.leading, 56)
                }
            }
        }
        .zephyrCard()
    }
}

private struct ZephyrRootScrollView<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 112)
        }
        .navigationTitle(title)
        .background(ZephyrRootBackground())
    }
}

private struct ZephyrEntryTile: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundColor(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
        .padding(.horizontal, 12)
        .zephyrCard()
    }
}

struct ZephyrSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 4)
            .padding(.top, 22)
            .padding(.bottom, 10)
    }
}

struct ZephyrEmptyPanel: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundColor(.secondary)
            Text(title).font(.headline)
            Text(detail)
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .zephyrCard()
    }
}

#endif
