"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { ModelAvailability } from "../../chat/OnDeviceModel";
import { StoragePersistence } from "../../data/StoragePersistence";
import { Copy } from "../../ui/copy";
import packageJson from "../../../package.json";

/**
 * The rebuilt Settings sheet — **PORTING.md § Approved additions 2**, not a port.
 *
 * `Ondas/Features/Settings/SettingsView.swift` has six rows and not one of them survives the
 * crossing: iCloud Sync (`SettingsView.swift:42-47`) has no counterpart because storage is
 * local-only (§ Mandatory drifts 2); Response style (`:49-58`) has none because the Prompt API has
 * no sampling control that functions (§ There is no sampling control, § Mandatory drifts 6); and
 * the four telemetry rows (`:60-121`) have none because telemetry is stubbed to an interface. The
 * sheet is kept and refilled rather than deleted, with the five rows PORTING.md names.
 *
 * ## Two constraints that shape the content, both of which have an obvious wrong answer
 *
 * **Storage → Chats shows usage and never a quota, a bar or a percentage.** Chrome reports a
 * synthetic `quota` of roughly 10 GiB regardless of the real allowance while the enforced limit is
 * about 60% of free disk (§ Mandatory drifts 7). `StoragePersistence` does not expose the number
 * at all, deliberately, and this file does not reach around it to `navigator.storage` for it.
 *
 * **Persistent storage is a status plus a Request action, never a `Toggle`.**
 * `navigator.storage.persist()` grants and nothing revokes. A switch is the obvious-looking
 * implementation and it would be a control the user cannot switch back, so the action disappears
 * once granted.
 *
 * Swift's `.onDisappear(perform: save)` (`:139`) has nothing to carry here: every row on this sheet
 * either reports a live reading or performs its action immediately, so there is no draft state that
 * a dismissal could discard. If an editable row is ever added, the save must hang off dismissal
 * rather than off the Done button, the way Android's `DisposableEffect` does.
 */

/**
 * The slice of `StoragePersistence` this sheet uses.
 *
 * A port rather than a direct import so tests can inject a fake instead of stubbing
 * `navigator.storage` — a global stub would make the two Storage rows testable only in lockstep,
 * and `requestPersistent()` in particular has to be observed being called exactly once.
 */
export interface SettingsStorage {
  isSupported(): boolean;
  usage(): Promise<number | undefined>;
  isPersisted(): Promise<boolean>;
  requestPersistent(): Promise<boolean>;
}

export interface SettingsSheetProps {
  /** `LanguageModel.availability()`'s current answer, humanised for the Model → Status row. */
  availability: ModelAvailability;

  /** Deletes every conversation. Called only after the inline confirm's second step. */
  onDeleteAll: () => void | Promise<void>;

  /** Dismisses the sheet — the Done button, the scrim and Escape all route through this. */
  onClose: () => void;

  /**
   * Defaults to the real Storage API. **Must be referentially stable across renders**: it is the
   * dependency of the one Effect here, so a fresh object literal per render would re-read storage
   * on every render. The default is a module singleton and therefore stable by construction.
   */
  storage?: SettingsStorage;

  /** Defaults to `web/package.json`'s version, so the About row cannot drift from the build. */
  version?: string;
}

/** The two readings the Storage section makes, kept together so one render shows one snapshot. */
interface StorageReading {
  usage: number | undefined;
  isPersisted: boolean;
}

export function SettingsSheet({
  availability,
  onDeleteAll,
  onClose,
  storage = StoragePersistence,
  version = packageJson.version,
}: SettingsSheetProps) {
  const [reading, setReading] = useState<StorageReading | null>(null);
  const [isConfirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const confirmId = useId();

  // Reading the Storage API is synchronising with an external system, which is what an Effect is
  // for; `ignore` is the standard guard against a reading landing after the sheet has gone.
  // Everything else on this sheet happens because the user did something, so it lives in a
  // handler — there is deliberately no second Effect chaining off this one.
  useEffect(() => {
    let ignore = false;
    void (async () => {
      // Concurrent, not sequential: they are independent reads and the sheet shows both at once.
      const [usage, isPersisted] = await Promise.all([storage.usage(), storage.isPersisted()]);
      if (!ignore) setReading({ usage, isPersisted });
    })();
    return () => {
      ignore = true;
    };
  }, [storage]);

  // A modal that opens without moving focus leaves the keyboard behind on whatever opened it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const refreshUsage = useCallback(async (): Promise<void> => {
    const usage = await storage.usage();
    setReading((previous) => ({ usage, isPersisted: previous?.isPersisted ?? false }));
  }, [storage]);

  const handleRequestPersistent = async (): Promise<void> => {
    const granted = await storage.requestPersistent();
    // Chrome decides from engagement signals without prompting, so `false` is a "not yet" and the
    // Request action stays offered. See `StoragePersistence.requestPersistent`.
    setReading((previous) => ({ usage: previous?.usage, isPersisted: granted }));
  };

  const handleDeleteAll = async (): Promise<void> => {
    await onDeleteAll();
    setConfirmingDeleteAll(false);
    // The size just changed; leaving the old number on screen would be a stale claim.
    await refreshUsage();
  };

  const supported = storage.isSupported();
  const usageText = supported
    ? reading?.usage === undefined
      ? Copy.storageUnknown
      : formatBytes(reading.usage)
    : Copy.storageUnsupported;
  const isPersisted = reading?.isPersisted ?? false;

  return (
    <div
      className={css.scrim}
      style={styles.scrim}
      // A click on the backdrop dismisses, as a scrim tap does on both other platforms. Guarded on
      // the target so a click that started inside the panel does not close it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <style>{stylesheet}</style>
      <div
        ref={dialogRef}
        className={css.panel}
        style={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header style={styles.header}>
          <h2 id={titleId} style={styles.title}>
            {Copy.settingsTitle}
          </h2>
          <button type="button" className={css.textButton} style={styles.textButton} onClick={onClose}>
            {Copy.done}
          </button>
        </header>

        <Section title={Copy.modelSection}>
          <Row label={Copy.modelStatus}>
            <span style={styles.value}>{MODEL_STATUS_COPY[availability]}</span>
          </Row>
        </Section>

        <Section title={Copy.storageSection} footer={Copy.storagePersistentFooter}>
          <Row label={Copy.storageChats}>
            <span style={styles.value}>{usageText}</span>
          </Row>
          <Row label={Copy.storagePersistent}>
            <span style={styles.value}>
              {isPersisted ? Copy.storagePersistentGranted : Copy.storagePersistentNotGranted}
            </span>
            {/* One-way: once granted there is nothing to offer, because there is no API that
                un-persists. A `Toggle` here would be a control that cannot be switched back. */}
            {!isPersisted && (
              <button
                type="button"
                className={css.textButton}
                style={styles.textButton}
                onClick={() => void handleRequestPersistent()}
              >
                {Copy.storagePersistentRequest}
              </button>
            )}
          </Row>
        </Section>

        <Section title={Copy.dataSection}>
          {isConfirmingDeleteAll ? (
            // An inline two-step confirm rather than `window.confirm`: the native dialog blocks the
            // page, cannot be styled, and cannot be driven from a test at all.
            <div style={styles.confirm}>
              <p id={confirmId} style={styles.confirmText}>
                {Copy.deleteAllChatsConfirm}
              </p>
              <div style={styles.confirmActions}>
                <button
                  type="button"
                  className={css.textButton}
                  style={styles.textButton}
                  onClick={() => setConfirmingDeleteAll(false)}
                >
                  {Copy.cancel}
                </button>
                <button
                  type="button"
                  className={css.destructiveButton}
                  style={styles.destructiveButton}
                  onClick={() => void handleDeleteAll()}
                  aria-describedby={confirmId}
                >
                  {Copy.deleteAllChatsAction}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={css.destructiveRow}
              style={styles.destructiveRow}
              onClick={() => setConfirmingDeleteAll(true)}
            >
              {Copy.deleteAllChats}
            </button>
          )}
        </Section>

        <Section title={Copy.aboutSection}>
          <Row label={Copy.version}>
            <span style={styles.value}>{version}</span>
          </Row>
        </Section>
      </div>
    </div>
  );
}

/**
 * `LanguageModel.availability()`'s four states, humanised.
 *
 * An exhaustive `Record` rather than a `switch` with a default: if Chrome's union ever gains a
 * state, this stops compiling instead of silently rendering nothing. Keying off the union member
 * and never off a message string is the same rule PORTING.md § Approved additions 1 sets for the
 * unsupported-browser state, for the same reason — rewording copy must not remove a state.
 */
const MODEL_STATUS_COPY: Record<ModelAvailability, string> = {
  available: Copy.modelStatusAvailable,
  downloadable: Copy.modelStatusDownloadable,
  downloading: Copy.modelStatusDownloading,
  unavailable: Copy.modelStatusUnavailable,
};

/**
 * A byte count for the Storage → Chats row.
 *
 * Decimal (1000) rather than binary (1024) because the unit labels come from `Intl.NumberFormat`'s
 * sanctioned units, which are decimal — `kB` is 1000 bytes, and there is no `KiB` in Intl. Dividing
 * by 1024 under a `kB` label would be quietly wrong by 2.4% and by 7.4% at `GB`. Going through
 * `Intl` also means the row carries no hard-coded unit strings to localise later.
 *
 * Exported so the scale is testable directly; the row itself only ever shows one value.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = "byte";
  for (const candidate of ["kilobyte", "megabyte", "gigabyte", "terabyte"]) {
    if (value < 1000) break;
    value /= 1000;
    unit = candidate;
  }
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

/** A `Form` section: a header, its rows, and an optional explanatory footer. Swift's `Section`. */
function Section({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} style={styles.section}>
      <h3 id={headingId} style={styles.sectionTitle}>
        {title}
      </h3>
      <div style={styles.sectionBody}>{children}</div>
      {footer !== undefined && <p style={styles.footer}>{footer}</p>}
    </section>
  );
}

/** Swift's `LabeledContent`: a label on the left, its value and any action on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowValue}>{children}</span>
    </div>
  );
}

/*
 * Styling — inline style objects plus one `<style>` element for the states inline styles cannot
 * express. Every colour is a `var(--ondas-*)` custom property from app/globals.css; sizes are in
 * `rem` so browser text scaling moves the layout with the text.
 *
 * ## The destructive tint is a known gap
 *
 * Swift's `Button(role: .destructive)` resolves to `systemRed` in the OS. `ThemePalette` has no
 * destructive role — it transcribes only the roles the SwiftUI code named, and `.destructive`
 * names none — so the palette carries no red. The delete-all affordances therefore use
 * `--ondas-destructive` (`systemOrange`), which is the only alarm-coloured token that exists.
 * Hard-coding a red here was the alternative and it would step outside the asset-catalog chain
 * `Theme.test.ts` closes. The right fix is a `destructive` entry in `ThemePalette` and
 * app/globals.css, which is W8's file to change, not this one's.
 */

const css = {
  scrim: "ondas-set-scrim",
  panel: "ondas-set-panel",
  textButton: "ondas-set-text-button",
  destructiveButton: "ondas-set-destructive-button",
  destructiveRow: "ondas-set-destructive-row",
} as const;

const stylesheet = `
.${css.scrim} :focus-visible {
  outline: 2px solid var(--ondas-accent);
  outline-offset: 2px;
  border-radius: 0.375rem;
}
.${css.panel}:focus {
  outline: none;
}
.${css.textButton}:hover {
  text-decoration: underline;
}
`;

const styles = {
  scrim: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.35)",
    padding: "0",
  },
  panel: {
    width: "min(32rem, 100%)",
    maxHeight: "85vh",
    overflowY: "auto",
    padding: "1.25rem 1.25rem 2rem",
    borderTopLeftRadius: "1rem",
    borderTopRightRadius: "1rem",
    background: "var(--ondas-background)",
    color: "var(--ondas-label)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    paddingBottom: "0.75rem",
  },
  title: {
    flex: 1,
    margin: 0,
    fontSize: "1.0625rem",
    fontWeight: 600,
  },
  section: {
    paddingTop: "1.25rem",
  },
  sectionTitle: {
    margin: "0 0 0.5rem",
    fontSize: "0.8125rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "var(--ondas-secondary-label)",
  },
  sectionBody: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "0.75rem",
    background: "var(--ondas-assistant-bubble)",
    overflow: "hidden",
  },
  footer: {
    margin: "0.5rem 0 0",
    fontSize: "0.8125rem",
    color: "var(--ondas-secondary-label)",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    minHeight: "2.75rem",
    padding: "0.5rem 0.875rem",
  },
  rowLabel: {
    flex: 1,
    fontSize: "1rem",
  },
  rowValue: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  value: {
    fontSize: "1rem",
    color: "var(--ondas-secondary-label)",
  },
  textButton: {
    padding: "0.25rem 0",
    border: "none",
    background: "transparent",
    color: "var(--ondas-accent)",
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  },
  destructiveRow: {
    minHeight: "2.75rem",
    padding: "0.5rem 0.875rem",
    border: "none",
    background: "transparent",
    color: "var(--ondas-destructive)",
    font: "inherit",
    fontSize: "1rem",
    textAlign: "left",
    cursor: "pointer",
  },
  confirm: {
    padding: "0.75rem 0.875rem",
  },
  confirmText: {
    margin: "0 0 0.75rem",
    fontSize: "0.9375rem",
  },
  confirmActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "1rem",
    alignItems: "center",
  },
  destructiveButton: {
    padding: "0.375rem 0.875rem",
    border: "none",
    borderRadius: "0.5rem",
    background: "var(--ondas-destructive)",
    color: "var(--ondas-on-user-bubble)",
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  },
} as const satisfies Record<string, CSSProperties>;
