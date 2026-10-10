import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { runInNewContext } from "node:vm";
import { isJsonValue, toJsonValue } from "@wc-bindable/remote";
import { __resetDroppedValueWarnings, deepCloneAndFreeze, deepFreeze } from "../src/freeze";
import type { FlagMap } from "../src/types";

/** `@wc-bindable/remote` 0.10's default `maxDepth`; the map itself is level 1. */
const WIRE_MAX_DEPTH = 256;

function revoked(): object {
  const r = Proxy.revocable({ a: 1 }, {});
  r.revoke();
  return r.proxy;
}

/** A getter chain that never ends: every read returns a fresh object, so there is no cycle to catch. */
function endless(): object {
  return Object.defineProperty({}, "next", { enumerable: true, get: endless });
}

/** An object chain `levels` objects deep: `{ next: { next: … { leaf: "deep-secret" } } }`. */
function nested(levels: number): Record<string, unknown> {
  let v: Record<string, unknown> = { leaf: "deep-secret" };
  for (let i = 1; i < levels; i++) v = { next: v };
  return v;
}

/** An array chain `levels` arrays deep: `[[… ["deep-secret"] …]]`. */
function nestedArrays(levels: number): unknown[] {
  let v: unknown[] = ["deep-secret"];
  for (let i = 1; i < levels; i++) v = [v];
  return v;
}

/** A fresh object with an own enumerable getter that throws, for each of `keys`. */
function throwingGetters(...keys: string[]): Record<string, unknown> {
  return withThrowingGetters({}, ...keys);
}

/** `o`, given an own enumerable getter that throws for each of `keys` (after its existing keys). */
function withThrowingGetters(o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const k of keys) {
    Object.defineProperty(o, k, { enumerable: true, get() { throw new Error(`getter-error-text for ${k}`); } });
  }
  return o;
}

const WARNING_PREFIX = "[@csbc-dev/feature-flags] dropped flag values that cannot be published: ";
const WARNING_SUFFIX = ". The rest of the flag map is published. (Each path is logged once per process.)";

describe("deepCloneAndFreeze", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    __resetDroppedValueWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /** The paths the one warning so far named, with their reasons. */
  function loggedPaths(call = 0): string {
    const message = warn.mock.calls[call][0] as string;
    expect(message.startsWith(WARNING_PREFIX)).toBe(true);
    expect(message.endsWith(WARNING_SUFFIX)).toBe(true);
    return message.slice(WARNING_PREFIX.length, -WARNING_SUFFIX.length);
  }

  it("freezes the outer map and nested object / array values", () => {
    const out = deepCloneAndFreeze({
      toggle: { enabled: true, value: null },
      list: { enabled: true, value: ["a", "b"] },
    });
    expect(Object.isFrozen(out)).toBe(true);
    const toggle = out.toggle as { enabled: boolean };
    expect(Object.isFrozen(toggle)).toBe(true);
    const list = (out.list as { value: string[] }).value;
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("clones — the result does not share references with the input", () => {
    const inner = { enabled: true, value: 1 };
    const input = { flag: inner };
    const out = deepCloneAndFreeze(input);
    expect(out.flag).not.toBe(inner);
    expect(out.flag).toEqual(inner);
  });

  it("passes primitives and null through unchanged", () => {
    const out = deepCloneAndFreeze({ a: 1, b: "x", c: true, d: null });
    expect(out).toEqual({ a: 1, b: "x", c: true, d: null });
  });

  it("collapses a self-referential object value to null instead of overflowing the stack", () => {
    // `FlagValue` forbids cycles by type, but the Providers feed values
    // that are only `unknown` at the SDK boundary — an accidental cycle
    // must terminate, not blow the stack.
    const cyclic: Record<string, unknown> = { enabled: true };
    cyclic.self = cyclic;
    const input = { flag: cyclic } as unknown as FlagMap;
    let out: FlagMap;
    expect(() => { out = deepCloneAndFreeze(input); }).not.toThrow();
    const flag = out!.flag as Record<string, unknown>;
    expect(flag.enabled).toBe(true);
    expect(flag.self).toBeNull();
  });

  it("collapses a cycle that runs through an array", () => {
    const arr: unknown[] = ["x"];
    arr.push(arr);
    const input = { flag: { value: arr } } as unknown as FlagMap;
    let out: FlagMap;
    expect(() => { out = deepCloneAndFreeze(input); }).not.toThrow();
    const value = (out!.flag as { value: unknown[] }).value;
    expect(value[0]).toBe("x");
    expect(value[1]).toBeNull();
  });

  it("does NOT flag a shared non-ancestor reference as circular (DAG, not cycle)", () => {
    // Two sibling branches pointing at the same leaf is a DAG — both
    // must clone normally rather than one being collapsed to null.
    const shared = { v: 1 };
    const input = { a: { value: shared }, b: { value: shared } } as unknown as FlagMap;
    const out = deepCloneAndFreeze(input);
    expect((out.a as { value: unknown }).value).toEqual({ v: 1 });
    expect((out.b as { value: unknown }).value).toEqual({ v: 1 });
  });

  it("collapses a value pointing back at the map itself where it points, not one level later", () => {
    // Regression: the map was not on the cycle guard's path, so a reference
    // to it was cloned once more before collapsing —
    // `{ a: true, self: { a: true, self: null } }`.
    const map: Record<string, unknown> = { a: true };
    map.self = map;
    map.flag = { enabled: true, value: [map, { up: map }] };
    const out = deepCloneAndFreeze(map as unknown as FlagMap);
    expect(out).toEqual({ a: true, self: null, flag: { enabled: true, value: [null, { up: null }] } });
    expect(isJsonValue(out)).toBe(true);
    // A cycle is normalized silently, like the rest of §3.
    expect(warn).not.toHaveBeenCalled();
  });

  describe("a top-level value that is not a flag map", () => {
    // Regression: anything `Object.keys` accepts was cloned as a map —
    // `"ab"` became `{ 0: "a", 1: "b" }`, an array its indices, a number or
    // a function `{}` (every flag wiped). Like a map that cannot be
    // enumerated, it is thrown, for FlagsCore to publish as a provider
    // failure.
    it.each<[string, () => unknown, string]>([
      ["a string", () => "ab", "a string"],
      ["an empty string", () => "", "a string"],
      ["a number", () => 42, "a number"],
      ["a boolean", () => true, "a boolean"],
      ["a bigint", () => BigInt(7), "a bigint"],
      ["a symbol", () => Symbol("flags"), "a symbol"],
      ["a function", () => () => ({ a: true }), "a function"],
      ["an array", () => [{ a: true }], "an array"],
      ["an empty array", () => [], "an array"],
      ["a Proxy of an array", () => new Proxy(["a"], {}), "an array"],
      ["null", () => null, "null"],
      ["undefined", () => undefined, "undefined"],
    ])("%s: a TypeError naming the type, never the value", (_label, make, got) => {
      expectNotAFlagMap(make, got);
    });

    /** Text inside the rejected values below; never in the error. */
    const SECRET = "secret-flag-text";

    /** Throws a TypeError naming `got`, and nothing of the value; logs nothing. */
    function expectNotAFlagMap(make: () => unknown, got: string): void {
      let caught: unknown;
      try {
        deepCloneAndFreeze(make() as FlagMap);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toBe(
        `[@csbc-dev/feature-flags] a flag map must be an object of flags; the provider returned ${got}.`,
      );
      expect((caught as Error).message).not.toContain(SECRET);
      expect(warn).not.toHaveBeenCalled();
    }

    /** `o`, given an own `Symbol.toStringTag` that names something else than what it is. */
    function retagged<T extends object>(o: T): T {
      return Object.defineProperty(o, Symbol.toStringTag, { value: "FlagStore" });
    }

    describe("a built-in object whose contents are not its own keys", () => {
      // Regression: any object passed the shape check — a `Map` was cloned
      // as `{}` (every flag wiped), `new String("ab")` as `{ 0: "a", 1: "b" }`,
      // a typed array as its indices. What those hold lives in internal
      // slots; like a string, such a map is thrown, for FlagsCore to publish
      // as a provider failure.
      it.each<[string, () => unknown, string]>([
        ["a Map", () => new Map([[SECRET, { enabled: true, value: SECRET }]]), "a Map"],
        ["an empty Map", () => new Map(), "a Map"],
        ["a Map subclass", () => new (class FlagStore extends Map<string, unknown> {})([[SECRET, true]]), "a Map"],
        ["a Set", () => new Set([SECRET]), "a Set"],
        ["a WeakMap", () => new WeakMap([[{}, SECRET]]), "a WeakMap"],
        ["a WeakSet", () => new WeakSet([{}]), "a WeakSet"],
        ["a Date", () => new Date(0), "a Date"],
        ["an invalid Date", () => new Date(Number.NaN), "a Date"],
        ["a RegExp", () => new RegExp(SECRET), "a RegExp"],
        ["an Error", () => new Error(SECRET), "an Error"],
        ["an Error subclass", () => new TypeError(SECRET), "an Error"],
        ["an Error with flag-like own keys", () => Object.assign(new Error(SECRET), { code: SECRET }), "an Error"],
        ["a Promise", () => Promise.resolve({ a: true }), "a Promise"],
        ["a pending Promise", () => new Promise(() => {}), "a Promise"],
        ["a String object", () => new String(SECRET), "a String object"],
        ["an empty String object", () => new String(""), "a String object"],
        ["a Number object", () => new Number(42), "a Number object"],
        ["a Boolean object", () => new Boolean(true), "a Boolean object"],
        ["a Symbol object", () => Object(Symbol(SECRET)), "a Symbol object"],
        ["a BigInt object", () => Object(BigInt(7)), "a BigInt object"],
        ["an ArrayBuffer", () => new ArrayBuffer(8), "an ArrayBuffer"],
        ["a SharedArrayBuffer", () => new SharedArrayBuffer(8), "a SharedArrayBuffer"],
        ["a DataView", () => new DataView(new ArrayBuffer(8)), "a DataView"],
        ["a Uint8Array", () => new Uint8Array([1, 2]), "a Uint8Array"],
        ["an Int8Array", () => new Int8Array(2), "an Int8Array"],
        ["a Float64Array", () => new Float64Array(2), "a Float64Array"],
        ["a BigInt64Array", () => new BigInt64Array(2), "a BigInt64Array"],
      ])("%s: a TypeError naming the type, never the value", (_label, make, got) => {
        expectNotAFlagMap(make, got);
      });

      it.each<[string, string, string]>([
        ["a Map", "new Map([['flag', true]])", "a Map"],
        ["a Set", "new Set(['flag'])", "a Set"],
        ["a Date", "new Date(0)", "a Date"],
        ["a RegExp", "/flag/", "a RegExp"],
        ["an Error", "new RangeError('flag')", "an Error"],
        ["a Promise", "Promise.resolve(1)", "a Promise"],
        ["a String object", "new String('ab')", "a String object"],
        ["an ArrayBuffer", "new ArrayBuffer(1)", "an ArrayBuffer"],
        ["a Float32Array", "new Float32Array(1)", "a Float32Array"],
        ["a DataView", "new DataView(new ArrayBuffer(1))", "a DataView"],
        // The brand checks hold across realms too.
        ["a Map with a tag of its own", "Object.defineProperty(new Map(), Symbol.toStringTag, { value: 'FlagStore' })", "a Map"],
        ["a Uint16Array with a tag of its own", "Object.defineProperty(new Uint16Array(1), Symbol.toStringTag, { value: 'FlagStore' })", "a Uint16Array"],
      ])("%s from another realm: rejected the same way", (_label, source, got) => {
        const value = runInNewContext(source) as unknown;
        // Not this realm's: `instanceof` would miss it.
        expect(value instanceof Object).toBe(false);
        expectNotAFlagMap(() => value, got);
      });

      it.each<[string, () => unknown, string]>([
        // `Object.prototype.toString` names something else: the brand checks decide.
        ["a Map subclass", () => new (class FlagStore extends Map {
          get [Symbol.toStringTag]() { return "FlagStore"; }
        })(), "a Map"],
        ["a Map", () => retagged(new Map()), "a Map"],
        ["a Set", () => retagged(new Set()), "a Set"],
        ["a WeakMap", () => retagged(new WeakMap()), "a WeakMap"],
        ["a WeakSet", () => retagged(new WeakSet()), "a WeakSet"],
        ["a Date", () => retagged(new Date(0)), "a Date"],
        ["a RegExp", () => retagged(/flag/), "a RegExp"],
        ["a String object", () => retagged(new String(SECRET)), "a String object"],
        ["a Number object", () => retagged(new Number(1)), "a Number object"],
        ["a Boolean object", () => retagged(new Boolean(false)), "a Boolean object"],
        ["a Symbol object", () => retagged(Object(Symbol(SECRET)) as object), "a Symbol object"],
        ["a BigInt object", () => retagged(Object(BigInt(1)) as object), "a BigInt object"],
        ["an ArrayBuffer", () => retagged(new ArrayBuffer(1)), "an ArrayBuffer"],
        ["an Int32Array", () => retagged(new Int32Array(1)), "an Int32Array"],
        ["a DataView", () => retagged(new DataView(new ArrayBuffer(1))), "a DataView"],
      ])("%s with a tag of its own: still rejected as what it is", (_label, make, got) => {
        expectNotAFlagMap(make, got);
      });

      it("a Map whose tag getter throws: still rejected as a Map, the getter's exception kept in", () => {
        expectNotAFlagMap(() => Object.defineProperty(new Map(), Symbol.toStringTag, {
          get() { throw new Error(`tag getter ${SECRET}`); },
        }), "a Map");
      });

      it.each<[string, () => unknown, string]>([
        // A Proxy forwards the tag of what it wraps.
        ["a Proxy of a Map", () => new Proxy(new Map([[SECRET, true]]), {}), "a Map"],
        ["a Proxy of a Promise", () => new Proxy(Promise.resolve(), {}), "a Promise"],
        ["an object whose tag says Map", () => ({ [Symbol.toStringTag]: "Map", flag: true }), "a Map"],
      ])("%s: taken at its word", (_label, make, got) => {
        expectNotAFlagMap(make, got);
      });

      it("throws, rather than cloning the map as `{}`, when a brand check fails other than with its TypeError", async () => {
        // Out of stack, a brand check throws a RangeError, which says nothing
        // about the slot. Simulated by patching one before a fresh import
        // captures it.
        const original = Boolean.prototype.valueOf;
        const outOfStack = new RangeError("Maximum call stack size exceeded");
        const map = retagged({ flag: true });
        let fresh: typeof import("../src/freeze");
        Boolean.prototype.valueOf = function (this: boolean) {
          if ((this as unknown) === map) throw outOfStack;
          return original.call(this);
        };
        try {
          vi.resetModules();
          fresh = await import("../src/freeze");
        } finally {
          Boolean.prototype.valueOf = original;
        }
        let caught: unknown;
        try {
          fresh.deepCloneAndFreeze(map as unknown as FlagMap);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe(outOfStack);
        // Any other object still passes every check.
        expect(fresh.deepCloneAndFreeze(retagged({ flag: true }) as unknown as FlagMap)).toEqual({ flag: true });
      });

      it("keeps normalizing them below the top level, as it always has", () => {
        const out = deepCloneAndFreeze({
          map: { enabled: true, value: new Map([["a", 1]]) },
          str: { enabled: true, value: new String("ab") },
          bytes: { enabled: true, value: new Uint8Array([1, 2]) },
          date: new Date(0),
          promise: Promise.resolve(1),
        } as unknown as FlagMap);
        expect(out).toEqual({
          map: { enabled: true, value: {} },
          str: { enabled: true, value: { 0: "a", 1: "b" } },
          bytes: { enabled: true, value: { 0: 1, 1: 2 } },
          date: {},
          promise: {},
        });
        expect(isJsonValue(out)).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it("still accepts any other object, whatever its prototype or realm", () => {
      class FlagSet { beta = true; }
      class TaggedFlagSet {
        beta = true;
        get [Symbol.toStringTag]() { return "TaggedFlagSet"; }
      }
      const nullProto = Object.assign(Object.create(null) as object, { a: 1 });
      expect(deepCloneAndFreeze(new FlagSet() as unknown as FlagMap)).toEqual({ beta: true });
      // Names itself, but is no built-in: every brand check fails.
      expect(deepCloneAndFreeze(new TaggedFlagSet() as unknown as FlagMap)).toEqual({ beta: true });
      expect(deepCloneAndFreeze(nullProto as FlagMap)).toEqual({ a: 1 });
      expect(deepCloneAndFreeze(Object.freeze({ a: 1 }))).toEqual({ a: 1 });
      expect(deepCloneAndFreeze(new Proxy({ a: 1 }, {}))).toEqual({ a: 1 });
      // A plain map from another realm, of either prototype.
      expect(deepCloneAndFreeze(runInNewContext("({ a: 1, flag: { enabled: true, value: [1] } })") as FlagMap))
        .toEqual({ a: 1, flag: { enabled: true, value: [1] } });
      expect(deepCloneAndFreeze(runInNewContext("Object.assign(Object.create(null), { a: 1 })") as FlagMap)).toEqual({ a: 1 });
      expect(warn).not.toHaveBeenCalled();
    });

    it("accepts a map whose tag cannot be read — the read's exception does not escape", () => {
      const getter = Object.defineProperty({ a: 1 }, Symbol.toStringTag, {
        get() { throw new Error("tag getter"); },
      });
      const trap = new Proxy({ a: 1 }, {
        get(t, k, r) {
          if (k === Symbol.toStringTag) throw new Error("get trap");
          return Reflect.get(t, k, r);
        },
      });
      expect(deepCloneAndFreeze(getter as FlagMap)).toEqual({ a: 1 });
      expect(deepCloneAndFreeze(trap as FlagMap)).toEqual({ a: 1 });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("values nested deeper than the wire carries", () => {
    // Regression: RemoteShellProxy (0.10) refuses a `flags` value nested
    // past its `maxDepth` (256) as a whole — one deep flag dropped the
    // entire update, and every flag vanished from the browser.

    it("keeps a flag that reaches the wire's limit exactly, and drops each one past it — alone", () => {
      // The map is level 1, so a flag value may nest 255 levels.
      const input = {
        ok: { enabled: true, value: "x" },
        edge: nested(WIRE_MAX_DEPTH - 1),
        edgeList: nestedArrays(WIRE_MAX_DEPTH - 1),
        deep: nested(WIRE_MAX_DEPTH),
        // The flag's own object is a level: its `value` is one too many.
        deepList: { enabled: true, value: nestedArrays(WIRE_MAX_DEPTH - 1) },
      };
      // Unprotected, the wire refuses the whole map; the limit is its own.
      expect(toJsonValue(input, "flags")).toMatchObject({ ok: false, resourceLimit: true });
      expect(toJsonValue({ edge: input.edge, edgeList: input.edgeList }, "flags").ok).toBe(true);

      const out = deepCloneAndFreeze(input as unknown as FlagMap);

      expect(Object.keys(out)).toEqual(["ok", "edge", "edgeList"]);
      expect(out.edge).toEqual(input.edge);
      expect(out.edgeList).toEqual(input.edgeList);
      expect(toJsonValue(out, "flags").ok).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(loggedPaths()).toBe(
        "flags.deep (nested deeper than 256 levels), flags.deepList (nested deeper than 256 levels)",
      );
    });

    it("still collapses a cycle at the limit to null: a null is not a level", () => {
      const edge = nested(WIRE_MAX_DEPTH - 1);
      let innermost = edge;
      while (innermost.next) innermost = innermost.next as Record<string, unknown>;
      innermost.back = edge;
      const out = deepCloneAndFreeze({ edge } as unknown as FlagMap);
      expect(Object.keys(out)).toEqual(["edge"]);
      expect(toJsonValue(out, "flags").ok).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("drops a flag whose getters never end at the limit, long before the stack runs out", () => {
      const out = deepCloneAndFreeze({ ok: 1, deep: { enabled: true, value: endless() } } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1 });
      expect(loggedPaths()).toBe("flags.deep (nested deeper than 256 levels)");
    });
  });

  describe("logging what was dropped", () => {
    it("logs one warning per call, naming each dropped path — never the values or the read errors", () => {
      const list: unknown[] = [1, 2, 3];
      Object.defineProperty(list, 1, { enumerable: true, get() { throw new Error("element-error-text"); } });
      const out = deepCloneAndFreeze({
        ok: { enabled: true, value: "visible-secret" },
        get bad() { throw new Error("getter-error-text"); },
        nested: { keep: "x", get bad() { throw new Error("nested-error-text"); } },
        list,
        "my-flag": { enabled: true, value: revoked() },
        deep: { enabled: true, value: nested(WIRE_MAX_DEPTH) },
      } as unknown as FlagMap);

      expect(out).toEqual({ ok: { enabled: true, value: "visible-secret" }, nested: { keep: "x" }, list: [1, null, 3], "my-flag": { enabled: true } });
      expect(warn).toHaveBeenCalledTimes(1);
      // A message only: no error object or value passed along with it.
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(loggedPaths()).toBe([
        "flags.bad (could not be read)",
        "flags.nested.bad (could not be read)",
        "flags.list[1] (could not be read)",
        'flags["my-flag"].value (could not be read)',
        "flags.deep (nested deeper than 256 levels)",
      ].join(", "));
      const message = warn.mock.calls[0][0] as string;
      for (const secret of ["visible-secret", "deep-secret", "error-text"]) expect(message).not.toContain(secret);
    });

    it("logs nothing for what it normalizes, nor for a clean map", () => {
      const cyclic: Record<string, unknown> = { enabled: true };
      cyclic.self = cyclic;
      deepCloneAndFreeze({
        u: undefined, f: () => true, s: Symbol("s"), nan: Number.NaN, big: BigInt(1),
        date: new Date(0), list: [undefined, , 1], cyclic,
      } as unknown as FlagMap);
      deepCloneAndFreeze({ a: { enabled: true, value: [1, "x", null] } });
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs a path once per process: a flag broken on every call is not logged again", () => {
      for (let i = 0; i < 5; i++) deepCloneAndFreeze(withThrowingGetters({ ok: 1 }, "bad") as unknown as FlagMap);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(loggedPaths(0)).toBe("flags.bad (could not be read)");

      // A path not logged yet is logged — alone.
      deepCloneAndFreeze(throwingGetters("bad", "other") as unknown as FlagMap);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(loggedPaths(1)).toBe("flags.other (could not be read)");

      // The same path is the same path whatever made it unreadable.
      deepCloneAndFreeze({ other: nested(WIRE_MAX_DEPTH) } as unknown as FlagMap);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("names only the flag when the whole flag is dropped, not what was dropped inside it first", () => {
      // In this key order: `bad` is recorded before the flag is dropped.
      const flag = withThrowingGetters({ enabled: true }, "bad");
      flag.value = nested(WIRE_MAX_DEPTH);
      const range = Object.defineProperty(throwingGetters("bad"), "at", {
        enumerable: true,
        get() { return new Date(Number.NaN).toISOString(); },
      });
      const map = throwingGetters("first");
      Object.assign(map, { flag, range, last: withThrowingGetters({ keep: 1 }, "bad") });
      const out = deepCloneAndFreeze(map as unknown as FlagMap);
      expect(out).toEqual({ last: { keep: 1 } });
      expect(loggedPaths()).toBe([
        "flags.first (could not be read)",
        "flags.flag (nested deeper than 256 levels)",
        "flags.range (could not be read)",
        "flags.last.bad (could not be read)",
      ].join(", "));
    });

    it("prints paths the way @wc-bindable/remote does: odd keys quoted, long keys and long paths shortened", () => {
      // A chain of 20 segments: chain.l0 … l17.bad
      let chain: Record<string, unknown> = throwingGetters("bad");
      for (let i = 17; i >= 0; i--) chain = { [`l${i}`]: chain };
      deepCloneAndFreeze({
        chain,
        [`$ok_${"k".repeat(60)}`]: throwingGetters("x"),
        ["k".repeat(70)]: throwingGetters("x"),
        "0": throwingGetters("x"),
        "": throwingGetters("x"),
        list: [[1, throwingGetters("x")]],
      } as unknown as FlagMap);
      expect(loggedPaths()).toBe([
        // Integer-like keys come first, as `Object.keys` orders them.
        'flags["0"].x (could not be read)',
        "flags.chain.l0.l1.l2.l3.l4…(8 levels)….l13.l14.l15.l16.l17.bad (could not be read)",
        `flags.$ok_${"k".repeat(60)}.x (could not be read)`,
        `flags["${"k".repeat(64)}…"].x (could not be read)`,
        'flags[""].x (could not be read)',
        "flags.list[0][1].x (could not be read)",
      ].join(", "));
    });

    it("stops after 100 paths, and the warning that reaches the limit says so", () => {
      const flags = (from: number, count: number) =>
        throwingGetters(...Array.from({ length: count }, (_, i) => `f${from + i}`)) as unknown as FlagMap;
      deepCloneAndFreeze(flags(0, 60));
      deepCloneAndFreeze(flags(60, 60));
      deepCloneAndFreeze(flags(120, 10));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(loggedPaths(0).split(", ")).toHaveLength(60);
      const second = warn.mock.calls[1][0] as string;
      expect(second.endsWith(" 100 paths have been logged; further ones will not be.)")).toBe(true);
      expect(second).toContain("flags.f60 (could not be read)");
      expect(second).toContain("flags.f99 (could not be read)");
      expect(second).not.toContain("flags.f100");
      expect(second.match(/could not be read/g)).toHaveLength(40);

      // The test-only reset starts the record over.
      __resetDroppedValueWarnings();
      deepCloneAndFreeze(flags(0, 1));
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("still returns the map when the log itself fails", () => {
      warn.mockImplementation(() => { throw new Error("log sink down"); });
      const out = deepCloneAndFreeze(withThrowingGetters({ ok: 1 }, "bad") as unknown as FlagMap);
      expect(out).toEqual({ ok: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("logs nothing for a map it throws on", () => {
      expect(() => deepCloneAndFreeze(new Proxy({}, { ownKeys() { throw new Error("ownKeys trap"); } }) as FlagMap)).toThrow();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("JSON normalization", () => {
    // Since @wc-bindable/remote 0.10 a single non-JSON leaf makes the
    // remote shell drop the WHOLE flag map. Leaves without a JSON form
    // are normalized the way the pre-0.10 wire's JSON.stringify did.

    it("drops object entries whose value has no JSON form (undefined / function / symbol)", () => {
      const out = deepCloneAndFreeze({
        keep: 1,
        u: undefined,
        f: () => true,
        s: Symbol("s"),
        nested: { keep: "x", u: undefined },
      } as unknown as FlagMap);
      expect(out).toEqual({ keep: 1, nested: { keep: "x" } });
      expect(Object.keys(out)).toEqual(["keep", "nested"]);
      expect(Object.keys(out.nested as object)).toEqual(["keep"]);
      expect(isJsonValue(out)).toBe(true);
    });

    it("turns array elements without a JSON form, and holes, into null", () => {
      const sparse = [1, , 3];
      const out = deepCloneAndFreeze({
        list: [1, undefined, () => 0, "x"],
        sparse,
      } as unknown as FlagMap);
      expect(out.list).toEqual([1, null, null, "x"]);
      expect(out.sparse).toEqual([1, null, 3]);
      expect(1 in (out.sparse as unknown[])).toBe(true);
      expect(isJsonValue(out)).toBe(true);
    });

    it("turns NaN / ±Infinity into null and keeps finite numbers", () => {
      const out = deepCloneAndFreeze({
        nan: Number.NaN,
        inf: Infinity,
        ninf: -Infinity,
        n: 1.5,
      } as unknown as FlagMap);
      expect(out).toEqual({ nan: null, inf: null, ninf: null, n: 1.5 });
    });

    it("turns a bigint into its decimal string", () => {
      const out = deepCloneAndFreeze({ big: BigInt("12345678901234567890") } as unknown as FlagMap);
      expect(out.big).toBe("12345678901234567890");
    });

    it("copies non-plain objects / arrays into plain ones (own enumerable keys)", () => {
      class Variation { constructor(public enabled: boolean) {} }
      class TaggedArray extends Array<number> {}
      const tagged = TaggedArray.from([1, 2]);
      const out = deepCloneAndFreeze({
        cls: new Variation(true),
        date: new Date(0),
        map: new Map([["a", 1]]),
        tagged,
      } as unknown as FlagMap);
      expect(out).toEqual({ cls: { enabled: true }, date: {}, map: {}, tagged: [1, 2] });
      expect(Object.getPrototypeOf(out.cls)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(out.tagged)).toBe(Array.prototype);
      expect(isJsonValue(out)).toBe(true);
    });

    it("keeps an own `__proto__` key as an entry instead of re-pointing the prototype", () => {
      const input = JSON.parse('{"__proto__": {"polluted": true}, "flag": {"__proto__": 1, "x": 2}}') as FlagMap;
      const out = deepCloneAndFreeze(input);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ polluted: true });
      expect((out as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(out.flag, "__proto__")?.value).toBe(1);
      expect(Object.isFrozen(out)).toBe(true);
      expect(isJsonValue(out)).toBe(true);
    });
  });

  describe("values that cannot be read", () => {
    // Providers can hand over objects whose reads throw. `JSON.stringify`
    // throws on them; the clone treats such a value as having no JSON form
    // instead — dropped from an object, `null` in an array — as it already
    // substitutes for a cycle or a bigint, so one of them never takes the
    // rest of the map down. Only a map that cannot be enumerated at all
    // throws (FlagsCore publishes that as a provider failure).

    it("drops an entry whose getter or Proxy `get` trap throws, at any depth", () => {
      const out = deepCloneAndFreeze({
        ok: 1,
        get bad() { throw new Error("getter"); },
        nested: { keep: "x", get bad() { throw new Error("nested getter"); } },
        proxied: new Proxy({ keep: true, bad: 1 }, {
          get(t, k, r) {
            if (k === "bad") throw new Error("get trap");
            return Reflect.get(t, k, r);
          },
        }),
      } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1, nested: { keep: "x" }, proxied: { keep: true } });
      expect(Object.keys(out)).toEqual(["ok", "nested", "proxied"]);
      expect(Object.isFrozen(out.nested)).toBe(true);
      expect(isJsonValue(out)).toBe(true);
    });

    it("drops a value whose contents cannot be inspected", () => {
      const out = deepCloneAndFreeze({
        ok: 1,
        revoked: revoked(),
        ownKeys: new Proxy({ a: 1 }, { ownKeys() { throw new Error("ownKeys trap"); } }),
        descriptor: new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } }),
        length: new Proxy([1, 2], {
          get(t, k, r) {
            if (k === "length") throw new Error("length trap");
            return Reflect.get(t, k, r);
          },
        }),
        flag: { enabled: true, value: revoked() },
      } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1, flag: { enabled: true } });
      expect(isJsonValue(out)).toBe(true);
    });

    it("turns an array element that cannot be read into null", () => {
      const list: unknown[] = [1, 2, revoked(), 4];
      Object.defineProperty(list, 1, { enumerable: true, get() { throw new Error("element getter"); } });
      const out = deepCloneAndFreeze({ list } as unknown as FlagMap);
      expect(out.list).toEqual([1, null, null, 4]);
      expect(Object.isFrozen(out.list)).toBe(true);
      expect(isJsonValue(out)).toBe(true);
    });

    it("reads an array's length once, as JSON.stringify does", () => {
      // Re-reading it per index let a Proxy that reports more on every read
      // keep the loop going (here, from 2 to 1,000 elements).
      let reads = 0;
      const growing = new Proxy(["a", "b"], {
        get(t, k, r) {
          if (k === "length") return reads++ === 0 ? 2 : 1_000;
          return Reflect.get(t, k, r);
        },
      });
      const out = deepCloneAndFreeze({ list: growing } as unknown as FlagMap);
      expect(out.list).toEqual(["a", "b"]);
      expect(reads).toBe(1);
    });

    it("drops the whole flag when a read below it throws a RangeError — what running out of stack throws", () => {
      // A lazy getter formatting an invalid date throws `RangeError` too; it
      // cannot be told apart safely, so it unwinds to the top-level entry.
      // Siblings, and a top-level entry's own failing read, stay granular.
      const invalidDate = () => new Date(Number.NaN).toISOString();
      const out = deepCloneAndFreeze({
        ok: 1,
        get top() { return invalidDate(); },
        flag: { enabled: true, value: { get at() { return invalidDate(); } } },
        sibling: { enabled: true, get bad() { throw new Error("getter"); } },
      } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1, sibling: { enabled: true } });
    });

    it("still collapses a cycle reached through a getter, next to a getter that throws", () => {
      const flag: Record<string, unknown> = { enabled: true };
      Object.defineProperty(flag, "self", { enumerable: true, get: () => flag });
      Object.defineProperty(flag, "bad", { enumerable: true, get() { throw new Error("getter"); } });
      const out = deepCloneAndFreeze({ ok: 1, flag } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1, flag: { enabled: true, self: null } });
      expect(isJsonValue(out)).toBe(true);
    });

    it("drops the whole flag when its getters never end, not a cut wherever the stack ran out — also once optimized", () => {
      // Warm the clone up first: a stack check that calls into the engine
      // (a regex on the message) passed cold and failed once optimized, V8
      // reporting the regex it could not compile out of stack as a
      // SyntaxError — and the flag came back as a chain ~1,800 levels deep.
      // (The depth limit now stops this chain before the stack runs out;
      // the next test runs one out on purpose.)
      const warm = {
        a: { enabled: true, value: [1, "x", null, { b: [true] }] },
        get bad() { throw new Error("getter"); },
      } as unknown as FlagMap;
      for (let i = 0; i < 5_000; i++) deepCloneAndFreeze(warm);

      for (let i = 0; i < 3; i++) {
        const out = deepCloneAndFreeze({ ok: 1, deep: { enabled: true, value: endless() } } as unknown as FlagMap);
        expect(Object.keys(out)).toEqual(["ok"]);
      }
    });

    it("drops the whole flag, never a cut chain, when the stack runs out before the depth limit does", () => {
      // The depth limit now stops an endless chain first (see "values nested
      // deeper than the wire carries"), so run the clone from deep in the
      // stack: at the deepest frame that can complete it at all, the chain
      // runs the stack out on its way to the limit.
      let out: FlagMap | undefined;
      const dive = (): void => {
        try {
          dive();
        } catch {
          // The frame below had no stack left.
        }
        if (out !== undefined) return;
        try {
          out = deepCloneAndFreeze({ ok: 1, deep: { enabled: true, value: endless() } } as unknown as FlagMap);
        } catch {
          // Not even enough stack to finish the top level: one frame up.
        }
      };
      dive();
      expect(Object.keys(out!)).toEqual(["ok"]);
    });

    it("drops the whole flag when a nested read throws a value `instanceof` cannot inspect", () => {
      // The stack check cannot decide (a revoked Proxy throws on
      // `instanceof`), so the error keeps unwinding to the top-level entry.
      const thrown = revoked();
      const out = deepCloneAndFreeze({
        ok: 1,
        flag: { enabled: true, value: { get bad() { throw thrown; } } },
      } as unknown as FlagMap);
      expect(out).toEqual({ ok: 1 });
    });

    it.each<[string, () => unknown]>([
      ["a revoked Proxy", () => revoked()],
      ["a Proxy whose ownKeys trap throws", () => new Proxy({ a: 1 }, { ownKeys() { throw new Error("ownKeys trap"); } })],
      ["a Proxy whose getOwnPropertyDescriptor trap throws", () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } })],
      ["undefined", () => undefined],
      ["null", () => null],
    ])("throws when the map itself cannot be enumerated: %s", (_label, make) => {
      expect(() => deepCloneAndFreeze(make() as FlagMap)).toThrow();
    });

    it("throws the trap's own exception, so a caller can publish it", () => {
      const trap = new Error("ownKeys trap");
      let caught: unknown;
      try {
        deepCloneAndFreeze(new Proxy({}, { ownKeys() { throw trap; } }) as FlagMap);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(trap);
    });
  });
});

describe("deepFreeze", () => {
  it("freezes the outer map and nested object / array values in place", () => {
    const input = {
      toggle: { enabled: true, value: null },
      list: { enabled: true, value: ["a", "b"] },
    };
    const out = deepFreeze(input);
    // Freeze-in-place: the SAME object is returned, not a clone.
    expect(out).toBe(input);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.toggle)).toBe(true);
    const list = (out.list as { value: string[] }).value;
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("does NOT clone — nested references are the original objects", () => {
    const inner = { enabled: true, value: 1 };
    const input = { flag: inner };
    const out = deepFreeze(input);
    expect(out.flag).toBe(inner);
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it("passes primitives and null through without throwing", () => {
    const out = deepFreeze({ a: 1, b: "x", c: true, d: null });
    expect(out).toEqual({ a: 1, b: "x", c: true, d: null });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("terminates on a self-referential object value instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { enabled: true };
    cyclic.self = cyclic;
    const input = { flag: cyclic } as unknown as FlagMap;
    expect(() => deepFreeze(input)).not.toThrow();
    // The cycle is left in place (already frozen on the second visit),
    // not collapsed — there is no fresh object to substitute.
    const flag = (input.flag as Record<string, unknown>);
    expect(Object.isFrozen(flag)).toBe(true);
    expect(flag.self).toBe(flag);
  });

  it("terminates on a cycle that runs through an array", () => {
    const arr: unknown[] = ["x"];
    arr.push(arr);
    const input = { flag: { value: arr } } as unknown as FlagMap;
    expect(() => deepFreeze(input)).not.toThrow();
    expect(Object.isFrozen(arr)).toBe(true);
  });

  it("freezes a shared non-ancestor reference exactly once (DAG, not cycle)", () => {
    const shared = { v: 1 };
    const input = { a: { value: shared }, b: { value: shared } } as unknown as FlagMap;
    const out = deepFreeze(input);
    expect((out.a as { value: unknown }).value).toBe(shared);
    expect((out.b as { value: unknown }).value).toBe(shared);
    expect(Object.isFrozen(shared)).toBe(true);
  });
});
