import { describe, it, expect } from "vitest";
import { identityKey, stableStringify, __stableValue } from "../src/providers/_identityKey";

describe("_identityKey helpers", () => {
  describe("stableStringify", () => {
    it("sorts keys at every depth so two maps compare equal regardless of insertion order", () => {
      const a = stableStringify({ b: 1, a: { y: 2, x: 1 } });
      const b = stableStringify({ a: { x: 1, y: 2 }, b: 1 });
      expect(a).toBe(b);
    });

    it("distinguishes different values at the same key set", () => {
      expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    });
  });

  describe("__stableValue", () => {
    it("serializes primitives via JSON.stringify", () => {
      expect(__stableValue(null)).toBe("null");
      expect(__stableValue(1)).toBe("1");
      expect(__stableValue("x")).toBe('"x"');
      expect(__stableValue(true)).toBe("true");
    });

    it("preserves array element order", () => {
      expect(__stableValue(["b", "a", "c"])).toBe('["b","a","c"]');
    });
  });

  describe("collision resistance", () => {
    // Regression guard: the previous `userId + "|" + stableStringify(attrs)`
    // shape collided when a user id contained the `|` separator. Auth0
    // `sub` values have the form `auth0|abc123`, so the failure mode
    // was reachable in production. Quoting the user id via
    // `JSON.stringify` makes the boundary unambiguous.

    it("Auth0-style userId with `|` does not collide with a crafted alternative identity", () => {
      // Same canonical key shape under the OLD scheme:
      //   "auth0|abc123" + "|" + '{"role":"admin"}'
      //   "auth0"        + "|" + '{"role":"admin"}'  // with userId carrying the rest
      // i.e. one identity's id + separator + attrs produces a string
      // that another identity could also emit. After the fix the two
      // must key distinctly.
      const a = identityKey({ userId: "auth0|abc123", attrs: { role: "admin" } });
      const b = identityKey({
        userId: "auth0",
        attrs: { role: "admin" },
      });
      expect(a).not.toBe(b);
    });

    it("a userId that itself contains a JSON-quote-and-pipe sequence still keys distinctly", () => {
      // The escaped form must survive the quoting layer too — without
      // JSON.stringify quoting, a id like `"|"` could be crafted to
      // mimic the separator boundary literally.
      const a = identityKey({ userId: '"|"', attrs: {} });
      const b = identityKey({ userId: "", attrs: { x: 1 } });
      expect(a).not.toBe(b);
    });
  });

  describe("circular reference handling", () => {
    // Regression guard for [R1-05]: `FlagIdentity.attrs` is user-
    // supplied, so an accidental cycle must not blow the stack. The
    // guard replaces any node already on the current recursion path
    // with the "[Circular]" sentinel and keeps walking.

    it("does not stack-overflow on a self-referential attrs object", () => {
      const attrs: Record<string, unknown> = { kind: "user" };
      attrs.self = attrs;
      // Guarded — must terminate.
      const out = stableStringify(attrs);
      expect(out).toContain('"kind":"user"');
      expect(out).toContain('"self":"[Circular]"');
    });

    it("tolerates deeper cycles inside nested objects", () => {
      const inner: Record<string, unknown> = { name: "alice" };
      const outer: Record<string, unknown> = { inner };
      inner.back = outer;
      const out = stableStringify(outer);
      expect(out).toContain('"name":"alice"');
      expect(out).toContain('"back":"[Circular]"');
    });

    it("tolerates cycles through arrays", () => {
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => __stableValue(arr)).not.toThrow();
      expect(__stableValue(arr)).toBe('["[Circular]"]');
    });

    it("shared non-ancestor references are NOT flagged as circular", () => {
      // Two sibling branches both pointing at the same leaf object
      // is a DAG, not a cycle — must serialize normally.
      const shared = { v: 1 };
      const obj = { a: shared, b: shared };
      const out = stableStringify(obj);
      // Both siblings carry the same serialized form.
      expect(out).toBe('{"a":{"v":1},"b":{"v":1}}');
    });

    it("produces stable keys for otherwise-identical identities with cycles", () => {
      // `identityKey` uses stableStringify under the hood. Two
      // identity objects with the same shape — cycles and all —
      // should key identically, otherwise bucket dedupe would
      // collapse under cycle-containing inputs.
      const makeAttrs = (): Record<string, unknown> => {
        const a: Record<string, unknown> = { email: "a@x" };
        a.self = a;
        return a;
      };
      const k1 = identityKey({ userId: "alice", attrs: makeAttrs() });
      const k2 = identityKey({ userId: "alice", attrs: makeAttrs() });
      expect(k1).toBe(k2);
    });
  });
});
