package com.keegancodes.ondas

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.remember
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.keegancodes.ondas.chat.ChatEngine
import com.keegancodes.ondas.design.OndasTheme
import com.keegancodes.ondas.features.conversations.ConversationListModel
import com.keegancodes.ondas.features.settings.SettingsController
import com.keegancodes.ondas.ui.OndasApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The single window. Counterpart of `OndasApp`'s `WindowGroup { ConversationListView() }`.
 *
 * Not ported from `OndasApp.init`: `CloudKitSyncMonitor.shared.start()`. Storage is local-only
 * Room, so there is no sync to observe and nothing for a status row to report.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val graph = graph(this)

        // Swift's `OndasApp.init`: load the user's saved telemetry preference (off by default)
        // into the shared service so any model usage this session can be reported.
        // Fire-and-forget, on the process scope rather than the activity's, for the same reason
        // Swift uses an unstructured Task -- it must not be cancelled by a rotation.
        appScope.launch { graph.telemetry.update(graph.telemetrySettings.currentConfig()) }

        setContent {
            val listModel: ConversationListModel = viewModel(
                factory = viewModelFactory {
                    initializer { ConversationListModel(graph.repository) }
                },
            )
            val settings = remember(graph) {
                SettingsController(
                    telemetrySettings = graph.telemetrySettings,
                    generationSettings = graph.generationSettings,
                    telemetry = graph.telemetry,
                    scope = appScope,
                )
            }

            OndasTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        // `enableEdgeToEdge()` above draws BEHIND the status and navigation bars,
                        // and nothing else in the tree compensated — so the first message bubble
                        // rendered on top of the clock and the wifi/battery icons. Only visible on
                        // a real device: Robolectric composes without system bars, so every screen
                        // test passed with the collision present.
                        .windowInsetsPadding(WindowInsets.safeDrawing),
                ) {
                    OndasApp(
                        listModel = listModel,
                        repository = graph.repository,
                        settings = settings,
                        createEngine = {
                            ChatEngine(
                                model = graph.model,
                                repository = graph.repository,
                                telemetry = graph.telemetry,
                                settings = graph.generationSettings,
                                // Process-scoped, matching Swift: leaving a conversation cancels
                                // the active TURN (see OndasApp's DisposableEffect), it does not
                                // tear down work the engine detached, such as a telemetry POST.
                                scope = appScope,
                                responseTokenReserve = OndasGraph.RESPONSE_TOKEN_RESERVE,
                            )
                        },
                    )
                }
            }
        }
    }
}

/**
 * Process-lifetime scope for work that must outlive the activity: the startup telemetry config
 * publish, the settings sheet's save-on-dismissal, and each chat turn's detached telemetry span.
 * Swift's counterpart is an unstructured `Task { }`, which is likewise not owned by a view.
 */
private val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

/**
 * The container, held for the life of the process rather than the activity.
 *
 * `OndasGraph` lazily opens the Room database; rebuilding it on every configuration change would
 * open a second connection to the same file for no reason. There is no `Application` subclass to
 * hang it off (the manifest declares none, and the manifest is not this spec's to change), so a
 * guarded file-level holder is the least ceremony that gets the lifetime right. If an
 * `Application` subclass is ever added, this moves there and the suppression goes with it.
 *
 * `StaticFieldLeak` is suppressed because it is a false positive here: `OndasGraph` is built from
 * `context.applicationContext`, which lint does not follow, so the retained Context is the one
 * that already lives for the whole process.
 */
@SuppressLint("StaticFieldLeak")
private var graphInstance: OndasGraph? = null

@Synchronized
private fun graph(context: Context): OndasGraph =
    graphInstance ?: OndasGraph(context.applicationContext).also { graphInstance = it }
