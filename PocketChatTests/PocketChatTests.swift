import Testing
@testable import PocketChat

/// Unit coverage for the pure helpers that don't require the on-device model.
struct PocketChatTests {
    // MARK: ConversationTitle

    @Test func derivesTitleFromShortMessage() {
        #expect(ConversationTitle.derive(from: "Hello there") == "Hello there")
    }

    @Test func collapsesWhitespaceAndTakesFirstLine() {
        let title = ConversationTitle.derive(from: "  Plan a   trip\nsecond line")
        #expect(title == "Plan a trip")
    }

    @Test func truncatesLongMessageOnWordBoundary() {
        let long = "Please help me write a detailed itinerary for a long summer vacation abroad"
        let title = ConversationTitle.derive(from: long)
        #expect(title.count <= 41) // 40 chars + ellipsis
        #expect(title.hasSuffix("…"))
        #expect(!title.contains("  "))
    }

    @Test func emptyMessageFallsBackToDefaultTitle() {
        #expect(ConversationTitle.derive(from: "   ") == Conversation.defaultTitle)
    }

    // MARK: ImageRequestHeuristic

    @Test(arguments: [
        "draw a picture of a cat",
        "can you generate an image of a sunset",
        "make me a logo for my coffee shop",
        "illustrate this idea",
        "visualize the data as a scene",
    ])
    func flagsImageRequests(_ message: String) {
        #expect(ImageRequestHeuristic.mightRequestImage(message))
    }

    @Test(arguments: [
        "what's the weather like today",
        "tell me a joke",
        "how do I make pasta",
        "make a plan for tomorrow",
        "",
    ])
    func ignoresNonImageMessages(_ message: String) {
        #expect(!ImageRequestHeuristic.mightRequestImage(message))
    }
}
