import SwiftUI
import UIKit

/// Renders one message: a right-aligned accent bubble for the user, a left-aligned neutral
/// bubble for the assistant. Assistant messages can carry a generated image, plain text, or
/// a "thinking" indicator while a reply is in flight.
struct MessageBubble: View {
    let message: ChatMessage

    /// True when this is the assistant's placeholder and the model is still working, so the
    /// bubble shows a typing indicator instead of empty text.
    let isAwaitingResponse: Bool

    /// True while this assistant message is actively receiving streamed text, so a blinking
    /// caret trails the content to signal generation is still in progress.
    var isStreaming: Bool = false

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            content
            if !isUser { Spacer(minLength: 40) }
        }
        // Cross-fade the thinking dots into the reply as the first token lands.
        .animation(.easeInOut(duration: 0.2), value: isAwaitingResponse)
    }

    @ViewBuilder
    private var content: some View {
        if isAwaitingResponse {
            ThinkingIndicator()
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Theme.assistantBubble, in: bubbleShape)
                .transition(.opacity)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let image = generatedImage {
                    image
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 320)
                        .clipShape(RoundedRectangle(
                            cornerRadius: Theme.bubbleCornerRadius - 6,
                            style: .continuous
                        ))
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                }
                if !message.text.isEmpty {
                    messageText
                        .foregroundStyle(isUser ? Color.white : Color.primary)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(isUser ? Theme.userBubble : Theme.assistantBubble, in: bubbleShape)
            .transition(.opacity)
            // Reveal a generated image with a soft fade + scale once its bytes arrive.
            .animation(.easeOut(duration: 0.3), value: message.hasImage)
        }
    }

    /// The reply text, with a blinking caret appended while it is still streaming in. The caret is
    /// concatenated into the same `Text` (not overlaid) so it wraps naturally at the end of the
    /// last line; `TimelineView` toggles it on a fixed cadence.
    @ViewBuilder
    private var messageText: some View {
        if isStreaming {
            // Parse the markdown once out here — the timeline closure re-runs every blink tick,
            // and only the caret changes between ticks, not the text.
            let rendered = renderedText
            TimelineView(.periodic(from: .now, by: Self.caretBlinkInterval)) { context in
                let tick = Int(context.date.timeIntervalSinceReferenceDate / Self.caretBlinkInterval)
                let caret = tick.isMultiple(of: 2) ? " ▍" : ""
                Text("\(rendered)\(Text(verbatim: caret))")
            }
        } else {
            renderedText
        }
    }

    /// Model replies may contain Markdown, while user-authored text is always shown verbatim.
    /// Parsing on each streamed update also lets formatting appear as soon as its closing marker
    /// arrives. An incomplete or otherwise invalid fragment remains readable as plain text.
    private var renderedText: Text {
        guard !isUser,
              let attributed = try? AttributedString(
                markdown: message.text,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
              ) else {
            return Text(verbatim: message.text)
        }
        return Text(attributed)
    }

    private static let caretBlinkInterval: TimeInterval = 0.6

    private var isUser: Bool {
        message.role == .user
    }

    private var bubbleShape: some Shape {
        RoundedRectangle(cornerRadius: Theme.bubbleCornerRadius, style: .continuous)
    }

    private var generatedImage: Image? {
        guard let data = message.imageData, let uiImage = UIImage(data: data) else {
            return nil
        }
        return Image(uiImage: uiImage)
    }
}

/// Three dots that pulse while the model composes a reply.
private struct ThinkingIndicator: View {
    @State private var isAnimating = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 7, height: 7)
                    .opacity(isAnimating ? 0.3 : 1)
                    .animation(
                        .easeInOut(duration: 0.6)
                            .repeatForever()
                            .delay(Double(index) * 0.2),
                        value: isAnimating
                    )
            }
        }
        .onAppear { isAnimating = true }
        .accessibilityLabel("Assistant is typing")
    }
}
