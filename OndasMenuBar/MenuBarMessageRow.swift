import AppKit
import SwiftUI

/// One transcript row in the menu-bar popover: a compaction divider, a thinking indicator, an
/// image, or a text bubble. A compact macOS counterpart to the app's `MessageBubble`.
struct MenuBarMessageRow: View {
    let message: ChatMessage
    let isAwaitingResponse: Bool

    var body: some View {
        if message.isCompactionSummary {
            divider
        } else {
            bubble
                .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        }
    }

    private var divider: some View {
        HStack(spacing: 8) {
            line
            Text("Conversation compacted")
                .font(.caption2)
                .foregroundStyle(.secondary)
            line
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
    }

    private var line: some View {
        Rectangle().fill(.separator).frame(height: 1)
    }

    @ViewBuilder
    private var bubble: some View {
        if isAwaitingResponse {
            ProgressView()
                .controlSize(.small)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Theme.assistantBubble, in: bubbleShape)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let data = message.imageData, let image = NSImage(data: data) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .textSelection(.enabled)
                        .foregroundStyle(textColor)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(bubbleBackground, in: bubbleShape)
        }
    }

    private var bubbleShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
    }

    private var bubbleBackground: AnyShapeStyle {
        if message.isError { return AnyShapeStyle(.red.opacity(0.15)) }
        return message.role == .user ? AnyShapeStyle(Theme.userBubble) : AnyShapeStyle(Theme.assistantBubble)
    }

    private var textColor: Color {
        message.role == .user ? .white : .primary
    }
}
