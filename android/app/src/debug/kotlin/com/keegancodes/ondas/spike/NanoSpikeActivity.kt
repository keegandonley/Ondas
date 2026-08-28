package com.keegancodes.ondas.spike

import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Content
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.PromptPrefix
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import kotlin.system.measureTimeMillis

private const val TAG = "ONDAS_SPIKE"

/**
 * Spec #88 — the Gemini Nano capability probe.
 *
 * This is a SPIKE. Nothing here is a ported component and nothing here should survive into
 * the app: its entire output is a set of answers written back into PORTING.md, which specs
 * #92 and #93 are then built on. Debug variant only.
 *
 * Every probe is individually guarded so one failure does not abort the run — a spike that
 * stops at the first surprise answers one question instead of twelve.
 */
class NanoSpikeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // AICore refuses inference with ErrorCode 30 ("Background usage is blocked") the
        // moment the device dozes, even though this activity is still the resumed one. The
        // first run of this spike lost every generation probe that way and looked like a
        // platform limitation.
        //
        // Held in-app rather than via `adb shell svc power stayon`, so nothing about the
        // device's own settings changes and the flag dies with the debug APK.
        setTurnScreenOn(true)
        setShowWhenLocked(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            val lines = remember { mutableStateListOf<String>() }
            LaunchedEffect(Unit) {
                runProbes { line ->
                    Log.i(TAG, line)
                    lines += line
                }
            }
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp),
                    ) {
                        lines.forEach { Text(text = it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

private fun statusName(status: Int): String = when (status) {
    FeatureStatus.AVAILABLE -> "AVAILABLE"
    FeatureStatus.DOWNLOADABLE -> "DOWNLOADABLE"
    FeatureStatus.DOWNLOADING -> "DOWNLOADING"
    FeatureStatus.UNAVAILABLE -> "UNAVAILABLE"
    else -> "UNKNOWN($status)"
}

/** Runs [probe], reporting a thrown [GenAiException]'s error code rather than losing it. */
private suspend fun step(label: String, emit: (String) -> Unit, probe: suspend () -> String) {
    try {
        emit("$label: ${probe()}")
    } catch (e: GenAiException) {
        emit("$label: GenAiException code=${e.errorCode} retryDelay=${e.retryDelay} msg=${e.message}")
    } catch (e: Exception) {
        emit("$label: ${e.javaClass.simpleName}: ${e.message}")
    }
}

private suspend fun runProbes(emit: (String) -> Unit) {
    emit("=== ONDAS NANO SPIKE (spec #88) ===")
    val model: GenerativeModel = Generation.getClient()
    try {
        // --- availability + download, the state iOS has no counterpart for ---------------
        var status = FeatureStatus.UNAVAILABLE
        step("checkStatus", emit) {
            status = model.checkStatus()
            "${statusName(status)} (raw=$status)"
        }
        if (status == FeatureStatus.DOWNLOADABLE || status == FeatureStatus.DOWNLOADING) {
            step("download", emit) {
                var events = 0
                model.download().collect { s ->
                    events++
                    // Only the first few, so a long download does not flood the transcript.
                    if (events <= 6) emit("   download event: $s")
                }
                status = model.checkStatus()
                "$events events, status now ${statusName(status)}"
            }
        }
        if (status != FeatureStatus.AVAILABLE) {
            emit("STOP: model not AVAILABLE (${statusName(status)}); later probes need it")
            return
        }

        step("baseModelName", emit) { model.getBaseModelName() }
        step("tokenLimit", emit) { model.getTokenLimit().toString() }
        step("systemPromptAvailable", emit) { model.isSystemPromptAvailable().toString() }
        step("cachingAvailable", emit) { model.isCachingFeatureAvailable().toString() }
        step("structuredOutputAvailable", emit) { model.isStructuredOutputFeatureAvailable().toString() }
        step("thinkingModeAvailable", emit) { model.isThinkingModeAvailable().toString() }

        // --- generation defaults: does "omit temperature" mean model-default? ------------
        // Ondas maps its Balanced style to GenerationOptions(temperature: nil) deliberately,
        // rather than guessing a number. The Builder takes Float?, but the built request
        // exposes a primitive float -- so what does an omitted value become?
        step("defaults(no temperature set)", emit) {
            val plain = GenerateContentRequest.Builder(TextPart("hi")).build()
            "temperature=${plain.temperature} topK=${plain.topK} " +
                "maxOutputTokens=${plain.maxOutputTokens} candidateCount=${plain.candidateCount} " +
                "seed=${plain.seed} enableThinking=${plain.enableThinking}"
        }

        // --- token counting: the whole context meter depends on these two --------------
        val probeText = "The quick brown fox jumps over the lazy dog."
        step("countTokens(short)", emit) {
            val r = GenerateContentRequest.Builder(TextPart(probeText)).build()
            "${model.countTokens(r).totalTokens} tokens for ${probeText.length} chars"
        }
        step("countTokens(systemInstruction included?)", emit) {
            val bare = GenerateContentRequest.Builder(TextPart(probeText)).build()
            val withSys = GenerateContentRequest.Builder(
                SystemInstruction("You are Ondas, a helpful and friendly assistant."),
                TextPart(probeText),
            ).build()
            "bare=${model.countTokens(bare).totalTokens} " +
                "withSystemInstruction=${model.countTokens(withSys).totalTokens} " +
                "(equal means the system prompt is NOT counted)"
        }

        // --- THE decisive one: are stream chunks cumulative or deltas? -------------------
        // Ondas does `assistant.text = snapshot.content` because Apple's snapshots are
        // cumulative. If these are deltas, that assignment is a silent truncation bug.
        step("streaming", emit) {
            val req = GenerateContentRequest.Builder(
                TextPart("Count from one to eight in words, separated by commas."),
            ).build()
            val chunks = mutableListOf<String>()
            model.generateContentStream(req).collect { r ->
                chunks += r.candidates.firstOrNull()?.text.orEmpty()
            }
            chunks.take(5).forEachIndexed { i, c ->
                emit("   chunk[$i] = ${c.replace("\n", "\\n")}")
            }
            val cumulative = chunks.size > 1 && chunks.zipWithNext().all { (a, b) -> b.startsWith(a) }
            emit("   concatenated = ${chunks.joinToString("").replace("\n", "\\n")}")
            emit("   lastChunk    = ${chunks.lastOrNull()?.replace("\n", "\\n")}")
            "${chunks.size} chunks, CUMULATIVE=$cumulative " +
                "(false means deltas -> concatenate, do not assign)"
        }

        // --- history assembly: Content carries NO role, unlike the cloud Gemini API ------
        val q = "What did I just say my favorite color was?"
        step("multiTurn(separate Content per turn, no roles)", emit) {
            val turns = listOf(
                Content.Builder().text("My favorite color is teal.").build(),
                Content.Builder().text("Nice, teal is a good choice.").build(),
                Content.Builder().text(q).build(),
            )
            model.generateContent(GenerateContentRequest.Builder(turns).build())
                .candidates.firstOrNull()?.text.orEmpty().take(160)
        }
        step("multiTurn(single prompt, role-labelled text)", emit) {
            val flattened =
                "User: My favorite color is teal.\n" +
                    "Assistant: Nice, teal is a good choice.\n" +
                    "User: $q"
            model.generateContent(GenerateContentRequest.Builder(TextPart(flattened)).build())
                .candidates.firstOrNull()?.text.orEmpty().take(160)
        }

        // --- the discriminating history test ---------------------------------------------
        // The earlier probe planted ONE fact and asked for it back, which any bag of text
        // answers correctly whether or not roles survived. Here each speaker owns a DIFFERENT
        // name, so losing attribution produces a visibly wrong answer rather than a lucky one.
        run {
            val userLine = "My name is Keegan."
            val modelLine = "Nice to meet you, Keegan. My name is Ondas."
            val asks = listOf("What is my name?" to "Keegan", "What is your name?" to "Ondas")

            for ((ask, expected) in asks) {
                step("history/roleless \"$ask\" (want $expected)", emit) {
                    val turns = listOf(
                        Content.Builder().text(userLine).build(),
                        Content.Builder().text(modelLine).build(),
                        Content.Builder().text(ask).build(),
                    )
                    model.generateContent(GenerateContentRequest.Builder(turns).build())
                        .candidates.firstOrNull()?.text.orEmpty().trim().take(100)
                }
                step("history/labelled \"$ask\" (want $expected)", emit) {
                    val flat = "User: $userLine\nAssistant: $modelLine\nUser: $ask"
                    model.generateContent(
                        GenerateContentRequest.Builder(TextPart(flat)).build(),
                    ).candidates.firstOrNull()?.text.orEmpty().trim().take(100)
                }
            }
        }

        // --- does the system instruction actually steer? ---------------------------------
        step("systemInstruction effect", emit) {
            val req = GenerateContentRequest.Builder(
                SystemInstruction("You always answer with exactly one word, no punctuation."),
                TextPart("What is the capital of France?"),
            ).build()
            model.generateContent(req).candidates.firstOrNull()?.text.orEmpty().take(80)
        }

        // --- is an omitted temperature actually 0.0, or an unset the getter renders as 0? -
        // `getTemperature()` returns a primitive 0.0f when nothing was set, but that could be
        // the getter's rendering of "unset" rather than a value sent to AICore. Decisive test:
        // hold the prompt fixed and VARY THE SEED. Greedy decoding (temperature 0) ignores the
        // seed, so identical output across seeds means it really is 0.0; varying output means
        // a real non-zero default is in play.
        step("omitted temperature == 0.0?", emit) {
            // A deliberately bland prompt: an earlier run used "a one-sentence story about a
            // fox" and one sample tripped ErrorCode 11 (response policy check), which aborted
            // the whole probe. Per-sample failures are also caught below so one refusal can
            // no longer cost the measurement.
            val ask = "Name one color."
            suspend fun sample(seed: Int, temp: Float?): String =
                try {
                    model.generateContent(
                        GenerateContentRequest.Builder(TextPart(ask)).apply {
                            this.seed = seed
                            if (temp != null) temperature = temp
                        }.build(),
                    ).candidates.firstOrNull()?.text.orEmpty().trim()
                } catch (e: GenAiException) {
                    "<err ${e.errorCode}>"
                }

            val omitted = listOf(1, 2, 3).map { sample(it, null) }
            val explicitZero = listOf(1, 2, 3).map { sample(it, 0.0f) }
            val hot = listOf(1, 2, 3).map { sample(it, 1.0f) }

            emit("   omitted[0]  = ${omitted[0].take(90)}")
            emit("   hot[0]      = ${hot[0].take(90)}")
            emit("   hot[1]      = ${hot[1].take(90)}")
            "omittedVariesAcrossSeeds=${omitted.distinct().size > 1} " +
                "explicitZeroVaries=${explicitZero.distinct().size > 1} " +
                "hotVaries=${hot.distinct().size > 1} " +
                "omittedEqualsExplicitZero=${omitted == explicitZero}"
        }

        // --- prefix caching: what makes re-sending history each turn affordable ---------
        // Ondas rehydrates a whole conversation every turn. With no session object on this
        // side, the shared leading text is re-processed on every request unless PromptPrefix
        // (or an explicit cached context) lets AICore reuse the intermediate state.
        step("promptPrefix timing", emit) {
            val shared = buildString {
                repeat(40) { append("Fact ${it + 1}: item number ${it + 1} is unremarkable. ") }
            }
            val ask = TextPart("Reply with the single word: ok")

            // Five samples each and report the median. A single sample of each was noise: one
            // run showed prefixed 20% FASTER, the next showed it slower.
            fun median(xs: List<Long>) = xs.sorted()[xs.size / 2]

            val inline = (1..5).map {
                measureTimeMillis {
                    model.generateContent(
                        GenerateContentRequest.Builder(
                            TextPart(shared + "Reply with the single word: ok"),
                        ).build(),
                    )
                }
            }
            val prefixed = (1..5).map {
                measureTimeMillis {
                    model.generateContent(
                        GenerateContentRequest.Builder(ask).apply {
                            promptPrefix = PromptPrefix(shared)
                        }.build(),
                    )
                }
            }
            "inline median=${median(inline)}ms $inline / " +
                "promptPrefix median=${median(prefixed)}ms $prefixed " +
                "(prefix chars=${shared.length})"
        }

        // --- A1: how large a live segment can the compaction summariser actually condense? ------
        // Keegan's decision (PORTING.md § A1) is to DERIVE responseTokenReserve and the warning
        // fraction from this measurement rather than inherit Swift's 1024/0.8, which encoded a
        // ~4096-token window where Nano's is 8192. The band exists so compaction is offered while
        // the summariser can still do its job in one pass; that ceiling is what sets it.
        step("A1 summariser headroom", emit) {
            val summaryInstructions =
                "You are compacting a long conversation to free up the model's limited context. " +
                    "Write a concise summary of about 150 words or fewer. Output only the summary."

            // A synthetic transcript that grows in realistic turn-sized chunks.
            fun transcript(turns: Int) = buildString {
                repeat(turns) { i ->
                    append("User: Tell me fact number ${i + 1} about the planet Mars.\n")
                    append(
                        "Assistant: Fact ${i + 1}: Mars has a thin atmosphere of carbon dioxide, " +
                            "surface temperatures far below freezing, and two small moons named " +
                            "Phobos and Deimos.\n",
                    )
                }
            }

            var lastOk = 0
            var lastOkTurns = 0
            var firstFailure = ""
            for (turns in listOf(10, 20, 40, 60, 80, 120, 160)) {
                val body = transcript(turns)
                val prompt = "Summarize this conversation:\n\n$body"
                val counted = runCatching {
                    model.countTokens(
                        GenerateContentRequest.Builder(
                            SystemInstruction(summaryInstructions),
                            TextPart(prompt),
                        ).build(),
                    ).totalTokens
                }.getOrNull()

                val outcome = runCatching {
                    model.generateContent(
                        GenerateContentRequest.Builder(
                            SystemInstruction(summaryInstructions),
                            TextPart(prompt),
                        ).apply { temperature = 0.3f }.build(),
                    ).candidates.firstOrNull()?.text.orEmpty()
                }
                if (outcome.isSuccess && outcome.getOrNull()!!.isNotBlank()) {
                    lastOk = counted ?: lastOk
                    lastOkTurns = turns
                    emit("   turns=$turns tokens=$counted OK (summary ${outcome.getOrNull()!!.length} chars)")
                } else {
                    val why = (outcome.exceptionOrNull() as? GenAiException)?.errorCode?.toString()
                        ?: outcome.exceptionOrNull()?.javaClass?.simpleName ?: "blank"
                    firstFailure = "turns=$turns tokens=$counted -> $why"
                    emit("   $firstFailure")
                    break
                }
            }
            "largest summarisable segment: ~$lastOk tokens ($lastOkTurns turns); " +
                "first failure: ${firstFailure.ifEmpty { "none in range" }}"
        }

        // --- spec #92: the SHIPPING adapter, not the raw SDK ------------------------------
        // ChatEngine's logic is unit-tested against a fake, so the only part of the chat path with
        // no coverage is MlKitModel's mapping onto the real API. Exercised here rather than
        // through a throwaway chat screen, which Keegan declined.
        step("MlKitModel adapter", emit) {
            val adapter = com.keegancodes.ondas.chat.MlKitModel()
            val status = adapter.status()
            val limit = adapter.tokenLimit()
            val name = adapter.baseModelName()
            val counted = adapter.countTokens(
                com.keegancodes.ondas.chat.ChatPrompt.instructions(null),
                "User: hello\n",
            )

            // The real prompt shape the engine sends: system instruction, role-labelled history in
            // the prefix, and the new user turn.
            val collected = StringBuilder()
            adapter.stream(
                com.keegancodes.ondas.chat.ChatPrompt.instructions(null),
                com.keegancodes.ondas.chat.ChatPrompt.history(
                    listOf(
                        com.keegancodes.ondas.kit.models.ChatMessage(
                            role = com.keegancodes.ondas.kit.models.ChatRole.USER,
                            text = "My favourite colour is teal.",
                        ),
                        com.keegancodes.ondas.kit.models.ChatMessage(
                            role = com.keegancodes.ondas.kit.models.ChatRole.ASSISTANT,
                            text = "Noted, teal it is.",
                        ),
                    ),
                ),
                com.keegancodes.ondas.chat.ChatPrompt.userTurn("What is my favourite colour?"),
                0.7f,
            ).collect { delta -> collected.append(delta) }

            emit("   streamed reply = ${collected.toString().trim().take(120)}")

            val summary = adapter.generate(
                com.keegancodes.ondas.chat.ChatPrompt.SUMMARY_INSTRUCTIONS,
                com.keegancodes.ondas.chat.ChatPrompt.summarizerPrompt(
                    null,
                    listOf(
                        com.keegancodes.ondas.kit.models.ChatMessage(
                            role = com.keegancodes.ondas.kit.models.ChatRole.USER,
                            text = "Remember that my flight is on Tuesday.",
                        ),
                    ),
                ),
                0.3f,
            )
            emit("   summariser reply = ${summary.trim().take(120)}")

            "status=$status limit=$limit model=$name countTokens=$counted " +
                "streamedChars=${collected.length}"
        }

        // --- the error surface Ondas's 9 curated messages have to map onto ---------------
        step("oversize prompt", emit) {
            val huge = "word ".repeat(40_000)
            val r = GenerateContentRequest.Builder(TextPart(huge)).build()
            val counted = runCatching { model.countTokens(r).totalTokens }.getOrNull()
            emit("   countTokens on oversize = $counted")
            model.generateContent(r).candidates.firstOrNull()?.text.orEmpty().take(60)
        }
        step("empty prompt", emit) {
            model.generateContent(GenerateContentRequest.Builder(TextPart("")).build())
                .candidates.firstOrNull()?.text.orEmpty().take(60)
        }
    } finally {
        model.close()
        emit("=== SPIKE COMPLETE ===")
    }
}
