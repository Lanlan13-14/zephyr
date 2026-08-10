#if canImport(SwiftUI)
import SwiftUI

#if canImport(UIKit)
import UIKit

/// Keeps the UIKit interactive pop gesture alive for pushed screens.
///
/// MOBILE_EXPERIENCE.md freezes edge swipe-back as the one true back gesture
/// for pushed pages: every push must support a 1:1, cancellable drag from the
/// left edge. SwiftUI's NavigationView drives a UINavigationController whose
/// interactivePopGestureRecognizer does exactly that, and this bridge's whole
/// job is to make sure it stays enabled. It deliberately does NOT install a
/// gesture delegate, hide the system back button, or overlay a custom
/// full-screen drag: all three are named in the same document as ways to
/// accidentally break the gesture.
struct InteractivePopGestureBridge: UIViewControllerRepresentable {

    func makeUIViewController(context: Context) -> PopGestureBridgeController {
        PopGestureBridgeController()
    }

    func updateUIViewController(_ uiViewController: PopGestureBridgeController, context: Context) {}
}

final class PopGestureBridgeController: UIViewController {

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        enableInteractivePop()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        enableInteractivePop()
    }

    private func enableInteractivePop() {
        var node: UIViewController? = parent
        while let current = node {
            if let navigation = current as? UINavigationController {
                navigation.interactivePopGestureRecognizer?.isEnabled = true
                return
            }
            node = current.parent
        }
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }
}
#endif

extension View {

    /// iOS: attaches the pop-gesture bridge. macOS: no-op. The host build
    /// compiles the views without UIKit, so the UIKit half lives behind
    /// `canImport(UIKit)` and the macOS compiler only ever sees `AnyView(self)`.
    func zephyrInteractivePopGesture() -> some View {
        #if canImport(UIKit)
        return AnyView(background(InteractivePopGestureBridge()))
        #else
        return AnyView(self)
        #endif
    }

    /// Large-title navigation bars are an iOS convention; the macOS compile of
    /// the same view must not reference the UIKit-only modifier.
    func zephyrInlineTitle() -> some View {
        #if canImport(UIKit)
        return AnyView(navigationBarTitleDisplayMode(.inline))
        #else
        return AnyView(self)
        #endif
    }
}

extension ToolbarItemPlacement {
    /// .navigationBarLeading is iOS-only; the macOS host compile of the same
    /// views must use a placement the platform understands.
    static var zephyrNavLeading: ToolbarItemPlacement {
        #if canImport(UIKit)
        return .navigationBarLeading
        #else
        return .automatic
        #endif
    }

    /// .navigationBarTrailing is iOS-only; the macOS host compile of the same
    /// views must use a placement the platform understands.
    static var zephyrNavTrailing: ToolbarItemPlacement {
        #if canImport(UIKit)
        return .navigationBarTrailing
        #else
        return .automatic
        #endif
    }
}
#endif
