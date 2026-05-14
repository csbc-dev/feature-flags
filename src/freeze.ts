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
 * Scope: {@link FlagValue} is JSON-serializable by type. `null`,
 * primitives, arrays, and plain objects are handled. Non-plain
 * objects (class instances, Dates) are outside the contract and are
 * passed through — the flag protocol does not carry them.
 *
 * Circular references: {@link FlagValue} forbids cycles by type, but
 * the Providers feed this function values that are only `unknown` at
 * the SDK boundary (LaunchDarkly JSON variations, Flagsmith's
 * `f.value`). A WeakSet tracks the current recursion path so an
 * accidental cycle is replaced with `null` rather than overflowing the
 * stack — mirrors the defensive cycle handling in `_identityKey.ts`.
 */
export function deepCloneAndFreeze(map: FlagMap): FlagMap {
  const out: Record<string, FlagValue> = {};
  const seen = new WeakSet<object>();
  for (const key of Object.keys(map)) {
    out[key] = _cloneValue(map[key], seen);
  }
  return Object.freeze(out);
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

function _cloneValue(v: FlagValue, seen: WeakSet<object>): FlagValue {
  if (v === null || typeof v !== "object") return v;
  // Cycle guard: a value already on the current recursion path is
  // collapsed to `null` rather than recursed into. `FlagValue` has no
  // legal cycle, so `null` is the closest in-contract sentinel.
  if (seen.has(v)) return null;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const arr: FlagValue[] = v.map((e) => _cloneValue(e, seen));
      return Object.freeze(arr) as FlagValue;
    }
    const out: Record<string, FlagValue> = {};
    for (const k of Object.keys(v)) {
      out[k] = _cloneValue((v as Record<string, FlagValue>)[k], seen);
    }
    return Object.freeze(out) as FlagValue;
  } finally {
    // Pop on exit so sibling subtrees that legitimately share a nested
    // object ref still clone normally; only ancestor-of-self cycles
    // are collapsed.
    seen.delete(v);
  }
}
