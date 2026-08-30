/**
 * The Storage API, behind four functions.
 *
 * Feeds two of the rebuilt Settings rows (PORTING.md § Approved additions 2) — *Chats*, which
 * shows how much space the store uses, and *Persistent storage*, which shows whether the browser
 * has promised not to evict it. Neither has a Swift counterpart: iOS gives an app its container
 * unconditionally, so there is nothing there to report or to ask for.
 *
 * ## `quota` is not exposed, and must not be added
 *
 * `navigator.storage.estimate()` returns `{ usage, quota }` and only `usage` is real.
 * **PORTING.md § Mandatory drifts 7**: Chrome reports a synthetic quota of roughly 10 GiB
 * regardless of the actual allowance — the spike measured exactly 10242 MB, which is the tell —
 * while the *enforced* limit is about 60% of free disk. So the number is not merely imprecise; it
 * is unrelated to the limit the user will actually hit.
 *
 * Anything built on it inherits that. A percentage bar would be wrong in both directions: it would
 * read 0.4% while the browser was about to start evicting, and it would never fill on a machine
 * where the real limit was far lower. An eviction heuristic ("compact when 80% full") would never
 * fire. A "running low" warning would never show. Each of those looks like a reasonable feature
 * request and each is unimplementable on this platform, which is why the field is absent from this
 * module rather than exposed with a warning comment at the call site — an unexported number cannot
 * be used by mistake.
 *
 * If capacity UI is ever genuinely needed, the honest input is [usage] plotted against a *policy*
 * number this app chooses, not against anything the browser reports.
 *
 * ## Persistence is one-way
 *
 * There is no un-persist API. `persist()` grants; nothing revokes. The Settings row is therefore a
 * status plus a **Request** action that disappears once granted, never a `Toggle` — a toggle is
 * the obvious-looking implementation and it would be a control the user cannot switch back.
 * Nothing in this module returns anything that implies reversibility, and nothing should be added
 * that does.
 */

/**
 * The slice of `StorageManager` this module uses.
 *
 * Declared locally, and every member optional, because the lib DOM type asserts a shape the
 * runtime does not guarantee: `navigator.storage` is absent in some browsers and some contexts
 * (notably a non-secure origin), and `persist`/`persisted` can be missing even where `estimate`
 * exists. Typing them as required would let a `TypeError` through the type system on exactly the
 * paths this module exists to make safe.
 */
interface StorageManagerLike {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

function storageManager(): StorageManagerLike | undefined {
  // `globalThis.navigator` rather than the bare binding: this module is imported by tests running
  // under Node, where `navigator` exists but carries no `storage`, and by any future non-DOM
  // context where it does not exist at all.
  return (globalThis.navigator as { storage?: StorageManagerLike } | undefined)?.storage;
}

export const StoragePersistence = {
  /**
   * Whether this browser reports storage information at all. The Settings rows key off this rather
   * than off an `undefined` reading, so "not supported here" and "supported but returned nothing"
   * stay distinguishable.
   */
  isSupported(): boolean {
    return typeof storageManager()?.estimate === "function";
  },

  /**
   * Bytes the origin currently occupies, or `undefined` when the browser will not say.
   *
   * `estimate().usage` **only** — see the note on `quota` above.
   *
   * `usage` is documented as optional and is genuinely absent in some contexts, so `undefined` is
   * a real answer here and not merely an error case; the Settings row shows a dash rather than
   * "0 bytes", which would be a false claim that the user has no chats stored.
   */
  async usage(): Promise<number | undefined> {
    const manager = storageManager();
    if (manager?.estimate === undefined) return undefined;
    try {
      return (await manager.estimate()).usage;
    } catch {
      // `estimate()` rejects in some privacy modes. That is a "cannot report", not a failure worth
      // surfacing — the store itself still works, and there is nothing the user could do about it.
      return undefined;
    }
  },

  /**
   * Whether the browser has promised not to evict this origin's storage under pressure.
   *
   * `false` where unsupported. That is the safe reading in both directions: it is what an
   * unpersisted origin reports anyway, and it never claims a guarantee the browser has not made.
   */
  async isPersisted(): Promise<boolean> {
    const manager = storageManager();
    if (manager?.persisted === undefined) return false;
    try {
      return await manager.persisted();
    } catch {
      return false;
    }
  },

  /**
   * Asks the browser for persistent storage, returning whether it was granted.
   *
   * **One-way.** There is no counterpart that revokes it, deliberately: none exists on the
   * platform, and a `setPersistent(false)` on this object would be a lie that Settings would then
   * render as a toggle.
   *
   * Chrome decides without prompting, from site engagement signals, so a `false` here is a
   * "not yet" rather than a refusal — the Request action can stay offered. Unsupported also
   * returns `false`, which keeps the call site from having to distinguish two ways of not
   * currently being persisted.
   */
  async requestPersistent(): Promise<boolean> {
    const manager = storageManager();
    if (manager?.persist === undefined) return false;
    try {
      return await manager.persist();
    } catch {
      return false;
    }
  },
} as const;
