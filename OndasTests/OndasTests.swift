import FoundationModels
import Foundation
import Testing
@testable import Ondas

/// Unit coverage for the pure helpers that don't require the on-device model. The tool's live
/// behavior (the model choosing to call it, real image generation) can only be verified on a
/// device with Apple Intelligence, so these cover the plumbing around the boundary.
struct OndasTests {
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

    // MARK: ImageGenerationTool.Arguments decoding

    /// The model fills the tool's arguments as `GeneratedContent`; confirm the `@Generable`
    /// struct decodes the `prompt` property the tool relies on.
    @Test func decodesPromptArgumentFromGeneratedContent() throws {
        let content = GeneratedContent(properties: ["prompt": "a red bicycle on a beach"])
        let arguments = try ImageGenerationTool.Arguments(content)
        #expect(arguments.prompt == "a red bicycle on a beach")
    }

    // MARK: GeneratedImageCollector plumbing

    /// `take()` returns the stored image once and then clears it, so a later turn starts empty.
    @Test func collectorReturnsStoredImageOnceThenClears() async {
        let collector = GeneratedImageCollector()
        let bytes = Data([0x01, 0x02, 0x03])

        await collector.store(bytes)
        #expect(await collector.take() == bytes)
        #expect(await collector.take() == nil)
    }

    /// The most recent image wins if the model calls the tool more than once in a turn, since a
    /// `ChatMessage` holds a single image.
    @Test func collectorKeepsMostRecentImage() async {
        let collector = GeneratedImageCollector()
        await collector.store(Data([0xAA]))
        await collector.store(Data([0xBB]))
        #expect(await collector.take() == Data([0xBB]))
    }

    /// `reset()` drops any leftover image before a turn begins.
    @Test func collectorResetClearsPendingImage() async {
        let collector = GeneratedImageCollector()
        await collector.store(Data([0xFF]))
        await collector.reset()
        #expect(await collector.take() == nil)
    }
}
