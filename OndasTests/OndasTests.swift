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

    // MARK: ImageCommand parsing

    @Test func imageCommandExtractsPromptAfterToken() {
        #expect(ImageCommand.prompt(in: "/image a cat on a beach") == "a cat on a beach")
    }

    @Test func imageCommandIsCaseInsensitiveAndTrims() {
        #expect(ImageCommand.prompt(in: "/IMAGE   a red bike ") == "a red bike")
    }

    @Test func imageCommandEmptyPromptWhenJustTokenAndSpace() {
        // Typing "/image " (token + space) enters image mode with an empty prompt.
        #expect(ImageCommand.prompt(in: "/image ") == "")
    }

    @Test func imageCommandRequiresTokenThenSpace() {
        // Bare token (still typing) and non-command text are not the command.
        #expect(ImageCommand.prompt(in: "/image") == nil)
        #expect(ImageCommand.prompt(in: "/imagex cat") == nil)
        #expect(ImageCommand.prompt(in: "draw a cat") == nil)
    }

    // MARK: TokenUsage

    @Test func tokenUsageFractionIsRatioOfUsedToLimit() {
        let usage = TokenUsage(used: 768, limit: 3072)
        #expect(usage.fraction == 0.25)
    }

    @Test func tokenUsageFractionClampsToOneWhenOverLimit() {
        let usage = TokenUsage(used: 4000, limit: 3072)
        #expect(usage.fraction == 1.0)
    }

    @Test func tokenUsageFractionIsZeroWhenLimitIsZero() {
        // Guards against divide-by-zero if the context window can't be determined.
        let usage = TokenUsage(used: 100, limit: 0)
        #expect(usage.fraction == 0)
    }

    @Test func tokenUsageIsAtCapacityWhenUsedReachesLimit() {
        #expect(TokenUsage(used: 3072, limit: 3072).isAtCapacity)
        #expect(TokenUsage(used: 3073, limit: 3072).isAtCapacity)
        #expect(!TokenUsage(used: 3071, limit: 3072).isAtCapacity)
    }
}
