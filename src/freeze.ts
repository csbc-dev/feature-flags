import type { FlagMap, FlagValue } from "./types.js";

/**
 * Deep-clone-and-freeze a {@link FlagMap}.
 *
 * Why clone instead of plain `Object.freeze(outer)`:
 * 1. **Consumer-side mutation defense** — without freezing the nested
 *    object values (Flagsmith's `{ enabled, value }` or JSON-shaped
 *    flags), a consumer writing `values.flags.x.enabled = true` would
 *    silently succeed. The docstring on `FlagsCore.flags` promises a
 *    frozen snapshot; the contract must hold all the way down.
 * 2. **Provider-source isolation** — a Provider (notably
 *    {@link InMemoryFlagProvider}) may hand us a map whose values
 *    share references with its own rule definitions. If we only froze
 *    the outer map, a consumer mutation would contaminate the
 *    Provider's source of truth. If we deep-*froze* the Provider's
 *    own references, subsequent rule updates inside the Provider
 *    would throw in strict mode. Cloning isolates both sides.
 *
 * 3. **JSON normalization** — the result is always a JSON value, so it
 *    can cross the `@wc-bindable/remote` wire. Since remote 0.10 the
 *    wire validates instead of coercing, and ONE non-JSON leaf anywhere
 *    in the map makes the shell drop the whole `flags` update (and list
 *    `flags` in `getterFailures` on `sync`) — every flag would vanish
 *    from the browser because of one bad value. {@link FlagValue} rules
 *    those leaves out by type, but Providers feed this function values
 *    that are only `unknown` at the SDK boundary (LaunchDarkly JSON
 *    variations, Flagsmith's `f.value`, custom / InMemory providers).
 *    They are normalized the way the pre-0.10 wire's `JSON.stringify`
 *    did, so browsers observe exactly what they observed before:
 *    - `undefined` / functions / symbols: the entry is dropped from an
 *      object, and becomes `null` in an array (holes too);
 *    - `NaN` / `±Infinity` → `null`;
 *    - `bigint` → its decimal string (`JSON.stringify` would throw;
 *      the providers coerce bigint identity traits the same way);
 *    - any other object → a plain copy of its own enumerable string
 *      keys (class instances, `Date` → `{}`, `Map` / `Set` → `{}`),
 *      and any array → a plain array — exactly what this clone has
 *      always produced.
 *    Normalizing silently (no warning) matches the cycle handling
 *    below and the providers' own `undefined` → `null` coercions; the
 *    Core publishes the same normalized map locally, so local and
 *    remote observers agree.
 *
 * Circular references: {@link FlagValue} forbids cycles by type, but
 * the Providers feed this function arbitrary SDK values (see 3). A
 * WeakSet tracks the current recursion path so an accidental cycle is
 * replaced with `null` rather than overflowing the stack — mirrors the
 * defensive cycle handling in `_identityKey.ts`.
 */
export function deepCloneAndFreeze(map: FlagMap): FlagMap {
  return _cloneEntries(map, new WeakSet<object>());
}

/**
 * Deep-*freeze* a {@link FlagMap} **in place** — no clone.
 *
 * Use this instead of {@link deepCloneAndFreeze} when the caller is the
 * sole owner of `map` and every nested value is a fresh object that is
 * not shared with any other owner. The canonical caller is the Shell's
 * `_asFlagMap`: `<feature-flags>` is remote-only by design (see
 * CLAUDE.md §Position of this package), so the value handed to its
 * `bind()` callback was just deserialized off the wire by
 * `RemoteCoreProxy` — a brand-new object graph with no upstream owner.
 * Cloning it again (as the Core already did before serialization)
 * would be pure waste on the hot path.
 *
 * The freeze still walks every level so consumers cannot mutate nested
 * flag values (`{ enabled, value }` objects, JSON-shaped flags). The
 * same WeakSet cycle guard as {@link deepCloneAndFreeze} terminates an
 * accidental cycle rather than overflowing the stack — but, unlike the
 * clone path, a cycle is left in place (already-frozen on the second
 * visit) rather than collapsed to `null`, because there is no fresh
 * object to substitute.
 *
 * Do NOT use this on a map whose values may be shared with a Provider's
 * rule definitions or an SDK's internal objects — freezing those in
 * place would throw on the next in-place update upstream. That is what
 * {@link deepCloneAndFreeze} (clone + freeze) is for.
 */
export function deepFreeze(map: FlagMap): FlagMap {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(map)) {
    _freezeValue(map[key], seen);
  }
  return Object.freeze(map);
}

function _freezeValue(v: FlagValue, seen: WeakSet<object>): void {
  if (v === null || typeof v !== "object") return;
  // Already visited on the current recursion path (cycle) or a sibling
  // branch (DAG) — either way it is or will be frozen; do not recurse
  // again. `Object.freeze` is idempotent so a DAG re-visit is harmless,
  // but skipping it also makes an ancestor-of-self cycle terminate.
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const e of v) _freezeValue(e, seen);
  } else {
    for (const k of Object.keys(v)) {
      _freezeValue((v as Record<string, FlagValue>)[k], seen);
    }
  }
  Object.freeze(v);
}

/**
 * Frozen plain-object clone of `source`'s own enumerable string keys.
 * An entry whose value has no JSON form ({@link _cloneValue} returns
 * `undefined`) is dropped, as `JSON.stringify` drops it.
 */
function _cloneEntries(source: object, seen: WeakSet<object>): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (const k of Object.keys(source)) {
    const value = _cloneValue((source as Record<string, unknown>)[k], seen);
    if (value === undefined) continue;
    if (k === "__proto__") {
      // An own `__proto__` key (as `JSON.parse` produces) must stay an
      // own entry. Plain assignment would re-point the clone's prototype
      // instead — losing the entry, and turning the whole map into a
      // non-JSON value the remote wire refuses.
      Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    } else {
      out[k] = value;
    }
  }
  return Object.freeze(out);
}

/**
 * Clone one value into its frozen JSON form, or `undefined` when it has
 * none (see {@link deepCloneAndFreeze} §3 for the mapping). The caller
 * decides what "none" means: dropped from an object, `null` in an array.
 */
function _cloneValue(v: unknown, seen: WeakSet<object>): FlagValue | undefined {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : null;
    case "bigint":
      return String(v);
    case "object":
      break;
    default:
      // undefined / function / symbol.
      return undefined;
  }
  if (v === null) return null;
  // Cycle guard: a value already on the current recursion path is
  // collapsed to `null` rather than recursed into. `FlagValue` has no
  // legal cycle, so `null` is the closest in-contract sentinel.
  if (seen.has(v)) return null;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      // Index loop, not `v.map()`: `map` keeps holes (and a subclass's
      // species), neither of which is a JSON array.
      const arr: FlagValue[] = [];
      for (let i = 0; i < v.length; i++) {
        const e = _cloneValue(v[i], seen);
        arr.push(e === undefined ? null : e);
      }
      return Object.freeze(arr) as FlagValue;
    }
    return _cloneEntries(v, seen) as FlagValue;
  } finally {
    // Pop on exit so sibling subtrees that legitimately share a nested
    // object ref still clone normally; only ancestor-of-self cycles
    // are collapsed.
    seen.delete(v);
  }
}
