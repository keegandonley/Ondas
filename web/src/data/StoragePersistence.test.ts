import { afterEach, describe, expect, it, vi } from "vitest";

import { StoragePersistence } from "./StoragePersistence";

/*
 * There is no `navigator.storage` in Node — the real `globalThis.navigator` exists but carries no
 * `storage` at all, which is exactly the "absent" case this module has to survive. The API is
 * therefore stubbed, and the stub reproduces only what the platform actually does, including
 * `estimate()` returning a `quota` that this module must not pass on.
 */

type Estimate = { usage?: number; quota?: number };

function stubStorage(storage: object | undefined): void {
  vi.stubGlobal("navigator", storage === undefined ? {} : { storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StoragePersistence.usage", () => {
  it("returns estimate().usage", async () => {
    stubStorage({ estimate: async (): Promise<Estimate> => ({ usage: 4096, quota: 10_737_418_240 }) });
    expect(await StoragePersistence.usage()).toBe(4096);
  });

  /**
   * PORTING.md § Mandatory drifts 7. Chrome's `quota` is synthetic — roughly 10 GiB regardless of
   * the real allowance — while the enforced limit is about 60% of free disk. A capacity bar, an
   * eviction heuristic or a "running low" warning built on it would be wrong in both directions,
   * so the number does not leave this module. `usage()` returns a plain number, and there is no
   * other function to reach it through.
   *
   * This asserts the *shape* of the return value, which is what makes the drift enforceable: if
   * someone widens `usage()` to `{ usage, quota }`, or adds a `quota()` alongside it, this fails.
   */
  it("never exposes quota", async () => {
    stubStorage({ estimate: async (): Promise<Estimate> => ({ usage: 4096, quota: 10_737_418_240 }) });

    expect(await StoragePersistence.usage()).toBe(4096);
    expect(Object.keys(StoragePersistence).sort()).toEqual([
      "isPersisted",
      "isSupported",
      "requestPersistent",
      "usage",
    ]);
  });

  it("returns undefined when the browser reports no usage", async () => {
    stubStorage({ estimate: async (): Promise<Estimate> => ({ quota: 10_737_418_240 }) });
    // A dash in the UI, not "0 bytes" — which would be a false claim that nothing is stored.
    expect(await StoragePersistence.usage()).toBeUndefined();
  });

  it("returns undefined when estimate() rejects", async () => {
    // Some privacy modes reject rather than answering. The store still works; there is nothing to
    // surface and nothing the user could do.
    stubStorage({
      estimate: async (): Promise<Estimate> => {
        throw new Error("denied");
      },
    });
    expect(await StoragePersistence.usage()).toBeUndefined();
  });

  it("returns undefined when navigator.storage is absent", async () => {
    stubStorage(undefined);
    expect(await StoragePersistence.usage()).toBeUndefined();
  });

  it("returns undefined when there is no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await StoragePersistence.usage()).toBeUndefined();
  });

  it("returns undefined when storage exists without estimate", async () => {
    stubStorage({ persisted: async () => true });
    expect(await StoragePersistence.usage()).toBeUndefined();
  });
});

describe("StoragePersistence.isSupported", () => {
  it("is true only when estimate() is callable", async () => {
    stubStorage({ estimate: async (): Promise<Estimate> => ({ usage: 1 }) });
    expect(StoragePersistence.isSupported()).toBe(true);

    stubStorage({ persisted: async () => true });
    expect(StoragePersistence.isSupported()).toBe(false);

    stubStorage(undefined);
    expect(StoragePersistence.isSupported()).toBe(false);

    vi.stubGlobal("navigator", undefined);
    expect(StoragePersistence.isSupported()).toBe(false);
  });
});

describe("StoragePersistence.isPersisted", () => {
  it("reports what the browser reports", async () => {
    stubStorage({ persisted: async () => true });
    expect(await StoragePersistence.isPersisted()).toBe(true);

    stubStorage({ persisted: async () => false });
    expect(await StoragePersistence.isPersisted()).toBe(false);
  });

  it("is false where unsupported or failing, never a claimed guarantee", async () => {
    stubStorage({});
    expect(await StoragePersistence.isPersisted()).toBe(false);

    stubStorage(undefined);
    expect(await StoragePersistence.isPersisted()).toBe(false);

    stubStorage({
      persisted: async (): Promise<boolean> => {
        throw new Error("denied");
      },
    });
    expect(await StoragePersistence.isPersisted()).toBe(false);
  });
});

describe("StoragePersistence.requestPersistent", () => {
  it("returns the grant decision", async () => {
    stubStorage({ persist: async () => true });
    expect(await StoragePersistence.requestPersistent()).toBe(true);

    // Chrome decides from engagement signals without prompting, so `false` is "not yet" rather
    // than a refusal — the Settings Request action can stay offered.
    stubStorage({ persist: async () => false });
    expect(await StoragePersistence.requestPersistent()).toBe(false);
  });

  it("is false where unsupported or failing", async () => {
    stubStorage({});
    expect(await StoragePersistence.requestPersistent()).toBe(false);

    stubStorage(undefined);
    expect(await StoragePersistence.requestPersistent()).toBe(false);

    stubStorage({
      persist: async (): Promise<boolean> => {
        throw new Error("denied");
      },
    });
    expect(await StoragePersistence.requestPersistent()).toBe(false);
  });

  /**
   * `persist()` is one-way: the platform has no un-persist call, so the Settings row is a status
   * plus a Request action, never a `Toggle` (PORTING.md § Approved additions 2). Nothing here may
   * imply reversibility — a `setPersistent(false)` would be a control the user cannot switch back.
   */
  it("offers no way to un-persist", () => {
    const surface = Object.keys(StoragePersistence);
    expect(surface).not.toContain("setPersistent");
    expect(surface).not.toContain("releasePersistent");
    expect(surface.filter((name) => name.toLowerCase().includes("persist")).sort()).toEqual([
      "isPersisted",
      "requestPersistent",
    ]);
  });

  it("asks the browser once per call rather than caching a stale grant", async () => {
    let calls = 0;
    stubStorage({
      persist: async () => {
        calls += 1;
        return false;
      },
    });

    await StoragePersistence.requestPersistent();
    await StoragePersistence.requestPersistent();
    expect(calls).toBe(2);
  });
});
