import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(name: "com.zephyr.agent/platform", binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      if call.method == "openUrl" {
        let args = call.arguments as? [String: Any]
        guard let raw = args?["url"] as? String, let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
          result(FlutterError(code: "bad_args", message: "only http(s) urls", details: nil))
          return
        }
        UIApplication.shared.open(url, options: [:]) { ok in
          result(ok ? nil : FlutterError(code: "open_url", message: "unable to open system browser", details: nil))
        }
        return
      }
      guard call.method == "setIconTheme" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard UIApplication.shared.supportsAlternateIcons else {
        result(nil)
        return
      }
      let args = call.arguments as? [String: Any]
      let theme = ((args?["theme"] as? String) ?? "frost").lowercased()
      let iconName: String? = theme == "frost" ? nil : "ZephyrAgent_\(theme)"
      UIApplication.shared.setAlternateIconName(iconName) { error in
        result(error == nil ? nil : FlutterError(code: "icon_error", message: error?.localizedDescription, details: nil))
      }
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
