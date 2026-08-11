#if canImport(SwiftUI)
import SwiftUI

#if canImport(UIKit)
import UIKit

/// Configures the UIKit interactive pop gesture for pushed screens.
///
/// MOBILE_EXPERIENCE.md freezes edge swipe-back as the one true back gesture
/// for pushed pages: every push must support a 1:1, cancellable drag from the
/// left edge. SwiftUI's NavigationView drives a UINavigationController whose
/// interactivePopGestureRecognizer does exactly that. A dirty editor is the
/// deliberate exception: UIKit cannot pause a committed pop for an async
/// confirmation, so that screen disables the recognizer and presents an
/// explicit native back action instead. The bridge never replaces a gesture
/// or navigation delegate and never overlays a custom drag.
struct InteractivePopGestureBridge: UIViewControllerRepresentable {

    let isEnabled: Bool

    func makeUIViewController(context: Context) -> PopGestureBridgeController {
        let controller = PopGestureBridgeController()
        controller.setInteractivePopEnabled(isEnabled)
        return controller
    }

    func updateUIViewController(_ uiViewController: PopGestureBridgeController, context: Context) {
        uiViewController.setInteractivePopEnabled(isEnabled)
    }
}

final class PopGestureBridgeController: UIViewController {

    private var isInteractivePopEnabled = true

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        applyInteractivePopState()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applyInteractivePopState()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // UINavigationController updates recognizers during a transition.
        // Reapply after the push completes so a dirty editor stays protected.
        applyInteractivePopState()
    }

    func setInteractivePopEnabled(_ isEnabled: Bool) {
        isInteractivePopEnabled = isEnabled
        applyInteractivePopState()
    }

    private func applyInteractivePopState() {
        guard let navigation = enclosingNavigationController(),
              isContained(in: navigation.topViewController) else {
            return
        }
        navigation.interactivePopGestureRecognizer?.isEnabled = isInteractivePopEnabled
    }

    private func enclosingNavigationController() -> UINavigationController? {
        var node: UIViewController? = parent
        while let current = node {
            if let navigation = current as? UINavigationController {
                return navigation
            }
            node = current.parent
        }
        return navigationController
    }

    private func isContained(in ancestor: UIViewController?) -> Bool {
        var node: UIViewController? = self
        while let current = node {
            if current === ancestor {
                return true
            }
            node = current.parent
        }
        return false
    }
}
#endif

extension View {

    /// iOS: attaches the pop-gesture bridge. macOS: no-op. The host build
    /// compiles the views without UIKit, so the UIKit half lives behind
    /// `canImport(UIKit)` and the macOS compiler only ever sees `AnyView(self)`.
    func zephyrInteractivePopGesture(isEnabled: Bool = true) -> some View {
        #if canImport(UIKit)
        return AnyView(background(InteractivePopGestureBridge(isEnabled: isEnabled)))
        #else
        return AnyView(self)
        #endif
    }

    /// Only a dirty editor replaces the uninterruptible system back item with
    /// an explicit toolbar action. Other pushed screens retain native back.
    func zephyrNavigationBackButtonHidden(_ hidden: Bool) -> some View {
        #if canImport(UIKit)
        return AnyView(navigationBarBackButtonHidden(hidden))
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
