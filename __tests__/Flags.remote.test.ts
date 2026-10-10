import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRemoteCoreProxy, RemoteShellProxy } from "@wc-bindable/remote";
import type {
  ClientMessage,
  ClientTransport,
  RemoteCoreProxy,
  ServerMessage,
  ServerTransport,
} from "@wc-bindable/remote";
import { bootstrapFlags } from "../src/bootstrapFlags";
import { FlagsCore } from "../src/core/FlagsCore";
import { InMemoryFlagProvider } from "../src/providers/InMemoryFlagProvider";
import type { Flags } from "../src/components/Flags";
import type { FlagIdentity, FlagMap, FlagProvider } from "../src/types";

// Regression suite for the `@wc-bindable/remote` 0.10 JsonValue gate.
//
// `Flags.test.ts` drives `<feature-flags>` through a hand-rolled mock
// proxy, which never validates anything — so it kept passing while the
// real 0.10 pair rejected `identify(userId)` (an `undefined` argument)
// and silently dropped every `error` value (an `Error` instance is not a
// JsonValue). Every test here goes through the REAL `RemoteShellProxy` /
// `RemoteCoreProxy`, with each message JSON round-tripped the way a
// WebSocket would carry it, and asserts that neither side logged a
// dropped value.

bootstrapFlags();

/** Session element with the `<auth0-session>` surface `<feature-flags>` needs. */
class LoopbackSession extends HTMLElement {
  proxy: RemoteCoreProxy | null = null;
  ready = false;

  attach(proxy: RemoteCoreProxy): void {
    this.proxy = proxy;
    this.ready = true;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", { detail: true }));
  }
}
customElements.define("loopback-session", LoopbackSession);

/** Linked client/server transports; each message is JSON round-tripped and delivered on a microtask. */
function createLoopback(): { client: ClientTransport; server: ServerTransport } {
  let toServer: ((message: ClientMessage) => void) | null = null;
  let toClient: ((message: ServerMessage) => void) | null = null;
  return {
    client: {
      send(message) {
        const wire = JSON.stringify(message);
        queueMicrotask(() => toServer?.(JSON.parse(wire) as ClientMessage));
      },
      onMessage(handler) { toClient = handler; },
    },
    server: {
      send(message) {
        const wire = JSON.stringify(message);
        queueMicrotask(() => toClient?.(JSON.parse(wire) as ServerMessage));
      },
      onMessage(handler) { toServer = handler; },
    },
  };
}

/** Drain every queued microtask (wire hops, `<feature-flags>` attach). */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

const disposers: Array<() => void> = [];

async function mount(core: FlagsCore) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const { client, server } = createLoopback();
  const shell = new RemoteShellProxy(core, server, { logger });
  const proxy = createRemoteCoreProxy(FlagsCore.wcBindable, client, { logger });
  disposers.push(() => proxy.dispose(), () => shell.dispose());

  const session = document.createElement("loopback-session") as LoopbackSession;
  session.id = "remote-session";
  document.body.appendChild(session);
  session.attach(proxy);

  const el = document.createElement("feature-flags") as Flags;
  el.target = "remote-session";
  document.body.appendChild(el);
  await settle();
  return { el, logger };
}

function stubProvider(overrides: Partial<FlagProvider>): FlagProvider {
  return {
    async identify() { return {}; },
    subscribe: () => () => {},
    async reload() { return {}; },
    ...overrides,
  };
}

function networkError(): Error {
  return Object.assign(new TypeError("network down"), { code: "ECONNREFUSED" });
}

// Provider output that is NOT a JsonValue at several depths. `FlagValue`
// forbids all of it by type, but custom / InMemory providers are only
// checked at compile time.
function nonJsonFlags(): FlagMap {
  return {
    ok: { enabled: true, value: "x" },
    missing: undefined,
    nan: Number.NaN,
    nested: { enabled: true, value: { keep: 1, drop: undefined, inf: Infinity } },
    list: [1, undefined, Number.NaN],
    big: BigInt(10),
  } as unknown as FlagMap;
}

const NORMALIZED_FLAGS = {
  ok: { enabled: true, value: "x" },
  nan: null,
  nested: { enabled: true, value: { keep: 1, inf: null } },
  list: [1, null, null],
  big: "10",
};

describe("<feature-flags> over a real @wc-bindable/remote session", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("the initial sync reaches the element with no dropped values", async () => {
    const core = new FlagsCore({ provider: new InMemoryFlagProvider() });
    const { el, logger } = await mount(core);
    expect(el.flags).toEqual({});
    expect(el.identified).toBe(false);
    expect(el.loading).toBe(false);
    expect(el.error).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("identify()", () => {
    it("identify(userId) without attrs is not rejected and publishes the targeted flags", async () => {
      const core = new FlagsCore({
        provider: new InMemoryFlagProvider({
          flags: [{
            key: "beta",
            defaultValue: false,
            rules: [{ key: "beta", value: true, predicate: (id) => id.userId === "alice" }],
          }],
        }),
      });
      const { el, logger } = await mount(core);

      await el.identify("alice");
      await settle();

      expect(core.identified).toBe(true);
      expect(el.flags).toEqual({ beta: true });
      expect(el.identified).toBe(true);
      expect(el.error).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("top-level undefined attrs are dropped instead of failing the call", async () => {
      const identify = vi.fn(async (id: FlagIdentity) => ({ who: id.userId }));
      const core = new FlagsCore({ provider: stubProvider({ identify }) });
      const { el } = await mount(core);

      await el.identify("alice", { plan: "pro", country: undefined });

      const identity = identify.mock.calls[0][0];
      expect(identity.userId).toBe("alice");
      expect(identity.attrs).toEqual({ plan: "pro" });
      expect(Object.keys(identity.attrs!)).toEqual(["plan"]);
    });

    it("a nested non-JsonValue in attrs still rejects with the protocol's coded error", async () => {
      const identify = vi.fn(async () => ({}));
      const core = new FlagsCore({ provider: stubProvider({ identify }) });
      const { el } = await mount(core);

      await expect(el.identify("alice", { meta: { at: new Date() } }))
        .rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE" });
      expect(identify).not.toHaveBeenCalled();
    });
  });

  describe("error", () => {
    it("a provider failure reaches el.error through an update", async () => {
      const identify = vi.fn()
        .mockRejectedValueOnce(networkError())
        .mockResolvedValueOnce({ recovered: true });
      const core = new FlagsCore({ provider: stubProvider({ identify }) });
      const { el, logger } = await mount(core);

      // Provider failures are published, not thrown.
      await el.identify("bob");
      await settle();

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("network down");
      expect(el.error?.name).toBe("TypeError");
      expect((el.error as Error & { code?: unknown }).code).toBe("ECONNREFUSED");
      expect(el.identified).toBe(false);
      expect(el.loading).toBe(false);
      expect(el.flags).toEqual({});
      expect(logger.warn).not.toHaveBeenCalled();

      // A successful retry clears it again over the same channel.
      await el.reload();
      await settle();
      expect(el.error).toBeNull();
      expect(el.flags).toEqual({ recovered: true });
      expect(el.identified).toBe(true);
    });

    it("a provider failure that predates the session reaches el.error through the sync", async () => {
      const core = new FlagsCore({
        provider: stubProvider({ async identify() { throw networkError(); } }),
      });
      await core.identify("bob");

      const { el, logger } = await mount(core);

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("network down");
      expect(el.error?.name).toBe("TypeError");
      expect(el.identified).toBe(false);
      // A non-JsonValue `error` would have been listed in `getterFailures`.
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("a non-Error provider rejection arrives as an Error carrying its string form", async () => {
      const core = new FlagsCore({
        provider: stubProvider({ async identify() { throw "string-failure"; } }),
      });
      const { el, logger } = await mount(core);

      await el.identify("bob");
      await settle();

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("string-failure");
      expect(el.error?.name).toBe("Error");
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("flags", () => {
    it("non-JsonValue flag values are normalized instead of dropping the whole map (update)", async () => {
      const core = new FlagsCore({
        provider: stubProvider({ async identify() { return nonJsonFlags(); } }),
      });
      const { el, logger } = await mount(core);

      await el.identify("alice");
      await settle();

      expect(el.flags).toEqual(NORMALIZED_FLAGS);
      expect("missing" in el.flags).toBe(false);
      // The Core publishes exactly what the wire carries.
      expect(core.flags).toEqual(el.flags);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("non-JsonValue flag values are normalized instead of dropping the whole map (sync)", async () => {
      const core = new FlagsCore({
        provider: stubProvider({ async identify() { return nonJsonFlags(); } }),
      });
      await core.identify("alice");

      const { el, logger } = await mount(core);

      expect(el.flags).toEqual(NORMALIZED_FLAGS);
      expect(el.identified).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("a provider push carrying a non-JsonValue flag still reaches the element", async () => {
      const provider = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] });
      const core = new FlagsCore({ provider });
      const { el, logger } = await mount(core);
      await el.identify("alice");
      await settle();

      provider.setFlag("ratio", Number.NaN);
      await settle();

      expect(el.flags).toEqual({ a: true, ratio: null });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
