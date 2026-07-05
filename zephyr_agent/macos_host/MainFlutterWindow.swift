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
