import SwiftData
import SwiftUI

@main
struct PocketChatApp: App {
    /// Shared CloudKit-synced container so conversations follow the user across devices
    /// with no account or sign-up.
    private let modelContainer = AppModelContainer.make()

    var body: some Scene {
        WindowGroup {
            ConversationListView()
        }
        .modelContainer(modelContainer)
    }
}
