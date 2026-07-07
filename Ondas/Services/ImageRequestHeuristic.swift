import Foundation

/// A cheap, on-device keyword prefilter that decides whether a user message is *worth*
/// running through the language-model image-intent classifier (`ImageIntent`).
///
/// Running the classifier on every single message would double model latency for ordinary
/// chat, so this narrows the field first: only messages that mention imagery *and* an
/// intent-to-create verb are escalated. The classifier still makes the final call, so an
/// incidental phrase like "picture this" that slips through is rejected there.
enum ImageRequestHeuristic {
    /// Verbs that express a request to produce something.
    private static let creationVerbs: Set<String> = [
        "draw", "sketch", "paint", "illustrate", "render", "generate",
        "create", "make", "design", "show", "visualize", "imagine", "picture",
    ]

    /// Nouns that name a visual artifact.
    private static let imageNouns: Set<String> = [
        "image", "images", "picture", "pictures", "pic", "pics",
        "photo", "photos", "drawing", "drawings", "illustration", "illustrations",
        "art", "artwork", "painting", "paintings", "sketch", "sketches",
        "logo", "logos", "wallpaper", "icon", "icons", "poster", "posters",
    ]

    /// Whether the message plausibly asks for an image. True when it contains both a
    /// creation verb and an image noun (e.g. "draw a picture", "generate a logo"), or the
    /// unambiguous standalone verb "visualize"/"illustrate".
    static func mightRequestImage(_ message: String) -> Bool {
        let words = tokens(in: message)
        guard !words.isEmpty else { return false }
        let wordSet = Set(words)

        if wordSet.contains("visualize") || wordSet.contains("illustrate") {
            return true
        }
        let hasVerb = !wordSet.isDisjoint(with: creationVerbs)
        let hasNoun = !wordSet.isDisjoint(with: imageNouns)
        return hasVerb && hasNoun
    }

    /// Lowercased alphabetic tokens. Punctuation and digits are stripped so "picture!" and
    /// "picture" match.
    private static func tokens(in message: String) -> [String] {
        message
            .lowercased()
            .split { !$0.isLetter }
            .map(String.init)
    }
}
