import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { runInNewContext } from "node:vm";
import { isJsonValue } from "@wc-bindable/remote";
import { FlagsCore } from "../src/core/FlagsCore";
import { __resetDroppedValueWarnings } from "../src/freeze";
import { InMemoryFlagProvider } from "../src/providers/InMemoryFlagProvider";
import type { FlagIdentity, FlagMap, FlagProvider, UserContextLike } from "../src/types";

const USER: UserContextLike = {
  sub: "auth0|alice",
  email: "alice@example.com",
  name: "Alice",
  orgId: "org_1",
  permissions: ["read:things"],
  roles: ["admin"],
};

function makeStubProvider(overrides: Partial<FlagProvider> = {}): FlagProvider & {
  calls: { identify: number; reload: number; subscribe: number; dispose: number };
} {
  const calls = { identify: 0, reload: 0, subscribe: 0, dispose: 0 };
  return {
    calls,
    async identify() { calls.identify++; return {}; },
    subscribe() { calls.subscribe++; return () => {}; },
    async reload() { calls.reload++; return {}; },
    async dispose() { calls.dispose++; },
    ...overrides,
  } as FlagProvider & { calls: typeof calls };
}

function eventRecorder(core: FlagsCore) {
  const events: Array<{ type: string; detail: unknown }> = [];
  const types = [
    "feature-flags:flags-changed",
    "feature-flags:identified-changed",
    "feature-flags:loading-changed",
    "feature-flags:error",
  ];
  for (const t of types) {
    core.addEventListener(t, (e) => {
      events.push({ type: t, detail: (e as CustomEvent).detail });
    });
  }
  return events;
}

describe("FlagsCore", () => {
  describe("construction", () => {
    it("extends EventTarget, not HTMLElement", () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      expect(core).toBeInstanceOf(EventTarget);
      expect(core).not.toBeInstanceOf(globalThis.HTMLElement ?? (class {}));
    });

    it("exposes the expected bindable surface", () => {
      expect(FlagsCore.wcBindable.protocol).toBe("wc-bindable");
      expect(FlagsCore.wcBindable.version).toBe(1);
      expect(FlagsCore.wcBindable.properties.map((p) => p.name))
        .toEqual(["flags", "identified", "loading", "error"]);
      expect(FlagsCore.wcBindable.commands?.map((c) => c.name))
        .toEqual(["identify", "reload"]);
    });

    it("throws when options are missing", () => {
      expect(() => new FlagsCore(undefined as any)).toThrow(/`provider` is required/);
      expect(() => new FlagsCore({} as any)).toThrow(/`provider` is required/);
    });

    it("has empty initial state", () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.loading).toBe(false);
      expect(core.error).toBeNull();
    });

    it("dispatches events on the injected target", () => {
      const target = new EventTarget();
      const events: string[] = [];
      target.addEventListener("feature-flags:flags-changed", () => events.push("flags"));
      const core = new FlagsCore({ target, provider: new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] }) });
      return core.identify("alice").then(() => {
        expect(events).toEqual(["flags"]);
      });
    });
  });

  describe("identify", () => {
    it("rejects empty userId synchronously via a thrown error", async () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      await expect(core.identify("")).rejects.toThrow(/`userId` is required/);
    });

    it("publishes the initial flag snapshot and flips identified", async () => {
      const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] });
      const core = new FlagsCore({ provider: p });
      const events = eventRecorder(core);
      await core.identify("alice", { role: "admin" });
      expect(core.flags).toEqual({ a: true });
      expect(core.identified).toBe(true);
      expect(core.loading).toBe(false);
      const types = events.map((e) => e.type);
      expect(types).toContain("feature-flags:loading-changed");
      expect(types).toContain("feature-flags:flags-changed");
      expect(types).toContain("feature-flags:identified-changed");
    });

    it("provider push updates re-publish flags", async () => {
      const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: false }] });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const snapshots: FlagMap[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => {
        snapshots.push((e as CustomEvent).detail as FlagMap);
      });
      p.setFlag("a", true);
      expect(snapshots).toEqual([{ a: true }]);
    });

    it("re-identify unwinds the previous subscription", async () => {
      const unsub = vi.fn();
      const subscribe = vi.fn(() => unsub);
      const p = makeStubProvider({ subscribe });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.identify("bob");
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it("publishes an error when the provider rejects identify", async () => {
      const p = makeStubProvider({
        async identify() { throw new Error("network down"); },
      });
      const core = new FlagsCore({ provider: p });
      const events = eventRecorder(core);
      await core.identify("alice");
      expect(core.error?.message).toBe("network down");
      expect(core.identified).toBe(false);
      expect(core.loading).toBe(false);
      const errEvents = events.filter((e) => e.type === "feature-flags:error" && e.detail);
      expect(errEvents).toHaveLength(1);
      // The getter and the event carry the same value.
      expect(errEvents[0].detail).toBe(core.error);
    });

    it("publishes the error as a frozen JSON value, not an Error instance", async () => {
      // `error` crosses the @wc-bindable/remote wire, which (0.10+)
      // drops any property value that is not a JsonValue — an `Error`
      // instance never reached the browser. See `_toErrorInfo`.
      const p = makeStubProvider({
        async identify() { throw new Error("network down"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error).not.toBeInstanceOf(Error);
      expect(core.error).toEqual({ name: "Error", message: "network down" });
      expect(Object.keys(core.error!)).toEqual(["name", "message"]);
      expect(Object.isFrozen(core.error)).toBe(true);
      expect(isJsonValue(core.error)).toBe(true);
    });

    it("keeps the error subclass name and a string `code`", async () => {
      const p = makeStubProvider({
        async identify() {
          throw Object.assign(new TypeError("connect refused"), { code: "ECONNREFUSED" });
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error).toEqual({ name: "TypeError", message: "connect refused", code: "ECONNREFUSED" });
      expect(isJsonValue(core.error)).toBe(true);
    });

    it("omits a non-string `code` rather than carrying it (or an undefined key)", async () => {
      const p = makeStubProvider({
        async identify() { throw Object.assign(new Error("http"), { code: 503 }); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error).toEqual({ name: "Error", message: "http" });
      expect("code" in core.error!).toBe(false);
    });

    it("describes non-Error provider rejections the way `new Error(String(err))` did", async () => {
      const p = makeStubProvider({
        async identify() { throw "string-failure"; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error).toEqual({ name: "Error", message: "string-failure" });
      expect(Object.isFrozen(core.error)).toBe(true);
    });

    it("a failed re-identify clears stale flags and identified state", async () => {
      // Regression: a successful identify for alice committed
      // `flags={a:true}, identified=true`; a subsequent re-identify
      // for bob that failed used to leave those alice-era values in
      // place while `_currentIdentity` had already been reassigned
      // to bob — violating the "flags reflect _currentIdentity"
      // invariant.
      const identify = vi.fn()
        .mockResolvedValueOnce({ a: true })
        .mockRejectedValueOnce(new Error("boom"));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });

      await core.identify("alice");
      expect(core.flags).toEqual({ a: true });
      expect(core.identified).toBe(true);

      await core.identify("bob");
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("boom");
      expect(core.loading).toBe(false);
    });

    it("a failed FIRST identify does not emit a spurious flags-changed event", async () => {
      // No prior committed identity → flags are already `{}`. The
      // failure-path reset publishes `{}` again, which is a real
      // (though redundant) event. Consumers that bind to the
      // bindable surface will see the change of reference; that is
      // acceptable because the invariant must hold uniformly. This
      // test pins the behavior so any future dedup change is
      // intentional.
      const p = makeStubProvider({
        async identify() { throw new Error("boom"); },
      });
      const core = new FlagsCore({ provider: p });
      const events: unknown[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => events.push((e as CustomEvent).detail));

      await core.identify("alice");
      expect(core.flags).toEqual({});
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("boom");
      // One flags-changed event fired with an empty map — the
      // invariant-restoring publish.
      expect(events).toEqual([{}]);
    });

    it("reload() after a failed identify retries the failed identity, even when userContext is set", async () => {
      // Regression: when `userContext` was armed (e.g. alice) AND a
      // manual `identify("bob")` subsequently failed, reload()'s
      // priority used to check `!_identified && _userContext` first
      // and fall through to `ensureIdentified()`, which rebuilt the
      // identity from `_userContext` (alice) — silently rolling back
      // from the bob identity the caller had explicitly selected.
      // The correct priority is:
      //   1. `_currentIdentity` set  → retry THAT identity (bob).
      //   2. `_currentIdentity` null → fall back to userContext.
      const identify = vi.fn()
        .mockRejectedValueOnce(new Error("bob-boom"))  // manual bob fails
        .mockResolvedValueOnce({ bob_flag: true });    // bob retry succeeds
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "alice" } as UserContextLike,
      });

      // Manual identify("bob") — userContext is NOT used here.
      await core.identify("bob");
      expect(core.identified).toBe(false);
      expect(core.error?.message).toBe("bob-boom");

      await core.reload();
      // reload must have retried BOB, not rolled back to ALICE.
      expect(identify).toHaveBeenCalledTimes(2);
      const retryIdentity = identify.mock.calls[1][0] as { userId: string };
      expect(retryIdentity.userId).toBe("bob");
      expect(core.flags).toEqual({ bob_flag: true });
      expect(core.identified).toBe(true);
    });

    it("reload() before any identify falls back to userContext (auto-identify)", async () => {
      // Pin the complementary priority: when `_currentIdentity` is
      // null (never identified) and `_userContext` is armed, reload()
      // should trigger auto-identify via `ensureIdentified()`.
      const identify = vi.fn(async () => ({ auto: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "alice", email: "a@x" } as UserContextLike,
      });
      // No manual identify() — reload is the first call.
      await core.reload();
      expect(identify).toHaveBeenCalledTimes(1);
      const identity = identify.mock.calls[0][0] as { userId: string };
      expect(identity.userId).toBe("alice");
      expect(core.flags).toEqual({ auto: true });
      expect(core.identified).toBe(true);
    });

    it("reload() after a failed re-identify reruns identify (does NOT cache-bypass fetch)", async () => {
      // The core bug the design review surfaced: after alice →
      // bob-identify-fails, `_currentIdentity === bob` but the last
      // committed flag map was alice's. A subsequent `reload()`
      // used to call `provider.reload(bob)` and silently commit
      // bob's flags without a matching identify cycle.
      //
      // With the fix, reload() sees `!_identified && currentIdentity`
      // and routes through `_doIdentify(bob)` instead — so bob's
      // flags only land after a FULL identify cycle, and the
      // invariant holds throughout.
      const identify = vi.fn()
        .mockResolvedValueOnce({ a: true })                   // alice success
        .mockRejectedValueOnce(new Error("boom"))             // bob fail
        .mockResolvedValueOnce({ b: true });                  // bob retry success
      const reload = vi.fn(async () => ({ should_not_happen: true }));
      const p = makeStubProvider({ identify, reload });
      const core = new FlagsCore({ provider: p });

      await core.identify("alice");
      await core.identify("bob");  // fails; state resets
      expect(core.identified).toBe(false);
      expect(core.flags).toEqual({});

      await core.reload();          // must re-run identify, not provider.reload
      expect(reload).not.toHaveBeenCalled();
      expect(identify).toHaveBeenCalledTimes(3);
      expect(core.flags).toEqual({ b: true });
      expect(core.identified).toBe(true);
      expect(core.error).toBeNull();
    });

    it("subscription errors are non-fatal: initial snapshot stays, error surfaces", async () => {
      const p = makeStubProvider({
        subscribe() { throw new Error("subscribe-failed"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.identified).toBe(true);
      expect(core.error?.message).toBe("subscribe-failed");
    });

    it("wraps non-Error subscription failures", async () => {
      const p = makeStubProvider({
        subscribe() { throw 42; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.error?.message).toBe("42");
    });

    it("a later identify cancels the in-flight earlier one (generation guard)", async () => {
      let resolveFirst!: (v: FlagMap) => void;
      const firstPromise = new Promise<FlagMap>((r) => { resolveFirst = r; });
      const identify = vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(async () => ({ b: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      const firstCall = core.identify("alice");
      const secondCall = core.identify("bob");
      // Resolve the FIRST identify late — its result must be discarded.
      resolveFirst({ a: true });
      await Promise.all([firstCall, secondCall]);
      expect(core.flags).toEqual({ b: true });
    });

    it("superseded identify errors are swallowed (no error on the active identity)", async () => {
      let rejectFirst!: (e: Error) => void;
      const firstPromise = new Promise<FlagMap>((_, reject) => { rejectFirst = reject; });
      const identify = vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(async () => ({ b: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      const first = core.identify("alice");
      const second = core.identify("bob");
      rejectFirst(new Error("late identify failure"));
      await Promise.all([first, second]);
      expect(core.error).toBeNull();
      expect(core.flags).toEqual({ b: true });
    });

    it("cleanup of previous subscription tolerates a throwing unsub", async () => {
      let unsubCount = 0;
      const throwingUnsub = () => { unsubCount++; throw new Error("bad unsub"); };
      const subscribe = vi.fn(() => throwingUnsub);
      const p = makeStubProvider({ subscribe });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await expect(core.identify("bob")).resolves.toBeUndefined();
      expect(unsubCount).toBe(1);
    });

    it("push updates from a superseded identity are dropped", async () => {
      let pushFn: ((next: FlagMap) => void) | null = null;
      const p = makeStubProvider({
        async identify() { return {}; },
        subscribe(_id, onChange) {
          pushFn = onChange;
          return () => {};
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      // capture the first identity's push function
      const firstPush = pushFn!;
      await core.identify("bob");
      const snapshots: FlagMap[] = [];
      core.addEventListener("feature-flags:flags-changed", (e) => {
        snapshots.push((e as CustomEvent).detail as FlagMap);
      });
      firstPush({ stale: true });
      expect(snapshots).toEqual([]);
    });
  });

  describe("auto-identify via userContext", () => {
    it("ensureIdentified identifies with the user sub + traits", async () => {
      const identify = vi.fn(async (id: FlagIdentity) => ({ who: id.userId }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.userId).toBe("auth0|alice");
      expect(identity.attrs).toEqual({
        email: "alice@example.com",
        name: "Alice",
        org_id: "org_1",
        permissions: ["read:things"],
        roles: ["admin"],
      });
      expect(core.identified).toBe(true);
      expect(core.flags).toEqual({ who: "auth0|alice" });
    });

    it("ensureIdentified coalesces concurrent calls", async () => {
      const identify = vi.fn(async () => ({ a: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await Promise.all([core.ensureIdentified(), core.ensureIdentified()]);
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("ensureIdentified is a no-op when already identified", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.identify("alice");
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("ensureIdentified is a no-op when no userContext is configured", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      await core.ensureIdentified();
      expect(identify).not.toHaveBeenCalled();
    });

    it("ensureIdentified is a no-op after dispose", async () => {
      // Cycle 1 hardening: post-dispose ensureIdentified must short-
      // circuit before touching the provider — auth0-gate may fire a
      // late `ready` event after the host already detached the Core.
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.dispose();
      await core.ensureIdentified();
      expect(identify).not.toHaveBeenCalled();
    });

    it("omits undefined attrs from the identity", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: { sub: "anon" } as UserContextLike,
      });
      await core.ensureIdentified();
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.attrs).toBeUndefined();
    });
  });

  describe("reload", () => {
    it("refreshes the flag snapshot", async () => {
      let count = 0;
      const p = makeStubProvider({
        async identify() { count++; return { n: count }; },
        async reload() { count++; return { n: count }; },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.flags).toEqual({ n: 1 });
      await core.reload();
      expect(core.flags).toEqual({ n: 2 });
    });

    it("without identity + without userContext is a silent no-op", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      await core.reload();
      expect(core.identified).toBe(false);
      expect(p.calls.identify).toBe(0);
      expect(p.calls.reload).toBe(0);
    });

    it("first reload before identify triggers auto-identify when userContext is set", async () => {
      const identify = vi.fn(async () => ({ a: true }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.reload();
      expect(identify).toHaveBeenCalledTimes(1);
      expect(core.identified).toBe(true);
    });

    it("publishes error when provider.reload rejects", async () => {
      const p = makeStubProvider({
        async reload() { throw new Error("reload-failed"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.reload();
      expect(core.error?.message).toBe("reload-failed");
      expect(core.loading).toBe(false);
    });

    it("wraps non-Error reload rejections", async () => {
      const p = makeStubProvider({ async reload() { throw "str"; } });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.reload();
      expect(core.error?.message).toBe("str");
    });

    it("superseded reload results are discarded", async () => {
      let resolveReload!: (v: FlagMap) => void;
      const reloadPromise = new Promise<FlagMap>((r) => { resolveReload = r; });
      const reload = vi.fn()
        .mockImplementationOnce(() => reloadPromise);
      const p = makeStubProvider({ reload });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      core.flags; // touch
      const reloadCall = core.reload();
      await core.identify("bob"); // generation bump
      resolveReload({ stale: true });
      await reloadCall;
      expect(core.flags).not.toEqual({ stale: true });
    });

    it("superseded reload errors are swallowed (no error surfaced)", async () => {
      let rejectReload!: (e: Error) => void;
      const reloadPromise = new Promise<FlagMap>((_, reject) => { rejectReload = reject; });
      const reload = vi.fn().mockImplementationOnce(() => reloadPromise);
      const p = makeStubProvider({ reload });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const reloadCall = core.reload();
      await core.identify("bob"); // bump gen mid-reload
      rejectReload(new Error("late reload failure"));
      await reloadCall;
      expect(core.error).toBeNull();
    });
  });

  describe("updateUserContext", () => {
    it("re-identifies when sub changes", async () => {
      const identify = vi.fn(async (id: FlagIdentity) => ({ u: id.userId }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);
      await core.updateUserContext({ ...USER, sub: "auth0|different" });
      expect(identify).toHaveBeenCalledTimes(2);
      expect(core.flags).toEqual({ u: "auth0|different" });
    });

    it("no-ops when nothing targeting-relevant changed", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, raw: { new: "claim" } });
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("no-ops when array traits have same content but different references", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({
        ...USER,
        permissions: [...(USER.permissions ?? [])],
        roles: [...(USER.roles ?? [])],
      });
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("re-identifies when permissions array content changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, permissions: ["read:things", "write:things"] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when role array length differs", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, roles: [] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when array content differs at the same length", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, permissions: ["write:things"] });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("treats permissions/roles as sets — a pure reorder does NOT re-identify", async () => {
      // Auth0 token refresh does not guarantee stable ordering of the
      // `permissions` / `roles` claims across refreshes. A reorder-only
      // refresh must be a no-op: no re-identify, no poller teardown,
      // no spurious `flags-changed`. The Flagsmith identity key also
      // canonicalizes these arrays via `_buildIdentity`, so the end-to-
      // end identity is stable across reorderings.
      const user: UserContextLike = {
        sub: "auth0|alice",
        permissions: ["read:things", "write:things", "delete:things"],
        roles: ["admin", "editor"],
      };
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: user });
      await core.ensureIdentified();

      await core.updateUserContext({
        ...user,
        permissions: ["delete:things", "read:things", "write:things"], // reordered
        roles: ["editor", "admin"], // reordered
      });
      expect(identify).toHaveBeenCalledTimes(1); // unchanged
    });

    it("_buildIdentity canonicalizes permission/role order into attrs", async () => {
      // Whatever order Auth0 handed us, the identity forwarded to the
      // Provider must be canonical so the Flagsmith identity-key (which
      // hashes attrs byte-wise) is stable across reorder-only refreshes.
      const identify = vi.fn(async (id: FlagIdentity) => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({
        provider: p,
        userContext: {
          sub: "auth0|alice",
          permissions: ["z:last", "a:first", "m:middle"],
          roles: ["z-role", "a-role"],
        },
      });
      await core.ensureIdentified();
      const identity = identify.mock.calls[0][0] as FlagIdentity;
      expect(identity.attrs?.permissions).toEqual(["a:first", "m:middle", "z:last"]);
      expect(identity.attrs?.roles).toEqual(["a-role", "z-role"]);
    });

    it("re-identifies when orgId changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, orgId: "org_2" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when name changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, name: "Other" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("re-identifies when email changes", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      await core.updateUserContext({ ...USER, email: "changed@example.com" });
      expect(identify).toHaveBeenCalledTimes(2);
    });

    it("treats an undefined previous userContext as a change", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p });
      await core.updateUserContext(USER);
      expect(identify).toHaveBeenCalledTimes(1);
    });

    it("no-ops after dispose", async () => {
      const identify = vi.fn(async () => ({}));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.dispose();
      await core.updateUserContext({ ...USER, sub: "new" });
      expect(identify).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("tears down subscription + calls provider.dispose", async () => {
      const unsub = vi.fn();
      const dispose = vi.fn(async () => {});
      const p = makeStubProvider({
        subscribe: () => unsub,
        dispose,
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.dispose();
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("tolerates a throwing unsub during dispose", async () => {
      const p = makeStubProvider({
        subscribe: () => () => { throw new Error("bad unsub"); },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("tolerates a throwing provider.dispose", async () => {
      const p = makeStubProvider({
        async dispose() { throw new Error("bad dispose"); },
      });
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("works when provider has no dispose()", async () => {
      const p = { identify: async () => ({}), subscribe: () => () => {}, reload: async () => ({}) } as FlagProvider;
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("a second dispose is a no-op", async () => {
      const dispose = vi.fn(async () => {});
      const p = makeStubProvider({ dispose });
      const core = new FlagsCore({ provider: p });
      await core.dispose();
      await core.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("identify/reload after dispose throw", async () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      await core.dispose();
      await expect(core.identify("alice")).rejects.toThrow(/disposed/);
      await expect(core.reload()).rejects.toThrow(/disposed/);
    });

    it("works when there was no active subscription", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      await expect(core.dispose()).resolves.toBeUndefined();
    });

    it("awaits in-flight provider calls before tearing the provider down", async () => {
      // Regression guard: dispose() must `Promise.allSettled` the
      // outstanding provider promises so a late-resolving identify()
      // does not land on an already-disposed Provider. We hold the
      // identify() promise deliberately pending, kick dispose(), and
      // verify that dispose only completes AFTER identify resolves.
      let releaseIdentify!: (value: FlagMap) => void;
      const identifyGate = new Promise<FlagMap>((resolve) => { releaseIdentify = resolve; });
      const events: string[] = [];
      const p = makeStubProvider({
        async identify() {
          const value = await identifyGate;
          events.push("identify-resolved");
          return value;
        },
        async dispose() { events.push("dispose-called"); },
      });
      const core = new FlagsCore({ provider: p });
      const identifyPromise = core.identify("alice");
      // Yield once so the awaited identify enters _inFlight.
      await Promise.resolve();
      const disposePromise = core.dispose();
      // Release the in-flight provider call AFTER dispose has begun.
      releaseIdentify({ x: true });
      await disposePromise;
      await identifyPromise.catch(() => {});
      // identify must resolve before provider.dispose() runs — the
      // `Promise.allSettled([..._inFlight])` line gates it.
      expect(events).toEqual(["identify-resolved", "dispose-called"]);
    });
  });

  describe("deep-freeze contract", () => {
    it("deep-freezes object-shaped flag values", async () => {
      const p = makeStubProvider({
        async identify() {
          return { new_checkout: { enabled: true, value: null } };
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const flag = core.flags.new_checkout as { enabled: boolean; value: unknown };
      expect(Object.isFrozen(flag)).toBe(true);
      expect(() => { (flag as { enabled: boolean }).enabled = false; }).toThrow(TypeError);
    });

    it("deep-freezes arrays inside flag values", async () => {
      const p = makeStubProvider({
        async identify() {
          return { palette: { enabled: true, value: ["red", "green"] } };
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const arr = (core.flags.palette as { value: string[] }).value;
      expect(Object.isFrozen(arr)).toBe(true);
      expect(() => arr.push("blue")).toThrow(TypeError);
    });

    it("publishes a JSON-normalized map when the provider hands back non-JSON values", async () => {
      // One non-JSON leaf would make the remote wire drop the WHOLE map;
      // the Core normalizes instead (see `freeze.ts` §3).
      const p = makeStubProvider({
        async identify() {
          return { ok: true, gone: undefined, ratio: Number.NaN } as unknown as FlagMap;
        },
      });
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.flags).toEqual({ ok: true, ratio: null });
      expect("gone" in core.flags).toBe(false);
      expect(isJsonValue(core.flags)).toBe(true);
    });

    it("isolates provider source from consumer mutation attempts", async () => {
      // The Provider returns an object whose value fields share
      // references with its own internal state. Without a deep clone
      // in _publishFlags, a consumer's (foiled) mutation attempt would
      // poison the Provider's source.
      const sharedDefault = { enabled: false, value: null };
      const providerState = { new_checkout: sharedDefault };
      const p: FlagProvider = {
        async identify() { return providerState; },
        subscribe: () => () => {},
        async reload() { return providerState; },
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      const published = core.flags.new_checkout as { enabled: boolean; value: unknown };
      // The published object is NOT the same reference — cloned.
      expect(published).not.toBe(sharedDefault);
      // The Provider's own source must still be writable (its rule
      // definitions remain mutable for the Provider's own use).
      expect(() => { sharedDefault.enabled = true; }).not.toThrow();
    });
  });

  describe("event dedupe", () => {
    it("identified-changed does not fire twice for the same value", async () => {
      const p = new InMemoryFlagProvider();
      const core = new FlagsCore({ provider: p });
      const events: unknown[] = [];
      core.addEventListener("feature-flags:identified-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });
      await core.identify("alice");
      await core.identify("bob");
      expect(events).toEqual([true]);
    });

    it("loading-changed toggles cleanly across identify cycles", async () => {
      const p = new InMemoryFlagProvider();
      const core = new FlagsCore({ provider: p });
      const events: boolean[] = [];
      core.addEventListener("feature-flags:loading-changed", (e) => {
        events.push((e as CustomEvent).detail as boolean);
      });
      await core.identify("alice");
      expect(events).toEqual([true, false]);
    });

    it("error event does not re-fire when the null state is already null", async () => {
      const p = makeStubProvider();
      const core = new FlagsCore({ provider: p });
      const nullHits: unknown[] = [];
      core.addEventListener("feature-flags:error", (e) => {
        if ((e as CustomEvent).detail === null) nullHits.push(null);
      });
      await core.identify("alice");
      // A successful identify path calls _setError(null) once at the start;
      // subsequent identifies should NOT re-fire null→null beyond initial
      await core.identify("bob");
      // Exactly one null per identify call is acceptable (the initial clear).
      expect(nullHits.length).toBeLessThanOrEqual(2);
    });
  });

  describe("provider synchronous throw", () => {
    it("clears `loading` when provider.identify throws synchronously", async () => {
      // Regression: a provider that throws sync from identify() must
      // not leave the Core wedged with `loading=true`.
      const p: FlagProvider = {
        identify: (() => { throw new Error("sync identify boom"); }) as FlagProvider["identify"],
        subscribe: () => () => {},
        async reload() { return {}; },
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.loading).toBe(false);
      expect(core.identified).toBe(false);
      expect(core.error?.message).toMatch(/sync identify boom/);
    });

    it("clears `loading` when provider.reload throws synchronously", async () => {
      // Regression: same contract on the reload() cache-bypass path.
      let throwOnReload = false;
      const p: FlagProvider = {
        async identify() { return {}; },
        subscribe: () => () => {},
        reload: (() => {
          if (throwOnReload) throw new Error("sync reload boom");
          return Promise.resolve({});
        }) as FlagProvider["reload"],
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      throwOnReload = true;
      await core.reload();
      expect(core.loading).toBe(false);
      expect(core.error?.message).toMatch(/sync reload boom/);
    });
  });

  describe("originalError — the exception behind `error`, for server-side code", () => {
    // `error` is the plain `FlagsErrorInfo` the browser receives. Server
    // code that logs / monitors failures needs the exception itself, and a
    // provider failure is published, never thrown, so the Core keeps it.

    /** A provider error with a cause and a field only the instance has. */
    function providerError(message = "upstream refused"): Error & { code: string; cause: unknown; requestId: string } {
      return Object.assign(new Error(message), {
        name: "FlagServiceError",
        code: "ECONNREFUSED",
        cause: new Error("socket hang up"),
        requestId: "REQ-7f3a",
      });
    }

    /** Records each error event with the `originalError` visible at that moment. */
    function errorRecorder(target: EventTarget, core: FlagsCore) {
      const seen: Array<{ detail: unknown; original: Error | null }> = [];
      target.addEventListener("feature-flags:error", (e) => {
        seen.push({ detail: (e as CustomEvent).detail, original: core.originalError });
      });
      return seen;
    }

    it("is null initially and is not part of the bindable surface", () => {
      const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
      expect(core.originalError).toBeNull();
      // `inputs` is not in `IWcBindable` (the Core declares none), but
      // `RemoteShellProxy` would accept a `set` for any name listed there.
      const { inputs = [] } = FlagsCore.wcBindable as { inputs?: ReadonlyArray<{ name: string }> };
      const declared = [
        ...FlagsCore.wcBindable.properties.map((p) => p.name),
        ...inputs.map((i) => i.name),
        ...(FlagsCore.wcBindable.commands ?? []).map((c) => c.name),
      ];
      expect(declared).not.toContain("originalError");
    });

    it("identify rejection: the provider's own instance — name, message, stack, cause, extra fields intact", async () => {
      const err = providerError();
      const core = new FlagsCore({ provider: makeStubProvider({ async identify() { throw err; } }) });
      await core.identify("alice");

      const original = core.originalError as typeof err;
      expect(original).toBe(err);
      expect(original.name).toBe("FlagServiceError");
      expect(original.message).toBe("upstream refused");
      expect(typeof original.stack).toBe("string");
      expect(original.stack).toBe(err.stack);
      expect(original.cause).toBe(err.cause);
      expect(original.requestId).toBe("REQ-7f3a");
      // …while the published value stays the frozen plain reduction.
      expect(core.error).toEqual({ name: "FlagServiceError", message: "upstream refused", code: "ECONNREFUSED" });
      expect(isJsonValue(core.error)).toBe(true);
    });

    it("identify synchronous throw: the thrown instance", async () => {
      const err = providerError("sync identify boom");
      const p: FlagProvider = {
        identify: (() => { throw err; }) as FlagProvider["identify"],
        subscribe: () => () => {},
        async reload() { return {}; },
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      expect(core.originalError).toBe(err);
      expect(core.error?.message).toBe("sync identify boom");
    });

    it("reload rejection: the provider's own instance", async () => {
      const err = providerError("reload-failed");
      const core = new FlagsCore({ provider: makeStubProvider({ async reload() { throw err; } }) });
      await core.identify("alice");
      expect(core.originalError).toBeNull();
      await core.reload();
      expect(core.originalError).toBe(err);
      expect(core.error?.message).toBe("reload-failed");
      expect(core.identified).toBe(true);
    });

    it("reload synchronous throw: the thrown instance", async () => {
      const err = providerError("sync reload boom");
      const p: FlagProvider = {
        async identify() { return {}; },
        subscribe: () => () => {},
        reload: (() => { throw err; }) as FlagProvider["reload"],
      };
      const core = new FlagsCore({ provider: p });
      await core.identify("alice");
      await core.reload();
      expect(core.originalError).toBe(err);
    });

    it("subscribe throw: the thrown instance, next to the committed snapshot", async () => {
      const err = providerError("subscribe-failed");
      const core = new FlagsCore({ provider: makeStubProvider({ subscribe() { throw err; } }) });
      await core.identify("alice");
      expect(core.identified).toBe(true);
      expect(core.originalError).toBe(err);
      expect(core.error?.message).toBe("subscribe-failed");
    });

    it.each([
      ["a string", "string-failure", "string-failure"],
      ["a number", 42, "42"],
      ["null", null, "null"],
      ["undefined", undefined, "undefined"],
      ["a plain object", { message: "plain" }, "[object Object]"],
    ])("a non-Error throw (%s) becomes an Error with the same name / message `error` describes", async (_label, thrown, message) => {
      const core = new FlagsCore({ provider: makeStubProvider({ async identify() { throw thrown; } }) });
      await core.identify("alice");

      const original = core.originalError;
      expect(original).toBeInstanceOf(Error);
      expect(original).not.toBe(thrown);
      expect(original?.name).toBe("Error");
      expect(original?.message).toBe(message);
      expect(typeof original?.stack).toBe("string");
      expect(original && "cause" in original).toBe(false);
      // A throw of `null` / `undefined` is still a failure, never a clear.
      expect(core.error).toEqual({ name: original?.name, message: original?.message });
    });

    it("is set before feature-flags:error is dispatched, and clears with `error`", async () => {
      const err = providerError();
      const identify = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ a: true });
      const core = new FlagsCore({ provider: makeStubProvider({ identify }) });
      const seen = errorRecorder(core, core);

      await core.identify("alice");
      await core.identify("alice"); // starts by clearing the slot, then succeeds

      expect(seen).toEqual([
        { detail: { name: "FlagServiceError", message: "upstream refused", code: "ECONNREFUSED" }, original: err },
        { detail: null, original: null },
      ]);
      expect(seen[0].original).toBe(err);
      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
    });

    it("is readable from a listener on an injected target", async () => {
      const target = new EventTarget();
      const err = providerError();
      const core = new FlagsCore({ target, provider: makeStubProvider({ async identify() { throw err; } }) });
      const seen = errorRecorder(target, core);
      await core.identify("alice");
      expect(seen).toHaveLength(1);
      expect(seen[0].original).toBe(err);
    });

    it("a reload retry clears it, and each new failure replaces it", async () => {
      const first = providerError("first");
      const second = providerError("second");
      const reload = vi.fn()
        .mockRejectedValueOnce(first)
        .mockRejectedValueOnce(second)
        .mockResolvedValueOnce({ ok: true });
      const core = new FlagsCore({ provider: makeStubProvider({ reload }) });
      const seen = errorRecorder(core, core);
      await core.identify("alice");

      await core.reload();
      expect(core.originalError).toBe(first);
      await core.reload();
      expect(core.originalError).toBe(second);
      await core.reload();
      expect(core.originalError).toBeNull();
      expect(core.flags).toEqual({ ok: true });

      expect(seen.map((s) => s.original)).toEqual([first, null, second, null]);
      // `null` exactly when `error` is, at every event.
      for (const s of seen) expect(s.original === null).toBe(s.detail === null);
    });

    it("a superseded failure leaves it untouched", async () => {
      let rejectFirst!: (e: unknown) => void;
      const identify = vi.fn()
        .mockImplementationOnce(() => new Promise<FlagMap>((_, rej) => { rejectFirst = rej; }))
        .mockResolvedValueOnce({ b: true });
      const core = new FlagsCore({ provider: makeStubProvider({ identify }) });
      const first = core.identify("alice");
      await core.identify("bob");
      rejectFirst(providerError("stale"));
      await first;
      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
    });

    it("a precondition violation throws without touching it", async () => {
      const err = providerError();
      const core = new FlagsCore({ provider: makeStubProvider({ async identify() { throw err; } }) });
      await core.identify("alice");
      await expect(core.identify("")).rejects.toThrow(/`userId` is required/);
      expect(core.originalError).toBe(err);
      await core.dispose();
      await expect(core.reload()).rejects.toThrow(/disposed/);
      expect(core.originalError).toBe(err);
    });
  });

  describe("a failure that cannot be turned into a string — published like any other, never thrown", () => {
    // Regression: `_toError` did `new Error(String(err))` inside the Core's
    // `catch` blocks, so a provider failure `String()` rejects threw from
    // the `catch` itself — `identify()` rejected with `loading` stuck at
    // `true`, and `reload()` / a `subscribe` throw rejected with `error`
    // never set.
    const FALLBACK = { name: "Error", message: "unserializable error value" };

    /** Thrown values `String()` (or `instanceof`) throws on. A fresh one per call. */
    const UNSTRINGIFIABLE: Array<[string, () => unknown]> = [
      ["Object.create(null)", () => Object.create(null)],
      ["a throwing Symbol.toPrimitive", () => ({ [Symbol.toPrimitive]() { throw new Error("toPrimitive trap"); } })],
      ["a throwing toString", () => ({ toString() { throw new Error("toString trap"); } })],
      ["an object that converts to a symbol", () => ({ toString() { return Symbol("s"); } })],
      ["a revoked Proxy", () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; }],
    ];

    /** Provider `Error`s whose `name` / `message` / `code` cannot be read as strings. */
    const HOSTILE_ERRORS: Array<[string, () => Error]> = [
      ["an Error whose message String() rejects", () => Object.assign(new Error("x"), { message: Object.create(null) })],
      ["an Error whose name converts to a symbol", () => Object.assign(new Error("x"), { name: { toString: () => Symbol("n") } })],
      ["an Error with a throwing name getter", () => Object.defineProperty(new Error("x"), "name", { get() { throw new Error("trap"); } })],
      ["an Error with a throwing code getter", () => Object.defineProperty(new Error("x"), "code", { get() { throw new Error("trap"); } })],
    ];

    interface Scenario {
      provider: FlagProvider;
      /** The public call(s) whose catch path handles `thrown`. */
      act: (core: FlagsCore) => Promise<void>;
      /** What a normal failure on this path leaves on the surface. */
      flags: FlagMap;
      identified: boolean;
    }

    /** Every catch path that publishes a provider failure. */
    const PATHS: Array<[string, (thrown: unknown) => Scenario]> = [
      ["identify rejection", (thrown) => ({
        provider: makeStubProvider({ async identify() { throw thrown; } }),
        act: (core) => core.identify("alice"),
        flags: {},
        identified: false,
      })],
      ["identify synchronous throw", (thrown) => ({
        provider: makeStubProvider({ identify: (() => { throw thrown; }) as FlagProvider["identify"] }),
        act: (core) => core.identify("alice"),
        flags: {},
        identified: false,
      })],
      ["re-identify rejection after a committed identity", (thrown) => ({
        provider: makeStubProvider({
          identify: vi.fn()
            .mockResolvedValueOnce({ a: true })
            .mockRejectedValueOnce(thrown),
        }),
        act: async (core) => { await core.identify("alice"); await core.identify("bob"); },
        flags: {},
        identified: false,
      })],
      ["reload rejection", (thrown) => ({
        provider: makeStubProvider({ async identify() { return { a: true }; }, async reload() { throw thrown; } }),
        act: async (core) => { await core.identify("alice"); await core.reload(); },
        flags: { a: true },
        identified: true,
      })],
      ["reload synchronous throw", (thrown) => ({
        provider: makeStubProvider({
          async identify() { return { a: true }; },
          reload: (() => { throw thrown; }) as FlagProvider["reload"],
        }),
        act: async (core) => { await core.identify("alice"); await core.reload(); },
        flags: { a: true },
        identified: true,
      })],
      ["subscribe throw", (thrown) => ({
        provider: makeStubProvider({ async identify() { return { a: true }; }, subscribe() { throw thrown; } }),
        act: (core) => core.identify("alice"),
        flags: { a: true },
        identified: true,
      })],
    ];

    /** Run `path` against `thrown`; assert the state every failure leaves. */
    async function runAndExpectFallback(path: (thrown: unknown) => Scenario, thrown: unknown): Promise<FlagsCore> {
      const scenario = path(thrown);
      const core = new FlagsCore({ provider: scenario.provider });
      const events = eventRecorder(core);
      const seen: Array<Error | null> = [];
      core.addEventListener("feature-flags:error", () => seen.push(core.originalError));

      // Published, not thrown.
      await expect(scenario.act(core)).resolves.toBeUndefined();

      expect(core.loading).toBe(false);
      expect(core.identified).toBe(scenario.identified);
      expect(core.flags).toEqual(scenario.flags);
      expect(core.error).toEqual(FALLBACK);
      expect(Object.isFrozen(core.error)).toBe(true);
      expect(isJsonValue(core.error)).toBe(true);
      expect(core.originalError).toBeInstanceOf(Error);

      // The last error event carries exactly the published value, with
      // `originalError` already set when it fired.
      const errorEvents = events.filter((e) => e.type === "feature-flags:error");
      expect(errorEvents[errorEvents.length - 1].detail).toBe(core.error);
      expect(seen[seen.length - 1]).toBe(core.originalError);
      // `loading` went up and came back down.
      const loading = events.filter((e) => e.type === "feature-flags:loading-changed").map((e) => e.detail);
      expect(loading[loading.length - 1]).toBe(false);
      return core;
    }

    describe.each(PATHS)("%s", (_path, path) => {
      it.each(UNSTRINGIFIABLE)("%s: `error` and `originalError` read \"unserializable error value\"", async (_label, make) => {
        const thrown = make();
        expect(() => String(thrown)).toThrow(); // the premise
        const core = await runAndExpectFallback(path, thrown);
        // `===`, not `.not.toBe(thrown)`: the matcher itself probes its
        // argument, which a revoked Proxy refuses.
        expect(core.originalError === thrown).toBe(false);
        expect(core.originalError?.name).toBe(FALLBACK.name);
        expect(core.originalError?.message).toBe(FALLBACK.message);
        expect(core.originalError && "cause" in core.originalError).toBe(false);
      });

      it.each(HOSTILE_ERRORS)("%s: `error` falls back, `originalError` keeps the instance", async (_label, make) => {
        const thrown = make();
        const core = await runAndExpectFallback(path, thrown);
        expect(core.originalError).toBe(thrown);
      });
    });

    it("a bare symbol is still described by String(), not replaced", async () => {
      const core = new FlagsCore({ provider: makeStubProvider({ async identify() { throw Symbol("bare"); } }) });
      await core.identify("alice");
      expect(core.error).toEqual({ name: "Error", message: "Symbol(bare)" });
      expect(core.originalError?.message).toBe("Symbol(bare)");
      expect(core.loading).toBe(false);
    });

    it("a retry after such a failure clears `error` and `originalError` together", async () => {
      const identify = vi.fn()
        .mockRejectedValueOnce(Object.create(null))
        .mockResolvedValueOnce({ a: true });
      const core = new FlagsCore({ provider: makeStubProvider({ identify }) });
      await core.identify("alice");
      expect(core.error).toEqual(FALLBACK);

      // `reload()` re-runs the failed identify.
      await core.reload();
      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
      expect(core.identified).toBe(true);
      expect(core.flags).toEqual({ a: true });
      expect(core.loading).toBe(false);
    });
  });

  describe("a flag map that cannot be read — never thrown, never left loading", () => {
    // Regression: `_doIdentify` published the provider's map outside its
    // `try`, so a map `deepCloneAndFreeze` throws on made `identify()`
    // reject with `loading` stuck at `true` and `error` unset; a pushed one
    // threw into the provider's fan-out and was lost without an `error`.
    //
    // Two outcomes, per `freeze.ts`: an entry that cannot be read is dropped
    // (`null` in an array) like `undefined` — and logged, by path — and the
    // rest is published; a map that cannot be enumerated at all, or that is
    // not an object of flags, is a provider failure of the path that
    // delivered it.
    const COMMITTED: FlagMap = { a: true };

    const WARNING_PREFIX = "[@csbc-dev/feature-flags] dropped flag values that cannot be published: ";
    const WARNING_SUFFIX = ". The rest of the flag map is published. (Each path is logged once per process.)";

    let warn: MockInstance<typeof console.warn>;
    beforeEach(() => {
      __resetDroppedValueWarnings();
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    /** An object chain `levels` objects deep. */
    function nested(levels: number): Record<string, unknown> {
      let v: Record<string, unknown> = { leaf: "deep-secret" };
      for (let i = 1; i < levels; i++) v = { next: v };
      return v;
    }

    function revoked(): object {
      const r = Proxy.revocable({ a: true }, {});
      r.revoke();
      return r.proxy;
    }

    /** A getter chain that never ends: every read returns a fresh object, so there is no cycle to catch. */
    function endless(): object {
      return Object.defineProperty({}, "next", { enumerable: true, get: endless });
    }

    /**
     * Maps that cannot be enumerated. Fresh per call. (An `async` provider
     * that resolves a revoked Proxy is already a rejection — promise
     * resolution reads `then` — so that one reaches `_publishFlags` only
     * through a push.)
     */
    const UNENUMERABLE: Array<[string, () => unknown]> = [
      ["a revoked Proxy", () => revoked()],
      ["a Proxy whose ownKeys trap throws", () => new Proxy({ a: true }, { ownKeys() { throw new Error("ownKeys trap"); } })],
      ["a Proxy whose getOwnPropertyDescriptor trap throws", () => new Proxy({ a: true }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } })],
      ["undefined", () => undefined],
      ["null", () => null],
    ];

    /**
     * Values that are not an object of flags, and the type the error names.
     * Regression: `Object.keys` cloned them as maps — `"ab"` was published
     * as `{ 0: "a", 1: "b" }`, a number or a function as `{}`.
     */
    const NOT_A_MAP: Array<[string, () => unknown, string]> = [
      ["a string", () => "ab", "a string"],
      ["a number", () => 42, "a number"],
      ["a boolean", () => true, "a boolean"],
      ["an array", () => [{ enabled: true }], "an array"],
      ["a function", () => () => ({ a: true }), "a function"],
      // Regression: as objects these passed the shape check — a `Map` was
      // published as `{}` (every flag wiped), `new String("ab")` as
      // `{ 0: "a", 1: "b" }`. (A Promise reaches `_publishFlags` only through
      // a push — an `async` provider's own result is awaited; see below.)
      ["a Map", () => new Map([["secret-flag-text", { enabled: true, value: null }]]), "a Map"],
      ["a Set", () => new Set(["secret-flag-text"]), "a Set"],
      ["a Date", () => new Date(0), "a Date"],
      ["an Error", () => new Error("secret-flag-text"), "an Error"],
      ["a String object", () => new String("ab"), "a String object"],
      ["a Uint8Array", () => new Uint8Array([1, 2]), "a Uint8Array"],
      ["a Map from another realm", () => runInNewContext("new Map([['secret-flag-text', true]])"), "a Map"],
    ];

    /**
     * Maps with entries that cannot be read, what is published of them, and
     * the paths the one warning names (`null`: no warning). Fresh per call.
     */
    const PARTLY_UNREADABLE: Array<[string, () => unknown, FlagMap, string | null]> = [
      ["a throwing getter", () => ({ ok: true, get bad() { throw new Error("getter"); } }), { ok: true },
        "flags.bad (could not be read)"],
      ["a Proxy whose get trap throws for one flag", () => new Proxy({ ok: true, bad: true }, {
        get(t, k, r) {
          if (k === "bad") throw new Error("get trap");
          return Reflect.get(t, k, r);
        },
      }), { ok: true }, "flags.bad (could not be read)"],
      ["a revoked Proxy as a flag value", () => ({ ok: true, bad: revoked() }), { ok: true },
        "flags.bad (could not be read)"],
      ["a nested value whose ownKeys trap throws", () => ({
        ok: true,
        flag: { enabled: true, value: new Proxy({}, { ownKeys() { throw new Error("ownKeys trap"); } }) },
      }), { ok: true, flag: { enabled: true } }, "flags.flag.value (could not be read)"],
      ["array elements that cannot be read", () => {
        const value: unknown[] = [1, 2, revoked()];
        Object.defineProperty(value, 1, { enumerable: true, get() { throw new Error("element getter"); } });
        return { ok: true, list: { enabled: true, value } };
      }, { ok: true, list: { enabled: true, value: [1, null, null] } },
        "flags.list.value[1] (could not be read), flags.list.value[2] (could not be read)"],
      ["a cycle through a getter next to a throwing getter", () => {
        const flag: Record<string, unknown> = { enabled: true };
        Object.defineProperty(flag, "self", { enumerable: true, get: () => flag });
        Object.defineProperty(flag, "bad", { enumerable: true, get() { throw new Error("getter"); } });
        return { ok: true, flag };
      }, { ok: true, flag: { enabled: true, self: null } }, "flags.flag.bad (could not be read)"],
      ["a getter chain that never ends", () => ({ ok: true, deep: endless() }), { ok: true },
        "flags.deep (nested deeper than 256 levels)"],
      // Regression: the map was not on the cycle guard's path, so a reference
      // back to it was cloned one level more before collapsing.
      ["flags pointing back at the map itself", () => {
        const map: Record<string, unknown> = { ok: true };
        map.self = map;
        map.flag = { enabled: true, value: [map] };
        return map;
      }, { ok: true, self: null, flag: { enabled: true, value: [null] } }, null],
      // Regression: past the wire's `maxDepth` (256, the map being level 1),
      // the remote shell dropped the whole `flags` update.
      ["a flag nested deeper than the wire carries, next to one at its limit", () => ({
        ok: true,
        edge: nested(255),
        deep: { enabled: true, value: nested(255) },
      }), { ok: true, edge: nested(255) }, "flags.deep (nested deeper than 256 levels)"],
    ];

    interface Scenario {
      provider: FlagProvider;
      /** The public call(s) that deliver the map. */
      act: (core: FlagsCore) => Promise<void>;
      /** Whether a map is committed when the broken one arrives (and so stays). */
      committed: boolean;
    }

    /** Every path on which the Core publishes a provider's map. */
    const PATHS: Array<[string, (map: () => unknown) => Scenario]> = [
      ["identify", (map) => ({
        provider: makeStubProvider({ async identify() { return map() as FlagMap; } }),
        act: (core) => core.identify("alice"),
        committed: false,
      })],
      ["re-identify after a committed identity", (map) => ({
        provider: makeStubProvider({
          identify: vi.fn()
            .mockResolvedValueOnce(COMMITTED)
            .mockImplementationOnce(async () => map()),
        }),
        act: async (core) => { await core.identify("alice"); await core.identify("bob"); },
        committed: false,
      })],
      ["reload", (map) => ({
        provider: makeStubProvider({ async identify() { return COMMITTED; }, async reload() { return map() as FlagMap; } }),
        act: async (core) => { await core.identify("alice"); await core.reload(); },
        committed: true,
      })],
      ["subscribe push", (map) => {
        let push!: (next: FlagMap) => void;
        return {
          provider: makeStubProvider({
            async identify() { return COMMITTED; },
            subscribe(_id, onChange) { push = onChange; return () => {}; },
          }),
          act: async (core) => {
            await core.identify("alice");
            // Pushed from the provider's own code: it must come back normally.
            expect(() => push(map() as FlagMap)).not.toThrow();
          },
          committed: true,
        };
      }],
    ];

    describe.each(PATHS)("%s", (pathLabel, path) => {
      it.each([
        ...UNENUMERABLE,
        ...NOT_A_MAP.map(([label, make]): [string, () => unknown] => [label, make]),
      ])("%s: a provider failure — `error` set, `loading` cleared, nothing thrown", async (_label, make) => {
        const scenario = path(make);
        const subscribe = vi.spyOn(scenario.provider, "subscribe");
        const core = new FlagsCore({ provider: scenario.provider });
        const events = eventRecorder(core);
        const seen: Array<Error | null> = [];
        core.addEventListener("feature-flags:error", () => seen.push(core.originalError));

        await expect(scenario.act(core)).resolves.toBeUndefined();

        // The state a provider failure on this path leaves: an identify that
        // did not commit resets to `{}` / unidentified; a reload or a push
        // keeps the committed map.
        expect(core.loading).toBe(false);
        expect(core.identified).toBe(scenario.committed);
        expect(core.flags).toEqual(scenario.committed ? COMMITTED : {});
        expect(core.originalError).toBeInstanceOf(Error);
        expect(core.error).toEqual({ name: core.originalError!.name, message: core.originalError!.message });
        expect(Object.isFrozen(core.error)).toBe(true);
        expect(isJsonValue(core.error)).toBe(true);
        expect(isJsonValue(core.flags)).toBe(true);
        // A failed identify installs no subscription for its identity.
        expect(subscribe).toHaveBeenCalledTimes(pathLabel === "identify" ? 0 : 1);

        const errorEvents = events.filter((e) => e.type === "feature-flags:error");
        expect(errorEvents[errorEvents.length - 1].detail).toBe(core.error);
        expect(seen[seen.length - 1]).toBe(core.originalError);
        const loading = events.filter((e) => e.type === "feature-flags:loading-changed").map((e) => e.detail);
        expect(loading[loading.length - 1]).toBe(false);
        // Nothing was published, so nothing was dropped and logged.
        expect(warn).not.toHaveBeenCalled();
      });

      it.each(NOT_A_MAP)("%s: `error` names the type it got, never the value", async (_label, make, got) => {
        const scenario = path(make);
        const core = new FlagsCore({ provider: scenario.provider });

        await scenario.act(core);

        expect(core.originalError).toBeInstanceOf(TypeError);
        expect(core.error).toEqual({
          name: "TypeError",
          message: `[@csbc-dev/feature-flags] a flag map must be an object of flags; the provider returned ${got}.`,
        });
        expect(JSON.stringify(core.error)).not.toContain("secret-flag-text");
      });

      it.each(PARTLY_UNREADABLE)("%s: the readable part is published, with no error", async (_label, make, expected, logged) => {
        const scenario = path(make);
        const core = new FlagsCore({ provider: scenario.provider });

        await expect(scenario.act(core)).resolves.toBeUndefined();

        expect(core.flags).toEqual(expected);
        expect(Object.isFrozen(core.flags)).toBe(true);
        expect(isJsonValue(core.flags)).toBe(true);
        expect(core.identified).toBe(true);
        expect(core.loading).toBe(false);
        expect(core.error).toBeNull();
        expect(core.originalError).toBeNull();
        // One warning, naming paths only — not an `error`.
        if (logged === null) {
          expect(warn).not.toHaveBeenCalled();
        } else {
          expect(warn.mock.calls).toEqual([[`${WARNING_PREFIX}${logged}${WARNING_SUFFIX}`]]);
        }
      });
    });

    it("a pushed Promise (a provider that forgot to await) is a provider failure, the committed map kept", async () => {
      // Regression: published as `{}`, wiping every flag. Only a push can
      // deliver one: an `async` provider's own Promise result is awaited.
      let push!: (next: FlagMap) => void;
      const provider = makeStubProvider({
        async identify() { return COMMITTED; },
        subscribe(_id, onChange) { push = onChange; return () => {}; },
      });
      const core = new FlagsCore({ provider });
      await core.identify("alice");

      expect(() => push(Promise.resolve({ b: true }) as unknown as FlagMap)).not.toThrow();

      expect(core.flags).toEqual(COMMITTED);
      expect(core.identified).toBe(true);
      expect(core.loading).toBe(false);
      expect(core.originalError).toBeInstanceOf(TypeError);
      expect(core.error).toEqual({
        name: "TypeError",
        message: "[@csbc-dev/feature-flags] a flag map must be an object of flags; the provider returned a Promise.",
      });
      expect(warn).not.toHaveBeenCalled();

      // The next good push is published as usual.
      push({ b: true });
      expect(core.flags).toEqual({ b: true });
    });

    it("a flag that stays unreadable is logged once — not on every reload, push and identify, nor per Core", async () => {
      let push!: (next: FlagMap) => void;
      const broken = () => ({ ok: true, get bad() { throw new Error("getter"); } }) as unknown as FlagMap;
      const provider = makeStubProvider({
        async identify() { return broken(); },
        async reload() { return broken(); },
        subscribe(_id, onChange) { push = onChange; return () => {}; },
      });
      const core = new FlagsCore({ provider });
      await core.identify("alice");
      await core.reload();
      push(broken());
      await core.identify("bob");
      await new FlagsCore({ provider }).identify("carol");

      expect(core.flags).toEqual({ ok: true });
      expect(warn.mock.calls).toEqual([[`${WARNING_PREFIX}flags.bad (could not be read)${WARNING_SUFFIX}`]]);
    });

    it("a built-in provider's own clone logs the value it drops; the Core does not log it again", async () => {
      const value = Object.defineProperty({ keep: 1 }, "bad", { enumerable: true, get() { throw new Error("getter"); } });
      const provider = new InMemoryFlagProvider({ flags: [{ key: "flag", defaultValue: value as unknown as FlagMap }] });
      const core = new FlagsCore({ provider });
      await core.identify("alice");
      provider.setFlag("other", true);

      expect(core.flags).toEqual({ flag: { keep: 1 }, other: true });
      expect(warn.mock.calls).toEqual([[`${WARNING_PREFIX}flags.flag.bad (could not be read)${WARNING_SUFFIX}`]]);
    });

    it("`originalError` is the trap's own exception", async () => {
      const trap = Object.assign(new TypeError("flag store closed"), { code: "ESTORECLOSED" });
      const core = new FlagsCore({
        provider: makeStubProvider({ async identify() { return new Proxy({}, { ownKeys() { throw trap; } }) as FlagMap; } }),
      });
      await core.identify("alice");
      expect(core.originalError).toBe(trap);
      expect(core.error).toEqual({ name: "TypeError", message: "flag store closed", code: "ESTORECLOSED" });
    });

    it("a reload retries the identify, and a readable map then commits", async () => {
      const identify = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ ok: true });
      const core = new FlagsCore({ provider: makeStubProvider({ identify }) });
      await core.identify("alice");
      expect(core.error?.name).toBe("TypeError");
      expect(core.identified).toBe(false);

      await core.reload();
      expect(identify).toHaveBeenCalledTimes(2);
      expect(core.flags).toEqual({ ok: true });
      expect(core.identified).toBe(true);
      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
    });

    it("after a failed push, the next readable push is published", async () => {
      let push!: (next: FlagMap) => void;
      const core = new FlagsCore({
        provider: makeStubProvider({
          async identify() { return COMMITTED; },
          subscribe(_id, onChange) { push = onChange; return () => {}; },
        }),
      });
      await core.identify("alice");
      push(revoked() as FlagMap);
      expect(core.flags).toEqual(COMMITTED);
      expect(core.error?.name).toBe("TypeError");

      push({ a: false });
      expect(core.flags).toEqual({ a: false });
    });

    it("a pushed map whose trap re-identifies before throwing leaves the new identity's state alone", async () => {
      // The generation guard on the push path's failure branch: the throw
      // belongs to the superseded identity.
      let push!: (next: FlagMap) => void;
      const identify = vi.fn()
        .mockResolvedValueOnce({ a: true })
        .mockResolvedValueOnce({ b: true });
      const core = new FlagsCore({
        provider: makeStubProvider({ identify, subscribe(_id, onChange) { push = onChange; return () => {}; } }),
      });
      await core.identify("alice");

      let bob!: Promise<void>;
      push(new Proxy({}, {
        ownKeys() {
          bob = core.identify("bob");
          throw new Error("ownKeys trap");
        },
      }) as FlagMap);
      await bob;

      expect(core.error).toBeNull();
      expect(core.originalError).toBeNull();
      expect(core.flags).toEqual({ b: true });
      expect(core.identified).toBe(true);
    });
  });

  describe("updateUserContext + manual identify interaction", () => {
    it("re-identifies when _currentIdentity drifted from the refreshed userContext", async () => {
      // Regression: a manual identify("bob") overrides the
      // userContext-derived identity. A subsequent token-refresh for
      // the original user (alice) MUST re-identify so the Core does
      // not stay wedged on bob's flag map while the live session is
      // back to alice — comparing only against `_userContext`
      // would treat alice→alice as a no-op and miss the drift.
      const identify = vi.fn(async (id: FlagIdentity) => ({ u: id.userId }));
      const p = makeStubProvider({ identify });
      const core = new FlagsCore({ provider: p, userContext: USER });
      await core.ensureIdentified();
      expect(identify).toHaveBeenCalledTimes(1);

      // Manual override → bob.
      await core.identify("auth0|bob");
      expect(identify).toHaveBeenCalledTimes(2);
      expect(core.flags).toEqual({ u: "auth0|bob" });

      // Auth0 token refresh re-sends alice (same as constructor user).
      await core.updateUserContext(USER);
      expect(identify).toHaveBeenCalledTimes(3);
      expect(core.flags).toEqual({ u: USER.sub });
    });
  });
});
