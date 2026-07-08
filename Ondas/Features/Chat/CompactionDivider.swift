import SwiftUI

/// The inline marker shown where a conversation was compacted: a centered "Conversation compacted"
/// label between two hairlines. Everything above it stays on screen for the user to read, but no
/// longer feeds the model — its gist lives in the summary the model carries instead.
struct CompactionDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            line
            Text("Conversation compacted")
                .font(.caption2)
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(.tertiary)
                .fixedSize()
            line
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Conversation compacted. Earlier messages are summarized from here up.")
    }

    private var line: some View {
        Rectangle()
            .fill(.separator)
            .frame(height: 1)
    }
}

#Preview {
    CompactionDivider()
        .padding()
}
