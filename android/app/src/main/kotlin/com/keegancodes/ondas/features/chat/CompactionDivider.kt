package com.keegancodes.ondas.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.keegancodes.ondas.design.Theme
import java.util.Locale

/**
 * The inline marker shown where a conversation was compacted: a centered "CONVERSATION COMPACTED"
 * label between two hairlines. Everything above it stays on screen for the user to read, but no
 * longer feeds the model — its gist lives in the summary the model carries instead.
 *
 * The port of `Ondas/Features/Chat/CompactionDivider.swift`. Rendered for any message whose
 * `isCompactionSummary` is true, and never as a bubble.
 */
@Composable
internal fun CompactionDivider(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = COMPACTION_ACCESSIBILITY_LABEL
            },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(modifier = Modifier.weight(1f), thickness = 1.dp, color = Theme.separator)
        Text(
            // Swift applies `.textCase(.uppercase)`, which is a display transform rather than the
            // stored string; ROOT keeps a Turkish locale from turning the "i"s into dotted capitals.
            text = COMPACTION_LABEL.uppercase(Locale.ROOT),
            style = MaterialTheme.typography.labelSmall,
            letterSpacing = 0.6.sp,
            color = Theme.tertiaryLabel,
        )
        HorizontalDivider(modifier = Modifier.weight(1f), thickness = 1.dp, color = Theme.separator)
    }
}

internal const val COMPACTION_LABEL = "Conversation compacted"

internal const val COMPACTION_ACCESSIBILITY_LABEL =
    "Conversation compacted. Earlier messages are summarized from here up."
