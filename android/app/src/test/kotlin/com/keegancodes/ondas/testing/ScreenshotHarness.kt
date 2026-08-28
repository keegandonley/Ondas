package com.keegancodes.ondas.testing

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onRoot
import java.io.File

/**
 * Renders a composable to a real PNG, headlessly.
 *
 * ## Why this exists
 *
 * This port shipped two obvious visual defects past 143 passing tests: every screen rendered
 * underneath the status bar, and the chat pane had no app bar at all — no title, no back. Both
 * were caught by one screenshot of the running app, and neither was catchable by the suite,
 * because a finder-based Compose test asserts that nodes exist, not that the result looks like
 * anything.
 *
 * Robolectric with `GraphicsMode.NATIVE` rasterises for real, so a screen can be looked at without
 * a device, in about a second, with no emulator and no AICore.
 *
 * ## What it does NOT prove
 *
 * A screen that renders here has still not been seen on a phone. System bars, the real launcher
 * mask, live model output and actual gesture behaviour are all absent — indeed the inset bug above
 * would STILL not fail here, because Robolectric composes without system bars. This narrows the
 * gap; it does not close it. The rule stays: look at the device before claiming a screen works.
 *
 * Output lands in `app/build/screenshots/`.
 */
public fun ComposeContentTestRule.captureToPng(
    name: String,
    content: @Composable () -> Unit,
): File {
    setContent(content)
    waitForIdle()
    val bitmap = onRoot().captureToImage().asAndroidBitmap()
    val file = File("build/screenshots/$name.png")
    file.parentFile?.mkdirs()
    file.outputStream().use { stream ->
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
    }
    return file
}

/** Phone width, matching the qualifiers used elsewhere in the suite. */
public const val PHONE_QUALIFIERS: String = "w411dp-h891dp-xxhdpi"

/** Two-pane width, where the list and detail show together. */
public const val TABLET_QUALIFIERS: String = "w840dp-h1280dp-xhdpi"

/** Robolectric ships no framework jar for compileSdk 37; the suite is pinned here. */
public const val ROBOLECTRIC_SDK: Int = 35
