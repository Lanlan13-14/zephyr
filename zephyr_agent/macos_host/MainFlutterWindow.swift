import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    let channel = FlutterMethodChannel(name: "com.zephyr.agent/platform", binaryMessenger: flutterViewController.engine.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      if call.method == "openUrl" {
        let args = call.arguments as? [String: Any]
        guard let raw = args?["url"] as? String, let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
          result(FlutterError(code: "bad_args", message: "only http(s) urls", details: nil))
          return
        }
        let ok = NSWorkspace.shared.open(url)
        result(ok ? nil : FlutterError(code: "open_url", message: "unable to open system browser", details: nil))
        return
      }
      guard call.method == "setIconTheme" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let args = call.arguments as? [String: Any]
      let theme = (args?["theme"] as? String) ?? "frost"
      let candidates = [
        "Frameworks/App.framework/Resources/flutter_assets/assets/icons/zephyr-agent-\(theme).png",
        "flutter_assets/assets/icons/zephyr-agent-\(theme).png"
      ]
      for rel in candidates {
        let path = Bundle.main.bundlePath + "/Contents/" + rel
        if let img = NSImage(contentsOfFile: path) {
          NSApplication.shared.applicationIconImage = img
          result(nil)
          return
        }
      }
      result(nil)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
