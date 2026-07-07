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

    /// Strongly visual verbs that, on their own, mark an assistant message as an offer to
    /// create imagery even without an accompanying noun (e.g. "Shall I draw that?").
    private static let visualVerbs: Set<String> = [
        "draw", "sketch", "paint", "illustrate", "render", "visualize",
    ]

    /// Bare acceptances that carry no image keywords themselves but may be agreeing to an image
    /// the assistant just offered (e.g. replying "yes" to "Want me to draw that?").
    private static let affirmatives: Set<String> = [
        "yes", "yeah", "yep", "yup", "sure", "ok", "okay",
        "please", "definitely", "absolutely",
    ]

    /// Words that flip a short reply from acceptance to refusal, so "no, don't" isn't treated
    /// as accepting an offer.
    private static let negations: Set<String> = [
        "no", "not", "nope", "dont", "don", "never", "stop", "cancel",
    ]

    /// A reply longer than this many words is unlikely to be a bare acceptance.
    private static let maxAffirmativeWords = 5

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

    /// Whether `message` reads as accepting an image the assistant offered on the previous turn.
    /// True only when that previous message looks like an image offer *and* this short reply is a
    /// plain affirmative with no negation. Lets a bare "yes" reach the model classifier, which
    /// still makes the final call and writes the prompt from the offered image.
    static func acceptsImageOffer(_ message: String, previousAssistant: String?) -> Bool {
        guard let previousAssistant, assistantOfferedImage(previousAssistant) else { return false }
        return isAffirmative(message)
    }

    /// Whether an assistant message plausibly offered to create an image — it names a visual
    /// artifact or uses a strongly visual verb.
    private static func assistantOfferedImage(_ message: String) -> Bool {
        let wordSet = Set(tokens(in: message))
        guard !wordSet.isEmpty else { return false }
        return !wordSet.isDisjoint(with: imageNouns) || !wordSet.isDisjoint(with: visualVerbs)
    }

    /// A short reply that affirms without negating — e.g. "yes", "sure, please".
    private static func isAffirmative(_ message: String) -> Bool {
        let words = tokens(in: message)
        guard !words.isEmpty, words.count <= maxAffirmativeWords else { return false }
        let wordSet = Set(words)
        guard wordSet.isDisjoint(with: negations) else { return false }
        return !wordSet.isDisjoint(with: affirmatives)
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
