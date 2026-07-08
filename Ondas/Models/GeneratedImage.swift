import Foundation
import SwiftData

/// A standalone on-device generated image — one created from the home-screen "Generate Image"
/// action rather than inside a chat. Chat-generated images live on `ChatMessage.imageData`;
/// this is the canonical store for images that are *not* attached to any conversation, so the
/// Gallery can show every generated image from both sources.
///
/// CloudKit-safe by the same rules as `Conversation`/`ChatMessage`: every stored property has a
/// default value, there is no `@Attribute(.unique)`, and the bytes are stored externally so the
/// row itself stays small.
@Model
final class GeneratedImage {
    var id: UUID = UUID()

    /// The prompt the user typed to create this image. Shown in the viewer and reusable later.
    var prompt: String = ""

    /// JPEG-encoded image bytes (see `ImageGenerator`), stored externally so SwiftData doesn't
    /// inline a large blob into the row.
    @Attribute(.externalStorage)
    var imageData: Data? = nil

    var createdAt: Date = Date.now

    init(prompt: String = "", imageData: Data? = nil, createdAt: Date = .now) {
        self.id = UUID()
        self.prompt = prompt
        self.imageData = imageData
        self.createdAt = createdAt
    }
}
