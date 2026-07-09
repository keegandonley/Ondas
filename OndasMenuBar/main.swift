import AppKit

// Entry point for the menu-bar agent. `.accessory` activation = no Dock icon / no menu bar of its
// own (equivalent to LSUIElement), so it lives only as a status item. The agent runs in its own
// process alongside the Catalyst app and shares its SwiftData store via the App Group.
let application = NSApplication.shared
let delegate = MenuBarAgentDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
