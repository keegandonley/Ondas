// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelAvailability } from "../../chat/OnDeviceModel";
import { Copy } from "../../ui/copy";
import { SettingsSheet, formatBytes, type SettingsStorage } from "./SettingsSheet";

/**
 * The rebuilt Settings sheet (PORTING.md § Approved additions 2).
 *
 * Three of these assertions exist to stop a specific wrong implementation from being written back
 * in later, each of which looks reasonable in isolation:
 *
 *  - **No quota, bar or percentage.** Chrome's `quota` is synthetic (§ Mandatory drifts 7).
 *  - **Persistent storage is a Request action, not a toggle.** `persist()` is one-way, so a switch
 *    would be a control that cannot be switched back.
 *  - **The delete-all confirm is inline and takes two steps.** `window.confirm` blocks the page and
 *    cannot be driven from a test at all.
 */

afterEach(cleanup);

/**
 * A fake `StoragePersistence`. Injected rather than stubbing `navigator.storage`, so the two
 * Storage rows can be driven independently and `requestPersistent` can be counted.
 *
 * Defined once per test and never rebuilt, because the component documents its `storage` prop as
 * referentially stable — an object literal per render would re-read storage on every render.
 */
function fakeStorage(overrides: Partial<SettingsStorage> = {}): SettingsStorage {
  return {
    isSupported: () => true,
    usage: async () => 0,
    isPersisted: async () => false,
    requestPersistent: async () => false,
    ...overrides,
  };
}

interface SheetOptions {
  availability?: ModelAvailability;
  storage?: SettingsStorage;
  onDeleteAll?: () => void | Promise<void>;
  onClose?: () => void;
  version?: string;
}

async function renderSheet(options: SheetOptions = {}) {
  const onDeleteAll = vi.fn(options.onDeleteAll ?? (() => {}));
  const onClose = vi.fn(options.onClose ?? (() => {}));
  render(
    <SettingsSheet
      availability={options.availability ?? "available"}
      storage={options.storage ?? fakeStorage()}
      onDeleteAll={onDeleteAll}
      onClose={onClose}
      version={options.version ?? "1.2.3"}
    />,
  );
  // Let the mount Effect's storage reads settle before anything is asserted.
  await act(async () => {});
  return { onDeleteAll, onClose };
}

/** Clicks and lets any async handler behind the click settle. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("Model → Status", () => {
  const cases: [ModelAvailability, string][] = [
    ["available", Copy.modelStatusAvailable],
    ["downloadable", Copy.modelStatusDownloadable],
    ["downloading", Copy.modelStatusDownloading],
    ["unavailable", Copy.modelStatusUnavailable],
  ];

  for (const [availability, expected] of cases) {
    it(`humanises "${availability}"`, async () => {
      await renderSheet({ availability });

      expect(screen.getByText(Copy.modelStatus)).toBeTruthy();
      expect(screen.getByText(expected)).toBeTruthy();
    });
  }

  it("gives the four states four distinct strings", () => {
    const rendered = new Set([
      Copy.modelStatusAvailable,
      Copy.modelStatusDownloadable,
      Copy.modelStatusDownloading,
      Copy.modelStatusUnavailable,
    ]);
    expect(rendered.size).toBe(4);
  });
});

describe("Storage → Chats", () => {
  it("formats the reported usage", async () => {
    await renderSheet({ storage: fakeStorage({ usage: async () => 4_200_000 }) });

    expect(screen.getByText(formatBytes(4_200_000))).toBeTruthy();
  });

  /**
   * `usage` is documented as optional and is genuinely absent in some contexts, so a dash rather
   * than "0 bytes" — which would be a false claim that nothing is stored.
   */
  it("shows a dash when the browser will not report a number", async () => {
    await renderSheet({ storage: fakeStorage({ usage: async () => undefined }) });

    expect(screen.getByText(Copy.storageUnknown)).toBeTruthy();
  });

  it("distinguishes an unsupported browser from an unreported number", async () => {
    await renderSheet({
      storage: fakeStorage({ isSupported: () => false, usage: async () => undefined }),
    });

    expect(screen.getByText(Copy.storageUnsupported)).toBeTruthy();
    expect(screen.queryByText(Copy.storageUnknown)).toBeNull();
  });

  /**
   * PORTING.md § Mandatory drifts 7. `StoragePersistence` does not expose `quota` and this sheet
   * must not synthesise capacity UI from anything else: no meter, no progress bar, no percentage.
   * Asserting on the absence of the ROLES as well as the "%" character is what makes this
   * enforceable — a bar added with an `aria-valuenow` fails here even if it renders no text.
   */
  it("never renders a quota, a capacity bar or a percentage", async () => {
    await renderSheet({ storage: fakeStorage({ usage: async () => 4_200_000 }) });

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("%");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(dialog.querySelector("progress")).toBeNull();
  });
});

describe("Storage → Persistent storage", () => {
  it("offers a Request action while the grant has not been made", async () => {
    await renderSheet({ storage: fakeStorage({ isPersisted: async () => false }) });

    expect(screen.getByText(Copy.storagePersistentNotGranted)).toBeTruthy();
    expect(screen.getByRole("button", { name: Copy.storagePersistentRequest })).toBeTruthy();
  });

  /**
   * `persist()` is one-way: there is no API that un-persists. Once granted, offering any control
   * at all would be offering one the user cannot operate — which is exactly what a `Toggle` would
   * be. The action must be GONE, not disabled.
   */
  it("offers no action at all once storage is already persisted", async () => {
    await renderSheet({ storage: fakeStorage({ isPersisted: async () => true }) });

    expect(screen.getByText(Copy.storagePersistentGranted)).toBeTruthy();
    expect(screen.queryByRole("button", { name: Copy.storagePersistentRequest })).toBeNull();
    // A checkbox/switch is the wrong control here for the same reason, so neither may appear.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("asks the browser once and withdraws the action when the grant lands", async () => {
    const requestPersistent = vi.fn(async () => true);
    await renderSheet({ storage: fakeStorage({ isPersisted: async () => false, requestPersistent }) });

    await click(screen.getByRole("button", { name: Copy.storagePersistentRequest }));

    expect(requestPersistent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(Copy.storagePersistentGranted)).toBeTruthy();
    expect(screen.queryByRole("button", { name: Copy.storagePersistentRequest })).toBeNull();
  });

  /**
   * Chrome decides from engagement signals without prompting, so a `false` is a "not yet" rather
   * than a refusal — the action has to stay offered.
   */
  it("keeps the action offered when the browser declines for now", async () => {
    await renderSheet({
      storage: fakeStorage({ isPersisted: async () => false, requestPersistent: async () => false }),
    });

    await click(screen.getByRole("button", { name: Copy.storagePersistentRequest }));

    expect(screen.getByText(Copy.storagePersistentNotGranted)).toBeTruthy();
    expect(screen.getByRole("button", { name: Copy.storagePersistentRequest })).toBeTruthy();
  });
});

describe("Data → Delete all chats", () => {
  it("does not delete on the first press — it asks", async () => {
    const { onDeleteAll } = await renderSheet();

    await click(screen.getByRole("button", { name: Copy.deleteAllChats }));

    expect(onDeleteAll).not.toHaveBeenCalled();
    expect(screen.getByText(Copy.deleteAllChatsConfirm)).toBeTruthy();
  });

  it("deletes only after the confirm is pressed", async () => {
    const { onDeleteAll } = await renderSheet();

    await click(screen.getByRole("button", { name: Copy.deleteAllChats }));
    await click(screen.getByRole("button", { name: Copy.deleteAllChatsAction }));

    expect(onDeleteAll).toHaveBeenCalledTimes(1);
    // The confirm closes again, so a second delete needs both steps again.
    expect(screen.queryByText(Copy.deleteAllChatsConfirm)).toBeNull();
  });

  it("cancels without deleting", async () => {
    const { onDeleteAll } = await renderSheet();

    await click(screen.getByRole("button", { name: Copy.deleteAllChats }));
    await click(screen.getByRole("button", { name: Copy.cancel }));

    expect(onDeleteAll).not.toHaveBeenCalled();
    expect(screen.queryByText(Copy.deleteAllChatsConfirm)).toBeNull();
    expect(screen.getByRole("button", { name: Copy.deleteAllChats })).toBeTruthy();
  });

  it("re-reads usage afterwards rather than leaving a stale size on screen", async () => {
    let stored = 4_200_000;
    const storage = fakeStorage({ usage: async () => stored });
    const { onDeleteAll } = await renderSheet({
      storage,
      onDeleteAll: () => {
        stored = 0;
      },
    });

    await click(screen.getByRole("button", { name: Copy.deleteAllChats }));
    await click(screen.getByRole("button", { name: Copy.deleteAllChatsAction }));

    expect(onDeleteAll).toHaveBeenCalledTimes(1);
    expect(screen.getByText(formatBytes(0))).toBeTruthy();
    expect(screen.queryByText(formatBytes(4_200_000))).toBeNull();
  });
});

describe("dismissal and About", () => {
  it("dismisses from Done", async () => {
    const { onClose } = await renderSheet();

    await click(screen.getByRole("button", { name: Copy.done }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape", async () => {
    const { onClose } = await renderSheet();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the version", async () => {
    await renderSheet({ version: "9.9.9" });

    expect(screen.getByText(Copy.version)).toBeTruthy();
    expect(screen.getByText("9.9.9")).toBeTruthy();
  });
});

describe("formatBytes", () => {
  it("scales through the decimal units its labels actually mean", () => {
    // The labels come from `Intl`, whose units are decimal, so the divisor is 1000 and not 1024.
    expect(formatBytes(512)).toContain("512");
    expect(formatBytes(4_200)).toContain("4.2");
    expect(formatBytes(4_200_000)).toContain("4.2");
    expect(formatBytes(4_200_000_000)).toContain("4.2");
  });

  it("labels each magnitude differently", () => {
    const labels = [formatBytes(512), formatBytes(4_200), formatBytes(4_200_000), formatBytes(4_200_000_000)];
    expect(new Set(labels).size).toBe(4);
  });

  it("stops at the largest unit it knows rather than running off the end", () => {
    // 9e15 bytes is 9,000 TB. The scale must saturate at terabytes, not keep dividing into a unit
    // `Intl` has no name for.
    expect(formatBytes(9e15)).toContain("9,000");
    expect(formatBytes(9e15)).toContain(formatBytes(1e12).replace(/[\d.,\s]/g, ""));
  });
});
