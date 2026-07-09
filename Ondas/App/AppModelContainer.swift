import Foundation
import SwiftData

/// Builds the app-wide `ModelContainer`, configured for CloudKit's automatic database so
/// conversations and messages sync across the user's devices with no account or sign-up —
/// the user is already signed into iCloud on the device.
///
/// All `@Model` types deliberately avoid `@Attribute(.unique)` and give every stored
/// property a default value, which are hard requirements for a CloudKit-backed SwiftData
/// store.
enum AppModelContainer {
    private static let models: [any PersistentModel.Type] = [
        Conversation.self,
        ChatMessage.self,
        GeneratedImage.self,
    ]

    static let schema = Schema(models)

    private static func buildContainer(inMemory: Bool, cloudKit: Bool) throws -> ModelContainer {
        // The shared App Group container only applies on macOS/Catalyst, where the menu-bar agent
        // opens the *same* store. iOS has no agent — and can't carry the App Group entitlement through
        // App Store signing — so it keeps the store in the app's own default container, as before.
        // (On macOS this is a store-LOCATION change from earlier builds; SwiftData doesn't migrate
        // across container boundaries, but the store is CloudKit-mirrored so existing conversations
        // re-sync down from iCloud into the new container — allow a moment on first launch.)
        let groupContainer: ModelConfiguration.GroupContainer
        #if targetEnvironment(macCatalyst) || os(macOS)
        groupContainer = inMemory ? .none : .identifier(AppInfo.appGroupID)
        #else
        groupContainer = .none
        #endif
        let configuration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            groupContainer: groupContainer,
            // Only ONE process mirrors to CloudKit — the always-running app. The agent opens the
            // shared store local-only (it only runs while the app does), so writes from either side
            // reach the store via persistent history and the app mirrors them; two concurrent
            // mirrors on one store/zone would fight. In-memory never touches CloudKit.
            //
            // Known cross-process limitation (accepted for now): the CloudKit container observes
            // store changes and refreshes its `@Query`s, so the app picks up the agent's writes; the
            // agent (local-only, no such observation) may not reflect the app's newest chats until
            // its popover process is relaunched. And `Conversation.reuseEmptyOrCreate` from both
            // processes on stale snapshots can, rarely, create two empty "New Chat" rows (harmless —
            // empties converge on reuse). A shared-store remote-change observer is the follow-up.
            cloudKitDatabase: (inMemory || !cloudKit) ? .none : .automatic
        )
        return try ModelContainer(for: schema, configurations: [configuration])
    }

    /// Non-throwing build for the interactive app and previews. A failure here is unrecoverable and
    /// visible to the user, so crash deliberately rather than silently substitute an ephemeral store
    /// that would discard their chat history. (The headless agent uses `makeThrowing` instead.)
    ///
    /// - Parameter cloudKit: whether this process mirrors the store to CloudKit. The app passes
    ///   `true` (the sole mirror); the agent passes `false` (shares the store, doesn't mirror).
    static func make(inMemory: Bool = false, cloudKit: Bool = true) -> ModelContainer {
        do {
            return try buildContainer(inMemory: inMemory, cloudKit: cloudKit)
        } catch {
            fatalError("Failed to initialize the persistent SwiftData store: \(error)")
        }
    }

    /// Throwing build for the headless menu-bar agent, where a `fatalError` would just make the
    /// status item silently never appear. The agent handles the failure itself (logs + quits, and
    /// retries the first-launch window where the app may be creating the shared store concurrently).
    static func makeThrowing(inMemory: Bool = false, cloudKit: Bool = true) throws -> ModelContainer {
        try buildContainer(inMemory: inMemory, cloudKit: cloudKit)
    }
}
