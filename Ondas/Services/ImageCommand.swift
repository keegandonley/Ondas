import Foundation

/// The `/image` composer command — the explicit, deterministic trigger for image generation.
///
/// The on-device model proved unable to reliably infer image intent from natural language (it both
/// over-generated on bare nouns like "Bees" and refused genuine requests), so intent is no longer
/// guessed: a turn generates an image only when the user sends this command. `ChatView`'s composer
/// detects it and switches to a highlighted image mode; `ChatEngine.send(_:asImage:)` gives that
/// turn the image tool.
enum ImageCommand {
    /// The token the user types to switch the composer into image mode.
    static let token = "/image"

    /// If `text` begins with the command token followed by a space, returns the image prompt after
    /// it (trimmed, possibly empty); otherwise nil. The token match is case-insensitive.
    static func prompt(in text: String) -> String? {
        let prefix = token + " "
        guard text.count >= prefix.count,
              text.prefix(prefix.count).lowercased() == prefix
        else {
            return nil
        }
        return String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }
}
