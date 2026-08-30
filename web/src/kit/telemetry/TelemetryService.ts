/**
 * Port of `Ondas/Services/Telemetry/TelemetryService.swift`, **stubbed** for web v1.
 *
 * Only the shape `ChatEngine` calls is ported: `isDeliverable` and `recordLLM`. The OTLP
 * encoder, the buffered exporter, `TelemetrySpan`, `TelemetryConfig` and the Keychain-backed
 * secret store are deliberately unbuilt — see web/PORTING.md § Known unported Swift, and
 * § Awaiting approval D1/D2 for the two things that must be answered before they can be.
 *
 * Why stub rather than delete the call sites: on iOS telemetry is **off by default**, so an
 * always-undeliverable service is not a fake — it is exactly the shipped default behaviour.
 * That lets `ChatEngine`'s telemetry guards, its detached fire-and-forget tasks and its
 * teardown ordering port 1:1 instead of being edited out and re-added later. Removing the
 * call sites would be a real deviation in the one file this port most needs to be faithful.
 *
 * `recordToolCall` is NOT ported. Its only caller in Swift is the `/image` turn
 * (`ChatEngine.swift` `recordTelemetry`, the `asImage` branch), and image generation is cut
 * from web v1 — so porting it would add a method nothing can call. `ondas.feature` is still
 * carried on `LLMRecord` so the distinction survives if image generation ever returns.
 */

/** One completed model invocation, as `ChatEngine` reports it. Mirrors `recordLLM`'s parameters. */
export interface LLMRecord {
  conversationId: string;
  /** `ondas.feature` — distinguishes a normal turn (`"chat"`) from compaction (`"compaction"`). */
  feature: "chat" | "compaction";
  prompt: string;
  completion: string;
  inputTokens: number;
  outputTokens: number;
  start: Date;
  end: Date;
}

export interface TelemetryService {
  /**
   * Cheap gate callers check BEFORE doing telemetry-only work. In Swift this guards an extra
   * `tokenCount(for: assistantText)` call per turn, which is why it exists separately from
   * `recordLLM` simply no-oping: the work is skipped, not just discarded.
   */
  readonly isDeliverable: boolean;
  recordLLM(record: LLMRecord): Promise<void>;
}

/**
 * The shipped implementation for web v1: reports undeliverable and accepts nothing.
 *
 * It deliberately does not buffer, log, or otherwise retain `record` — the Swift service only
 * ever attaches prompt/completion text when transcript capture is separately opted into, and a
 * stub that quietly held transcripts in memory would be a worse privacy posture than the app it
 * is standing in for.
 */
export class NoopTelemetryService implements TelemetryService {
  readonly isDeliverable = false;

  async recordLLM(_record: LLMRecord): Promise<void> {
    // Intentionally empty. See the class doc.
  }
}

/** The app-wide instance, mirroring Swift's `TelemetryService.shared`. */
export const telemetryService: TelemetryService = new NoopTelemetryService();
