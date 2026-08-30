import { describe, expect, it } from "vitest";
import {
  CONTEXT_EXCEEDED_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  MODEL_DOWNLOADABLE_MESSAGE,
  MODEL_DOWNLOADING_MESSAGE,
  MODEL_NOT_READY_MESSAGE,
  MODEL_UNAVAILABLE_MESSAGE,
  ModelError,
  REFUSAL_MESSAGE,
  SESSION_CLOSED_MESSAGE,
  UNSUPPORTED_BROWSER_MESSAGE,
  WEB_MODEL_NAME,
  availabilityMessage,
  curatedMessage,
  isCancellation,
  isModelAvailability,
  type ModelErrorKind,
} from "./OnDeviceModel";

/** Every kind in the taxonomy, so a new one added without copy fails a test here. */
const KINDS: readonly ModelErrorKind[] = [
  "REQUEST_TOO_LARGE",
  "NOT_AVAILABLE",
  "SESSION_DESTROYED",
  "UNSUPPORTED_BROWSER",
  "EMPTY_RESPONSE",
  "UNKNOWN",
];

describe("ModelError", () => {
  it("carries the kind and a content-free diagnostic label", () => {
    const error = new ModelError("REQUEST_TOO_LARGE", "DOMException.QuotaExceededError");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ModelError");
    expect(error.kind).toBe("REQUEST_TOO_LARGE");
    expect(error.diagnosticLabel).toBe("DOMException.QuotaExceededError");
  });

  it("uses the label as its message and never the vendor's own text", () => {
    // The privacy invariant ported from ChatEngine.swift:735 — a model error's context can echo
    // prompt fragments, so nothing but the label may reach the message (and therefore the log).
    const cause = new Error("prompt was: my private diary entry");
    const error = new ModelError("UNKNOWN", "DOMException.DataError", { cause });
    expect(error.message).toBe("DOMException.DataError");
    expect(error.message).not.toContain("diary");
    expect(error.cause).toBe(cause);
  });

  it("preserves the quota fields when there are any, and leaves them undefined otherwise", () => {
    const sized = new ModelError("REQUEST_TOO_LARGE", "DOMException.QuotaExceededError", {
      requested: 12_000,
      quota: 9_216,
    });
    expect(sized.requested).toBe(12_000);
    expect(sized.quota).toBe(9_216);

    const plain = new ModelError("UNKNOWN", "LanguageModel.unknown");
    expect(plain.requested).toBeUndefined();
    expect(plain.quota).toBeUndefined();
  });
});

describe("isCancellation", () => {
  it("recognises an AbortError", () => {
    expect(isCancellation(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("recognises an AbortError from another realm by name, not by class", () => {
    // `DOMException` is not the same class object across realms, and an AbortSignal's `reason`
    // may be constructed by any layer, so the match is on `name`.
    const foreign = new Error("aborted");
    foreign.name = "AbortError";
    expect(isCancellation(foreign)).toBe(true);
  });

  it("never treats a classified model failure as cancellation", () => {
    // Load-bearing: ChatEngine tells "user cancelled" from "turn failed" with this. If a
    // ModelError read as cancellation, a genuinely failed turn would leave no error message.
    for (const kind of KINDS) {
      expect(isCancellation(new ModelError(kind, "DOMException.Whatever"))).toBe(false);
    }
  });

  it("never treats a classified failure as cancellation even if it is named AbortError", () => {
    // Why `isCancellation` tests the class before the name: classification is the stronger
    // claim. Anything that reached the taxonomy was decided to be a failure, and a stray `name`
    // must not be able to promote it back to a cancellation and silence its error message.
    const misnamed = new ModelError("UNKNOWN", "DOMException.Whatever");
    misnamed.name = "AbortError";
    expect(isCancellation(misnamed)).toBe(false);
  });

  it("does not treat an ordinary failure as cancellation", () => {
    expect(isCancellation(new Error("aborted"))).toBe(false);
    expect(isCancellation(new DOMException("nope", "InvalidStateError"))).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation("AbortError")).toBe(false);
  });
});

describe("isModelAvailability", () => {
  it("accepts exactly the four states", () => {
    expect(isModelAvailability("unavailable")).toBe(true);
    expect(isModelAvailability("downloadable")).toBe(true);
    expect(isModelAvailability("downloading")).toBe(true);
    expect(isModelAvailability("available")).toBe(true);
  });

  it("rejects anything else, so a new Chrome state cannot flow through as availability", () => {
    expect(isModelAvailability("readily")).toBe(false);
    expect(isModelAvailability("")).toBe(false);
    expect(isModelAvailability(undefined)).toBe(false);
    expect(isModelAvailability(2)).toBe(false);
  });
});

describe("curated copy", () => {
  // The Swift strings are written out as literals here on purpose. Asserting only
  // `curatedMessage(kind) === CONSTANT` would pass after any reword; these are the drift guard
  // against `ChatEngine.swift`'s own copy, so a change to either side has to be deliberate.
  it("matches ChatEngine.swift verbatim where an equivalent condition exists", () => {
    expect(CONTEXT_EXCEEDED_MESSAGE).toBe(
      "This conversation has grown too long to continue. Start a new chat to keep going.",
    );
    expect(REFUSAL_MESSAGE).toBe("I can't help with that request.");
    expect(MODEL_NOT_READY_MESSAGE).toBe(
      "The on-device model is still getting ready. Try again shortly.",
    );
    expect(GENERIC_FAILURE_MESSAGE).toBe("Sorry, I couldn't finish that. Please try again.");
    expect(MODEL_DOWNLOADING_MESSAGE).toBe(
      "The on-device model is still downloading. Try again shortly.",
    );
    expect(MODEL_DOWNLOADABLE_MESSAGE).toBe(
      "Ondas needs to download the on-device model before you can chat.",
    );
  });

  it("maps every kind to its constant", () => {
    expect(curatedMessage("REQUEST_TOO_LARGE")).toBe(CONTEXT_EXCEEDED_MESSAGE);
    expect(curatedMessage("EMPTY_RESPONSE")).toBe(REFUSAL_MESSAGE);
    expect(curatedMessage("NOT_AVAILABLE")).toBe(MODEL_NOT_READY_MESSAGE);
    expect(curatedMessage("SESSION_DESTROYED")).toBe(SESSION_CLOSED_MESSAGE);
    expect(curatedMessage("UNSUPPORTED_BROWSER")).toBe(UNSUPPORTED_BROWSER_MESSAGE);
    expect(curatedMessage("UNKNOWN")).toBe(GENERIC_FAILURE_MESSAGE);
  });

  it("has non-empty, distinct copy for every kind", () => {
    const messages = KINDS.map(curatedMessage);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(KINDS.length);
  });

  it("clears the banner only when the model is available", () => {
    expect(availabilityMessage("available")).toBeNull();
    expect(availabilityMessage("downloadable")).toBe(MODEL_DOWNLOADABLE_MESSAGE);
    expect(availabilityMessage("downloading")).toBe(MODEL_DOWNLOADING_MESSAGE);
    expect(availabilityMessage("unavailable")).toBe(MODEL_UNAVAILABLE_MESSAGE);
  });
});

describe("telemetry identity", () => {
  it("reports the synthetic web model id", () => {
    // The counterpart of `"apple-on-device"` in TelemetryService.swift:16. Chrome exposes no
    // model name, version or revision anywhere on the API.
    expect(WEB_MODEL_NAME).toBe("chrome-on-device");
  });
});
