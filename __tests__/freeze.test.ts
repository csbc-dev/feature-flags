import { describe, it, expect } from "vitest";
import { isJsonValue } from "@wc-bindable/remote";
import { deepCloneAndFreeze, deepFreeze } from "../src/freeze";
import type { FlagMap } from "../src/types";

describe("deepCloneAndFreeze", () => {
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

    function revoked(): object {
      const r = Proxy.revocable({ a: 1 }, {});
      r.revoke();
      return r.proxy;
    }

    /** A getter chain that never ends: every read returns a fresh object, so there is no cycle to catch. */
    function endless(): object {
      return Object.defineProperty({}, "next", { enumerable: true, get: endless });
    }

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
