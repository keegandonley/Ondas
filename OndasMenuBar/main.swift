import AppKit

// Refuse to start if another menu-bar agent is already running. Two launch triggers can fire in the
// same session — the SMAppService login item (at login) and the app opening `ondas-menubar://` —
// and macOS does not de-duplicate a background `.accessory` app across them, so this guard is what
// keeps a single menu-bar icon. Exit silently before creating any UI when we lose the race.
guard SingleInstanceGuard.acquireLock() else {
    exit(EXIT_SUCCESS)
}

// Entry point for the menu-bar agent. `.accessory` activation = no Dock icon / no menu bar of its
// own (equivalent to LSUIElement), so it lives only as a status item. The agent runs in its own
// process alongside the Catalyst app and shares its SwiftData store via the App Group.
let application = NSApplication.shared
let delegate = MenuBarAgentDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
