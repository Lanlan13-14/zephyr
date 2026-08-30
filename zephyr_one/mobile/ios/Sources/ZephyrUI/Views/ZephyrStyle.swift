#if canImport(SwiftUI)
import SwiftUI

enum ZephyrRootIslandMetrics {
    static let compactWidthRatio: CGFloat = 0.88
    static let compactMaximumWidth: CGFloat = 340
    static let regularWidthRatio: CGFloat = 0.42
    static let regularMaximumWidth: CGFloat = 360
    static let height: CGFloat = 62
    static let outerRadius: CGFloat = 31
    static let inset: CGFloat = 5
    static let itemRadius: CGFloat = 26
    static let bottomSpacing: CGFloat = 18
    static let selectedIconSize: CGFloat = 17
    static let iconSize: CGFloat = 23
}

enum ZephyrStyle {
    static let accent = Color(red: 10 / 255, green: 132 / 255, blue: 1)
    static let pending = Color(red: 100 / 255, green: 210 / 255, blue: 1)
    static let conflict = Color(red: 1, green: 159 / 255, blue: 10 / 255)
    static let success = Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255)
    static let warning = Color(red: 1, green: 214 / 255, blue: 10 / 255)
    static let danger = Color(red: 1, green: 69 / 255, blue: 58 / 255)
    static let sftp = Color(red: 100 / 255, green: 210 / 255, blue: 1)

    static func background(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 10 / 255, green: 12 / 255, blue: 15 / 255)
            : Color(red: 238 / 255, green: 240 / 255, blue: 244 / 255)
    }

    static func surface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 19 / 255, green: 22 / 255, blue: 27 / 255)
            : Color(red: 247 / 255, green: 248 / 255, blue: 250 / 255)
    }

    static func elevated(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 27 / 255, green: 31 / 255, blue: 38 / 255)
            : .white
    }

    static func secondaryText(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 154 / 255, green: 164 / 255, blue: 176 / 255)
            : Color(red: 91 / 255, green: 101 / 255, blue: 112 / 255)
    }

    static func tertiaryText(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 93 / 255, green: 103 / 255, blue: 115 / 255)
            : Color(red: 119 / 255, green: 129 / 255, blue: 140 / 255)
    }

    static func separator(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.06)
    }
}

struct ZephyrCardModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .background(ZephyrStyle.surface(colorScheme))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct ZephyrGlassCapsuleModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular, in: Capsule())
        } else {
            fallback(content)
        }
        #else
        fallback(content)
        #endif
    }

    private func fallback(_ content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    Capsule().fill(ZephyrStyle.elevated(colorScheme).opacity(0.98))
                } else {
                    Capsule().fill(.ultraThinMaterial)
                }
            }
            .overlay {
                Capsule()
                    .stroke(
                        colorScheme == .dark ? Color.white.opacity(0.08) : Color.white.opacity(0.72),
                        lineWidth: 1
                    )
            }
            .shadow(
                color: Color.black.opacity(colorScheme == .dark ? 0.45 : 0.16),
                radius: colorScheme == .dark ? 18 : 14,
                x: 0,
                y: 8
            )
    }
}

struct ZephyrPressButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension View {
    func zephyrCard() -> some View {
        modifier(ZephyrCardModifier())
    }

    func zephyrGlassCapsule() -> some View {
        modifier(ZephyrGlassCapsuleModifier())
    }
}
#endif
