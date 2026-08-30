"use client";

import { useState } from "react";
import { ModelError, isCancellation } from "@/src/chat/OnDeviceModel";
import {
  PromptApiModel,
  type LanguageModelGlobal,
  type LanguageModelStream,
} from "@/src/chat/PromptApiModel";

/**
 * The debug probe: re-runs the Chrome 152 spike in the app.
 *
 * web/PORTING.md publishes a table of measured facts about the Prompt API and says, in bold,
 * **reproduce it before trusting any of it**. This route is that tool. It exists because two
 * published facts about this API are wrong and because `create()` validates nothing — it
 * accepted `{ totallyMadeUpOption: 12345 }` — so "the code runs" is not evidence that any of it
 * behaves as documented.
 *
 * The raw checks deliberately talk to `LanguageModel` directly rather than through
 * [PromptApiModel]. A probe that ran through the wrapper would confirm the wrapper agrees with
 * itself, which is exactly the reassurance that is worth nothing. Only the taxonomy section uses
 * the wrapper, because the mapping is what it is checking.
 *
 * Plain and unstyled on purpose. This is a diagnostic, not product UI.
 */

type Verdict = "pass" | "fail" | "info" | "skip";

interface ProbeRow {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

const VERDICT_MARK: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  info: "INFO",
  skip: "SKIP",
};

/** A prompt comfortably past a 9216-token window. */
const OVERSIZE_PROMPT = "the quick brown fox jumps over the lazy dog. ".repeat(2000);

function lookup(): LanguageModelGlobal | undefined {
  return (globalThis as { LanguageModel?: LanguageModelGlobal }).LanguageModel;
}

/** Accepts either an async-iterable stream or one that only exposes `getReader()`. */
async function readAll(stream: LanguageModelStream): Promise<string[]> {
  const chunks: string[] = [];
  if (Symbol.asyncIterator in stream) {
    for await (const chunk of stream as AsyncIterable<string>) chunks.push(chunk);
    return chunks;
  }
  const reader = (stream as ReadableStream<string>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      if (value !== undefined) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Describes an unknown throw without ever printing its message — it can echo the prompt. */
function describe(error: unknown): string {
  if (error instanceof ModelError) {
    const sizes =
      error.requested !== undefined || error.quota !== undefined
        ? ` requested=${String(error.requested)} quota=${String(error.quota)}`
        : "";
    return `ModelError kind=${error.kind} label=${error.diagnosticLabel}${sizes}`;
  }
  if (typeof error === "object" && error !== null) {
    const named = error as { name?: unknown; constructor?: { name?: string } };
    if (typeof named.name === "string") return named.name;
    return named.constructor?.name ?? "unknown throw";
  }
  return typeof error;
}

export default function ProbePage() {
  const [rows, setRows] = useState<readonly ProbeRow[]>([]);
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    setRunning(true);
    setRows([]);
    const add = (row: ProbeRow): void => {
      setRows((current) => [...current, row]);
    };
    try {
      await probe(add);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ padding: "2rem", maxWidth: "60rem", fontFamily: "monospace" }}>
      <h1>Prompt API probe</h1>
      <p style={{ fontFamily: "system-ui" }}>
        Re-runs the spike recorded in <code>web/PORTING.md</code> against this browser. Nothing
        here is cached and nothing is inferred from the absence of an error &mdash;{" "}
        <code>create()</code> validates nothing, so every claim is checked by behaviour.
      </p>
      <button type="button" onClick={() => void run()} disabled={running}>
        {running ? "Running…" : "Run probe"}
      </button>
      <table style={{ marginTop: "1.5rem", borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.name}-${String(index)}`} style={{ verticalAlign: "top" }}>
              <td style={CELL}>{VERDICT_MARK[row.verdict]}</td>
              <td style={CELL}>{row.name}</td>
              <td style={{ ...CELL, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {row.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !running ? (
        <p style={{ fontFamily: "system-ui" }}>No results yet.</p>
      ) : null}
    </main>
  );
}

const CELL: React.CSSProperties = {
  border: "1px solid currentColor",
  padding: "0.35rem 0.6rem",
};

/**
 * The probe itself, in the order the spike ran: what exists, then what it reports, then the
 * streaming shape, then the error taxonomy.
 */
async function probe(add: (row: ProbeRow) => void): Promise<void> {
  const api = lookup();
  const model = new PromptApiModel();

  add({
    name: "LanguageModel global",
    verdict: api === undefined ? "fail" : "pass",
    detail:
      api === undefined
        ? "absent — this browser cannot run Ondas. Expected in Safari and Firefox; the app's unsupported state keys off this probe, never off a message string."
        : `present, statics: ${Object.getOwnPropertyNames(Object.getPrototypeOf(api) as object)
            .concat(Object.getOwnPropertyNames(api))
            .filter((key) => key !== "constructor")
            .join(", ")}`,
  });

  add({
    name: "availability()",
    verdict: "info",
    detail: await model.availability(),
  });

  if (api === undefined) {
    // Still worth showing: this is the path Safari and Firefox take, and it must classify
    // rather than throw something raw at the UI.
    add({
      name: "operations without the API",
      verdict: "info",
      detail: describe(await capture(() => model.createSession())),
    });
    return;
  }

  const window = await capture(() => model.contextWindow());
  add({
    name: "contextWindow",
    verdict: typeof window === "number" ? "pass" : "fail",
    detail:
      typeof window === "number"
        ? `${String(window)} — read at runtime. The spike measured 9216; a hard-coded constant would silently mis-size the capacity model when Chrome ships a new revision.`
        : describe(window),
  });

  add({
    name: "LanguageModel.params()",
    verdict: "info",
    detail:
      "params" in api
        ? "PRESENT — contradicts PORTING.md. Re-measure before relying on either."
        : "absent, as measured. The published docs are wrong about this.",
  });

  const session = await capture(() => api.create({}));
  if (session instanceof Error || !isSessionHandle(session)) {
    add({ name: "create()", verdict: "fail", detail: describe(session) });
    return;
  }

  add({
    name: "session members",
    verdict: "info",
    detail: memberNames(session).join(", "),
  });

  add({
    name: "token accounting names",
    verdict: "contextUsage" in session && !("inputUsage" in session) ? "pass" : "fail",
    detail:
      "contextUsage/contextWindow/measureContextUsage expected; inputUsage/inputQuota/measureInputUsage were renamed away and are the widely published (wrong) names.",
  });

  // --- Streaming shape: the one that would have been a silent truncation bug. ---
  const chunks = await capture(() =>
    readAll(session.promptStreaming("Count from one to five, one word per line.")),
  );
  if (Array.isArray(chunks)) {
    const cumulative = looksCumulative(chunks);
    add({
      name: "promptStreaming shape",
      verdict: cumulative ? "fail" : "pass",
      detail: cumulative
        ? "CUMULATIVE SNAPSHOTS — this contradicts the spike. ModelSession.stream concatenates, so a snapshot stream would render the reply repeated. Stop and re-measure before shipping."
        : `DELTAS, as measured. Callers concatenate; assigning the last chunk renders only its final fragment, with no error anywhere.\nfirst chunks: ${JSON.stringify(chunks.slice(0, 6))}\nlast chunk: ${JSON.stringify(chunks.at(-1))}\nconcatenated: ${JSON.stringify(chunks.join(""))}`,
    });
  } else {
    add({ name: "promptStreaming shape", verdict: "fail", detail: describe(chunks) });
  }

  add({
    name: "contextUsage after a turn",
    verdict: "info",
    detail: `${String(session.contextUsage)} of ${String(session.contextWindow)}, read live and synchronously`,
  });

  const measured = await capture(() => session.measureContextUsage(OVERSIZE_PROMPT));
  add({
    name: "measureContextUsage on oversize input",
    verdict: typeof measured === "number" ? "pass" : "fail",
    detail:
      typeof measured === "number"
        ? `${String(measured)} tokens against a ${String(session.contextWindow)} window, returned without throwing. It is a measurement, not a validation.`
        : `threw ${describe(measured)} — contradicts the spike, which got a number back for ~20k tokens.`,
  });

  session.destroy();

  // --- The error taxonomy, through the wrapper, since the mapping is what is under test. ---
  const seeded = await capture(() =>
    model.createSession({
      systemPrompt: "You are a probe. Answer in one word.",
      history: [
        { role: "user", content: "My favourite colour is vermilion." },
        { role: "assistant", content: "Noted." },
      ],
    }),
  );
  if (seeded instanceof Error || !isModelSession(seeded)) {
    add({ name: "createSession(history)", verdict: "fail", detail: describe(seeded) });
    return;
  }

  const recall = await capture(() => seeded.generate("What is my favourite colour?"));
  add({
    name: "history seeding",
    verdict:
      typeof recall === "string" && recall.toLowerCase().includes("vermilion") ? "pass" : "info",
    detail:
      typeof recall === "string"
        ? `recall answer: ${JSON.stringify(recall.slice(0, 120))}`
        : describe(recall),
  });

  add({
    name: "oversize prompt → REQUEST_TOO_LARGE",
    verdict: "info",
    detail: describe(await capture(() => seeded.generate(OVERSIZE_PROMPT))),
  });

  const controller = new AbortController();
  const aborted = await capture(async () => {
    for await (const chunk of seeded.stream("Write a long story about the sea.", {
      signal: controller.signal,
    })) {
      void chunk;
      controller.abort();
    }
  });
  add({
    name: "abort → cancellation, not a ModelError",
    verdict: isCancellation(aborted) && !(aborted instanceof ModelError) ? "pass" : "fail",
    detail: `${describe(aborted)} — must stay distinguishable from a failed turn, or every cancelled turn gets painted with an error message it never had.`,
  });

  seeded.destroy();
  add({
    name: "prompt after destroy → SESSION_DESTROYED",
    verdict: "info",
    detail: describe(await capture(() => seeded.generate("still there?"))),
  });
}

/** Returns the thrown value instead of throwing, so one failed check cannot end the probe. */
async function capture<T>(run: () => Promise<T>): Promise<T | unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

/**
 * Cumulative snapshots each contain the previous one as a prefix and grow. Apple's stream looks
 * like this; Chrome's does not.
 */
function looksCumulative(chunks: readonly string[]): boolean {
  if (chunks.length < 2) return false;
  return chunks.every((chunk, index) => {
    if (index === 0) return true;
    const previous = chunks[index - 1] ?? "";
    return chunk.length > previous.length && chunk.startsWith(previous);
  });
}

function memberNames(value: object): string[] {
  const own = Object.getOwnPropertyNames(value);
  const proto = Object.getPrototypeOf(value) as object | null;
  const inherited = proto === null ? [] : Object.getOwnPropertyNames(proto);
  return [...new Set([...own, ...inherited])].filter((key) => key !== "constructor").sort();
}

function isSessionHandle(
  value: unknown,
): value is import("@/src/chat/PromptApiModel").LanguageModelSessionHandle {
  return typeof value === "object" && value !== null && "promptStreaming" in value;
}

function isModelSession(
  value: unknown,
): value is import("@/src/chat/OnDeviceModel").ModelSession {
  return typeof value === "object" && value !== null && "stream" in value;
}
