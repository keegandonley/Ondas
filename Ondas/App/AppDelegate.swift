#if targetEnvironment(macCatalyst)
import OSLog
import ServiceManagement
import UIKit

/// Registers and starts the macOS menu-bar agent while the Catalyst app runs, and stops it on
/// quit — so the menu-bar item exists only while the app is running. The agent is an embedded
/// login-item helper (`Contents/Library/LoginItems/OndasMenuBar.app`); `SMAppService` is the
/// sandbox-sanctioned way to launch it. Catalyst only — iPhone/iPad have no menu bar.
final class AppDelegate: NSObject, UIApplicationDelegate {
    private let logger = Logger(subsystem: AppInfo.bundleID, category: "MenuBarAgent")
    private var agentService: SMAppService {
        SMAppService.loginItem(identifier: AppInfo.menuBarAgentBundleID)
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Register the agent as a login item so the system knows/trusts it (and LaunchServices can
        // resolve its URL scheme), then launch it for THIS session. `SMAppService.loginItem` only
        // guarantees a launch at login, so we start it explicitly below.
        //
        // Register only when it isn't already enabled: re-registering each launch can retrigger the
        // system "background item added" notice. We deliberately do NOT unregister on quit — that
        // register/unregister churn would also retrigger that notice every launch. The agent instead
        // self-terminates when it sees the app quit, and quits at login if the app isn't running, so
        // it's effectively "alive only while the app runs" without touching registration each time.
        let service = agentService
        if service.status != .enabled {
            do {
                try service.register()
            } catch {
                logger.error("Failed to register the menu-bar agent: \(error, privacy: .public)")
            }
        }
        launchAgent()
        return true
    }

    /// Launches the agent immediately by opening its URL scheme. A sandboxed Catalyst app can't use
    /// `NSWorkspace` to launch a helper, but it can open a URL, which LaunchServices routes to the
    /// agent (a no-op if it's already running).
    private func launchAgent() {
        guard let url = URL(string: "ondas-menubar://open") else { return }
        UIApplication.shared.open(url, options: [:]) { [logger] opened in
            if !opened {
                logger.error("Could not launch the menu-bar agent via its URL scheme.")
            }
        }
    }
}
#endif
