import { describe, expect, it } from "vitest";

import { NoopTelemetryService, telemetryService } from "./TelemetryService";
import { RecordingTelemetryService } from "./RecordingTelemetryService";
import type { LLMRecord } from "./TelemetryService";

function record(overrides: Partial<LLMRecord> = {}): LLMRecord {
  return {
    conversationId: "11111111-1111-1111-1111-111111111111",
    feature: "chat",
    prompt: "hello",
    completion: "hi",
    inputTokens: 3,
    outputTokens: 2,
    start: new Date(0),
    end: new Date(1000),
    ...overrides,
  };
}

describe("NoopTelemetryService", () => {
  it("reports undeliverable, so ChatEngine skips telemetry-only work", () => {
    // This is the whole contract of the v1 stub. If it ever reported true, ChatEngine would
    // start counting reply tokens every turn for a service that discards them.
    expect(new NoopTelemetryService().isDeliverable).toBe(false);
  });

  it("accepts a record without throwing", async () => {
    // ChatEngine calls this from a detached task with no catch; a throwing stub would surface
    // as an unhandled rejection rather than a failed turn.
    await expect(new NoopTelemetryService().recordLLM(record())).resolves.toBeUndefined();
  });

  it("is what the app-wide instance is", () => {
    expect(telemetryService.isDeliverable).toBe(false);
  });
});

describe("RecordingTelemetryService", () => {
  it("captures records so a detached report is observable in tests", async () => {
    const spy = new RecordingTelemetryService();
    await spy.recordLLM(record({ feature: "chat" }));
    await spy.recordLLM(record({ feature: "compaction" }));

    expect(spy.records).toHaveLength(2);
    expect(spy.recordsForFeature("compaction")).toHaveLength(1);
    expect(spy.recordsForFeature("chat")[0]?.prompt).toBe("hello");
  });

  it("drops records when undeliverable, matching the real guard", async () => {
    const spy = new RecordingTelemetryService(false);
    await spy.recordLLM(record());
    expect(spy.records).toHaveLength(0);
  });
});
