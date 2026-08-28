package com.keegancodes.ondas.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.keegancodes.ondas.kit.chat.ResponseStyle

/**
 * `SettingsView` presented modally, the counterpart of Swift's `.sheet(isPresented:)`.
 *
 * The dismissal contract is the whole point of this wrapper: [ModalBottomSheet] routes the scrim
 * tap, the drag-down and the system back gesture through `onDismissRequest`, and the Done button
 * inside the content routes through the same [onDismiss]. Saving is NOT attached to any of those —
 * it hangs off [SettingsSheetContent]'s `DisposableEffect`, so every path that removes the sheet
 * from composition saves, including ones nobody thought to enumerate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsSheet(
    controller: SettingsController,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = modifier,
    ) {
        SettingsSheetContent(controller = controller, onDone = onDismiss)
    }
}

/**
 * The form itself. Split from [SettingsSheet] so the auto-save-on-dismissal contract can be
 * exercised without standing up a modal window.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsSheetContent(
    controller: SettingsController,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Swift's `.onAppear(perform: load)` / `.onDisappear(perform: save)`.
    //
    // Save on *any* dismissal. Attaching it to disposal rather than to the Done button means the
    // back gesture, the scrim tap and Done are literally the same code path, so a freshly pasted
    // API key cannot be discarded by leaving the sheet the "wrong" way. Deliberate product
    // behaviour carried over from Swift, not an oversight.
    DisposableEffect(controller) {
        controller.load()
        onDispose { controller.save() }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = SETTINGS_TITLE,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onDone) { Text(DONE_ACTION) }
        }

        // --- Response style ------------------------------------------------------------------
        // NOTE the temperatures behind these are 0.3 / 0.7 / 1.0, and Balanced maps to a REAL
        // number here where iOS maps it to nil. Approved divergence (PORTING.md § A2) forced by
        // ML Kit having no "model default" temperature and a legal range of 0..1.
        Section(title = RESPONSE_STYLE_LABEL, footer = controller.responseStyle.detail) {
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                ResponseStyle.entries.forEachIndexed { index, style ->
                    SegmentedButton(
                        selected = controller.responseStyle == style,
                        onClick = { controller.updateResponseStyle(style) },
                        shape = SegmentedButtonDefaults.itemShape(
                            index = index,
                            count = ResponseStyle.entries.size,
                        ),
                        label = { Text(style.title) },
                    )
                }
            }
        }

        // --- Telemetry -----------------------------------------------------------------------
        Section(footer = TELEMETRY_FOOTER) {
            ToggleRow(
                label = TELEMETRY_LABEL,
                checked = controller.isEnabled,
                enabled = true,
                onCheckedChange = controller::updateEnabled,
            )
        }

        Section(footer = TRANSCRIPTS_FOOTER) {
            ToggleRow(
                label = TRANSCRIPTS_LABEL,
                checked = controller.sendTranscripts,
                // Transcript capture is meaningless with telemetry off, and Swift disables rather
                // than hides it so the opt-in stays discoverable.
                enabled = controller.isEnabled,
                onCheckedChange = controller::updateSendTranscripts,
            )
        }

        // --- Endpoint ------------------------------------------------------------------------
        Section(
            title = ENDPOINT_SECTION,
            footer = if (controller.hasInvalidEndpoint) ENDPOINT_INVALID_FOOTER else ENDPOINT_FOOTER,
        ) {
            OutlinedTextField(
                value = controller.endpoint,
                onValueChange = controller::updateEndpoint,
                modifier = Modifier.fillMaxWidth().testTag(ENDPOINT_FIELD_TAG),
                singleLine = true,
                isError = controller.hasInvalidEndpoint,
                label = { Text(ENDPOINT_LABEL) },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
            )
            OutlinedTextField(
                value = controller.apiKey,
                onValueChange = controller::updateApiKey,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .testTag(API_KEY_FIELD_TAG),
                singleLine = true,
                label = { Text(API_KEY_LABEL) },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
            )
        }

        // --- Test event ----------------------------------------------------------------------
        Section(
            footer = if (controller.testResult == TestResult.FAILURE) TEST_FAILURE_FOOTER else null,
        ) {
            OutlinedButton(
                onClick = controller::sendTest,
                enabled = controller.canSendTest,
                modifier = Modifier.fillMaxWidth().testTag(SEND_TEST_BUTTON_TAG),
            ) {
                Text(text = SEND_TEST_ACTION, modifier = Modifier.weight(1f))
                when {
                    controller.isTesting -> CircularProgressIndicator(Modifier.size(18.dp))
                    controller.testResult == TestResult.SUCCESS -> Icon(
                        Icons.Filled.CheckCircle,
                        contentDescription = TEST_SUCCEEDED,
                        tint = Color(0xFF2E7D32),
                    )
                    controller.testResult == TestResult.FAILURE -> Icon(
                        Icons.Filled.Clear,
                        contentDescription = TEST_FAILED,
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

/** A `Form` section: optional header, content, optional explanatory footer. */
@Composable
private fun Section(
    title: String? = null,
    footer: String? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        if (title != null) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        content()
        if (footer != null) {
            Text(
                text = footer,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun ToggleRow(
    label: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
            },
            modifier = Modifier.weight(1f),
        )
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
            modifier = Modifier.testTag(toggleTag(label)),
        )
    }
}

// Copy ported verbatim from SettingsView.swift, minus the iCloud Sync section (storage is
// local-only Room -- there is no sync to report).
internal const val SETTINGS_TITLE: String = "Settings"
internal const val DONE_ACTION: String = "Done"
internal const val RESPONSE_STYLE_LABEL: String = "Response style"
internal const val TELEMETRY_LABEL: String = "Send usage telemetry"
internal const val TELEMETRY_FOOTER: String =
    "Off by default. When on, Ondas sends model id, token counts, tool calls, and timing to " +
        "your endpoint."
internal const val TRANSCRIPTS_LABEL: String = "Send transcripts"
internal const val TRANSCRIPTS_FOOTER: String =
    "Includes each successful text prompt and model reply in OTLP spans. Messages may contain " +
        "sensitive information."
internal const val ENDPOINT_SECTION: String = "Endpoint"
internal const val ENDPOINT_LABEL: String = "OTLP base URL"
internal const val API_KEY_LABEL: String = "Bearer key (otlp_…)"
internal const val ENDPOINT_FOOTER: String =
    "Use an HTTPS base OTLP URL; Ondas appends /v1/traces (JSON traces). " +
        "e.g. https://stats.keegan.codes/api/otlp"
internal const val ENDPOINT_INVALID_FOOTER: String =
    "Use a valid HTTPS base URL. Ondas appends /v1/traces (JSON traces)."
internal const val SEND_TEST_ACTION: String = "Send test event"
internal const val TEST_FAILURE_FOOTER: String =
    "The endpoint didn't accept the event. Check the URL and key."
internal const val TEST_SUCCEEDED: String = "Test event accepted"
internal const val TEST_FAILED: String = "Test event rejected"

internal const val ENDPOINT_FIELD_TAG: String = "settingsEndpointField"
internal const val API_KEY_FIELD_TAG: String = "settingsApiKeyField"
internal const val SEND_TEST_BUTTON_TAG: String = "settingsSendTestButton"

internal fun toggleTag(label: String): String = "settingsToggle:$label"
