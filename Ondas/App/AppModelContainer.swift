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

    private static func buildContainer(inMemory: Bool) throws -> ModelContainer {
        let configuration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            // In-memory stores (previews/tests) never touch CloudKit; the real app uses the
            // automatic private database keyed off the entitlement's container id.
            cloudKitDatabase: inMemory ? .none : .automatic
        )
        return try ModelContainer(for: schema, configurations: [configuration])
    }

    /// Non-throwing build for the interactive app and previews. A failure here is
    /// unrecoverable and visible to the user, so crash deliberately rather than silently
    /// substitute an ephemeral store that would discard their chat history.
    static func make(inMemory: Bool = false) -> ModelContainer {
        do {
            return try buildContainer(inMemory: inMemory)
        } catch {
            fatalError("Failed to initialize the persistent SwiftData store: \(error)")
        }
    }
}
