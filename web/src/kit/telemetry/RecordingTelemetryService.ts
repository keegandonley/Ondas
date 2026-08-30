import type { LLMRecord, TelemetryService } from "./TelemetryService";

/**
 * A spy `TelemetryService` for tests. Not shipped in any UI path.
 *
 * `ChatEngine` (spec W6) reports telemetry from a detached, fire-and-forget task so it never
 * delays a turn's teardown — which means a test asserting "this turn reported one chat span"
 * needs somewhere for that task to land. `NoopTelemetryService` gives it nowhere, and a test
 * that cannot observe the call would silently pass if the call were deleted.
 *
 * `isDeliverable` is settable because the guard it drives is itself load-bearing: Swift skips a
 * whole reply-token count when telemetry is off, and both branches need covering.
 */
export class RecordingTelemetryService implements TelemetryService {
  readonly records: LLMRecord[] = [];

  constructor(public isDeliverable: boolean = true) {}

  async recordLLM(record: LLMRecord): Promise<void> {
    if (!this.isDeliverable) return;
    this.records.push(record);
  }

  recordsForFeature(feature: LLMRecord["feature"]): LLMRecord[] {
    return this.records.filter((record) => record.feature === feature);
  }
}
