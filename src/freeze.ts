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
 * 4. **Values that cannot be read** — a getter or a Proxy `get` trap
 *    that throws, or a value whose contents cannot be inspected (a
 *    revoked Proxy, a throwing `ownKeys` / `getOwnPropertyDescriptor`
 *    trap, an array whose `length` throws) — have no JSON form either:
 *    dropped from an object, `null` in an array, exactly like
 *    `undefined`. `JSON.stringify` would throw instead; like a cycle
 *    (below) or a bigint, one such value must not take the rest of the
 *    map down. A flag in which a nested read throws a `RangeError`
 *    (what running out of stack throws) is dropped as a whole by its
 *    top-level entry — see {@link _cloneEntry}.
 *
 * 5. **Values nested deeper than the wire carries** — a flag containing
 *    an object / array at a nesting level past {@link MAX_WIRE_DEPTH}
 *    (the map itself is level 1) is dropped as a whole, like a
 *    `RangeError` above, rather than cut at the limit (a truncated value
 *    would be a different value, not the provider's). That includes a
 *    flag whose getters never end (each read returns a fresh object, so
 *    there is no cycle to catch): the limit stops it long before the
 *    stack would.
 *
 * Unlike the normalizations in 3, a value dropped under 4 or 5 is
 * *logged*: it is a value the provider meant to publish, and nothing else
 * would tell anyone it is gone. One `console.warn` per call names the
 * dropped paths (`flags.checkout.value[2]`) — never the values, nor the
 * errors their reads threw, which may carry them — and each path is
 * logged once per process, so a flag that is unreadable on every poll /
 * push / identify does not flood the log (see {@link _warnDropped}). Not
 * an error: the rest of the map is published as usual.
 *
 * The one thing this function throws on is a `map` that is not a flag
 * map — anything but a non-array object (`null` / `undefined`, a string,
 * a number, an array, a function …; `Object.keys` would turn `"ab"` into
 * `{ 0: "a", 1: "b" }`), or a built-in object whose contents are not its
 * own keys (a `Map` / `Set` / `WeakMap` / `WeakSet`, a `Date`, a `RegExp`,
 * an `Error`, a `Promise`, a boxed primitive such as `new String("ab")`, an
 * `ArrayBuffer` / `SharedArrayBuffer`, a typed array or a `DataView`; see
 * {@link _builtInName}: a `Map` would be published as `{}`,
 * `new String("ab")` as `{ 0: "a", 1: "b" }`) — or that cannot be
 * enumerated at all (a revoked Proxy, a throwing `ownKeys` /
 * `getOwnPropertyDescriptor` trap): there is no readable part to publish,
 * and publishing `{}` would silently wipe every flag. The shape check
 * throws a `TypeError` naming only the type it got; an error from
 * enumerating is thrown as-is. Either way nothing is produced (nor
 * logged), and `FlagsCore` publishes the error as a failure of the
 * identify / reload / push that delivered the map. Below the top level
 * those built-ins are normalized as in 3 (`Date` → `{}`), as before.
 *
 * Circular references: {@link FlagValue} forbids cycles by type, but
 * the Providers feed this function arbitrary SDK values (see 3). A
 * WeakSet tracks the current recursion path — starting with `map`
 * itself, so a value pointing back at the map is caught where it
 * points, not one level later — and an accidental cycle is replaced
 * with `null` (silently, as in 3) rather than overflowing the stack —
 * mirrors the defensive cycle handling in `_identityKey.ts`.
 */
export function deepCloneAndFreeze(map: FlagMap): FlagMap {
  // Typed as a map, but it is whatever the provider resolved or pushed.
  const value: unknown = map;
  // `Array.isArray` throws for a revoked Proxy — the "cannot be enumerated"
  // case, thrown as-is like the `Object.keys` error below.
  const isArray = Array.isArray(value);
  if (typeof value !== "object" || value === null || isArray) {
    throw _notAFlagMap(value === null ? "null" : isArray ? "an array" : value === undefined ? "undefined" : `a ${typeof value}`);
  }
  const builtIn = _builtInName(value);
  if (builtIn !== undefined) throw _notAFlagMap(_describeBuiltIn(builtIn));
  const ctx: CloneContext = { seen: new WeakSet<object>([map]), dropped: [] };
  const out = _cloneEntries(map, ctx, null, 1);
  if (ctx.dropped.length > 0) _warnDropped(ctx.dropped);
  return out;
}

/**
 * The error {@link deepCloneAndFreeze} throws for a `map` that is not a flag
 * map. `got` names the type only, never the value: this message is
 * published on `error` and crosses the wire to the browser.
 */
function _notAFlagMap(got: string): TypeError {
  return new TypeError(`[@csbc-dev/feature-flags] a flag map must be an object of flags; the provider returned ${got}.`);
}

/** Typed arrays, by the name each one's `Symbol.toStringTag` reports. */
const TYPED_ARRAY_NAMES = [
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];

/** Boxed primitives: "a String object", since "a string" is what the primitive is called. */
const BOXED_PRIMITIVES: ReadonlySet<string> = new Set(["String", "Number", "Boolean", "Symbol", "BigInt"]);

/**
 * Built-in objects that are not maps of flags, by the name
 * `Object.prototype.toString` reports for each. What they hold lives in
 * internal slots, not in own enumerable keys, so a clone of one as a map
 * would publish `{}` (a `Map`, a `Date`, a `Promise` …) or its indices
 * (`new String("ab")` → `{ 0: "a", 1: "b" }`, a typed array) in place of
 * every flag. Rejected at the top level only (see {@link _builtInName});
 * as a flag's value, each is normalized like any other object.
 */
const NOT_FLAG_MAPS: ReadonlySet<string> = new Set([
  "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Error", "Promise",
  ...BOXED_PRIMITIVES,
  "ArrayBuffer", "SharedArrayBuffer", "DataView", ...TYPED_ARRAY_NAMES,
]);

// Captured once, so a later patch of a prototype cannot change what the
// checks below do.
const _apply = Reflect.apply;
const _objectToString = Object.prototype.toString;
const _isView = ArrayBuffer.isView;

function _getter(proto: object, key: PropertyKey): (...args: never[]) => unknown {
  return Object.getOwnPropertyDescriptor(proto, key)!.get!;
}

/** `%TypedArray%.prototype[Symbol.toStringTag]`: a typed array's name, `undefined` for anything else (a `DataView` …). */
const _typedArrayName = _getter(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag);

/**
 * Brand checks: each throws a `TypeError` unless its receiver has that
 * built-in's internal slot (`[[MapData]]`, `[[DateValue]]`,
 * `[[StringData]]` …), and runs none of the receiver's own code — no
 * getter, no Proxy trap (a Proxy has no such slot, whatever it wraps) — so
 * they hold for an object from another realm and cannot be talked out of
 * the answer. Typed arrays and `DataView` are told by `ArrayBuffer.isView`
 * instead, and named by `[[TypedArrayName]]`. Not here: `Error` and `Promise`, which have no brand check that
 * runs nothing (bar ES2026's `Error.isError`), and `SharedArrayBuffer`,
 * which is not a global in a browser page that is not cross-origin
 * isolated — `Object.prototype.toString` names those three.
 */
const BRAND_CHECKS: ReadonlyArray<readonly [string, (...args: never[]) => unknown]> = [
  ["Map", Map.prototype.has],
  ["Set", Set.prototype.has],
  ["WeakMap", WeakMap.prototype.has],
  ["WeakSet", WeakSet.prototype.has],
  ["Date", Date.prototype.getTime],
  ["RegExp", _getter(RegExp.prototype, "source")],
  ["String", String.prototype.valueOf],
  ["Number", Number.prototype.valueOf],
  ["Boolean", Boolean.prototype.valueOf],
  ["Symbol", Symbol.prototype.valueOf],
  ["BigInt", BigInt.prototype.valueOf],
  ["ArrayBuffer", _getter(ArrayBuffer.prototype, "byteLength")],
];

/**
 * Which of {@link NOT_FLAG_MAPS} the top-level `v` is, or says it is;
 * `undefined` for any other object — a plain object of any prototype
 * (`null` included) and of any realm, a class instance, a Proxy of either.
 * Never throws for what `v` does.
 *
 * `Object.prototype.toString` decides first, and is all a plain map — the
 * common case — costs. It names `Date` / `RegExp` / `Error` and the boxed
 * primitives by their internal slots, the others by the
 * `Symbol.toStringTag` they inherit, so it holds across realms too. A
 * value that says it is one of them is taken at its word: a Proxy of a
 * `Map` (which forwards the `Map` tag) is rejected as a `Map`, though only
 * its target has the slot. Reading the tag runs `v`'s own code (an
 * inherited getter, a Proxy `get` trap); whatever that throws only means
 * the tag tells nothing.
 *
 * When the tag names something else — a built-in subclass with a tag of
 * its own (`class FlagStore extends Map` calling itself `"FlagStore"`), a
 * class instance with one, a tag that could not be read — the
 * {@link BRAND_CHECKS} decide. A tag of `"Object"` is believed without
 * them: a built-in hidden that way (re-parented onto `Object.prototype`,
 * its tag redefined as `"Object"`) is cloned as an object, because a brand
 * check that fails throws, and every plain map would pay a dozen
 * exceptions per publish for it.
 */
function _builtInName(v: object): string | undefined {
  let name = "";
  try {
    // "[object Map]" → "Map".
    name = (_apply(_objectToString, v, []) as string).slice(8, -1);
  } catch {
    // A tag getter or a Proxy `get` trap threw: the brand checks decide.
  }
  if (name === "Object") return undefined;
  if (NOT_FLAG_MAPS.has(name)) return name;
  if (_isView(v)) return (_apply(_typedArrayName, v, []) as string | undefined) ?? "DataView";
  for (const [builtIn, check] of BRAND_CHECKS) {
    try {
      _apply(check, v, []);
      return builtIn;
    } catch (err) {
      // Not this one — unless the check failed some other way than its
      // TypeError (the stack ran out inside it). That is undecided, and is
      // thrown as an error enumerating the map is, rather than the map
      // taken for a plain object and published as `{}`.
      if (!(err instanceof TypeError)) throw err;
    }
  }
  return undefined;
}

/** `"a Map"`, `"an Error"`, `"a String object"`: a {@link NOT_FLAG_MAPS} name, as the not-a-flag-map error names it. */
function _describeBuiltIn(name: string): string {
  return `${"AEIO".includes(name.charAt(0)) ? "an" : "a"} ${name}${BOXED_PRIMITIVES.has(name) ? " object" : ""}`;
}

/**
 * Deepest nesting of objects / arrays a flag map may have, the map itself
 * counting as level 1 — the same count, and the same default, as
 * `@wc-bindable/remote` 0.10's `maxDepth` (`DEFAULT_WIRE_MAX_DEPTH`, not
 * exported by the package): `RemoteShellProxy` validates the whole `flags`
 * value against it before sending, and one value past the limit makes it
 * drop the ENTIRE `flags` update (and list `flags` in `getterFailures` on
 * `sync`) — every flag would vanish from the browser because of one deep
 * value. Dropping just that flag here keeps the rest of the map on the
 * wire. A shell constructed with a smaller `maxDepth` still drops the
 * whole map for a value between its limit and this one.
 */
const MAX_WIRE_DEPTH = 256;

/** Thrown below a top-level entry when a value nests past {@link MAX_WIRE_DEPTH}; caught by that entry. */
const TOO_DEEP: unique symbol = Symbol("too deep");

/** Where a cloned entry sits: its key, under its parent entry (`null` for a top-level flag). */
interface EntryPath {
  readonly parent: EntryPath | null;
  readonly key: string | number;
}

/** A value dropped under §4 (`tooDeep: false`) or §5 of {@link deepCloneAndFreeze}. */
interface DroppedEntry {
  readonly path: EntryPath;
  readonly tooDeep: boolean;
}

/** State of one {@link deepCloneAndFreeze} call. */
interface CloneContext {
  /** The current recursion path, for the cycle guard. */
  readonly seen: WeakSet<object>;
  /** What was dropped under §4 / §5, in order, for {@link _warnDropped}. */
  readonly dropped: DroppedEntry[];
}

/**
 * How many distinct paths {@link _warnDropped} logs per process before it
 * stops. The record of logged paths lives as long as the process, so it is
 * bounded: a provider whose broken keys change on every call (a timestamp
 * in the key, …) would otherwise grow it forever.
 */
const MAX_LOGGED_PATHS = 100;

/** Paths already logged by {@link _warnDropped}, process-wide. */
const _loggedPaths = new Set<string>();

/** Test-only reset of the once-per-path record behind {@link _warnDropped}. */
export function __resetDroppedValueWarnings(): void {
  _loggedPaths.clear();
}

/**
 * Log the values one {@link deepCloneAndFreeze} call dropped as unreadable
 * or too deep: at most one `console.warn`, naming each path not logged
 * before in this process — the path only, never the value or the error its
 * read threw (either may carry flag contents). A path is logged once per
 * process, whichever call (a provider's own clone or the Core's) and
 * whichever identity met it: a value a provider cannot produce is broken
 * the same way on every poll, push and identify, and one line per publish
 * would flood the log. After {@link MAX_LOGGED_PATHS} paths, nothing more
 * is logged, and the warning that reaches the limit says so.
 *
 * Never throws: logging a dropped value must not fail the publish of the
 * rest of the map.
 */
function _warnDropped(dropped: readonly DroppedEntry[]): void {
  try {
    const fresh: string[] = [];
    for (const { path, tooDeep } of dropped) {
      if (_loggedPaths.size >= MAX_LOGGED_PATHS) break;
      const formatted = _formatPath(path);
      if (_loggedPaths.has(formatted)) continue;
      _loggedPaths.add(formatted);
      fresh.push(`${formatted} (${tooDeep ? `nested deeper than ${MAX_WIRE_DEPTH} levels` : "could not be read"})`);
    }
    if (fresh.length === 0) return;
    const last = _loggedPaths.size >= MAX_LOGGED_PATHS
      ? ` ${MAX_LOGGED_PATHS} paths have been logged; further ones will not be.`
      : "";
    console.warn(
      `[@csbc-dev/feature-flags] dropped flag values that cannot be published: ${fresh.join(", ")}. The rest of the flag map is published. (Each path is logged once per process.${last})`,
    );
  } catch {
    // A failed log (a replaced `console.warn` that throws, …) loses only the log line.
  }
}

/** Longest key {@link _formatPath} prints in full, as `@wc-bindable/remote` does. */
const MAX_LOGGED_KEY_LENGTH = 64;

/**
 * `flags.checkout.value[2]` — the notation `@wc-bindable/remote` uses for
 * the paths in its own warnings (identifier keys dotted, others quoted,
 * long keys and long paths shortened), rooted at `flags`.
 */
function _formatPath(path: EntryPath): string {
  const segments: Array<string | number> = [];
  for (let at: EntryPath | null = path; at !== null; at = at.parent) segments.push(at.key);
  segments.reverse();
  if (segments.length > 16) {
    const head = segments.slice(0, 6).map(_formatSegment).join("");
    const tail = segments.slice(-6).map(_formatSegment).join("");
    return `flags${head}…(${segments.length - 12} levels)…${tail}`;
  }
  return `flags${segments.map(_formatSegment).join("")}`;
}

function _formatSegment(segment: string | number): string {
  if (typeof segment === "number") return `[${segment}]`;
  if (segment.length <= MAX_LOGGED_KEY_LENGTH && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `.${segment}`;
  return `[${JSON.stringify(segment.length > MAX_LOGGED_KEY_LENGTH ? `${segment.slice(0, MAX_LOGGED_KEY_LENGTH)}…` : segment)}]`;
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
 * An entry whose value has no JSON form ({@link _cloneEntry} returns
 * `undefined`) is dropped, as `JSON.stringify` drops it. Throws only when
 * `source` itself cannot be enumerated (`Object.keys`); for a nested
 * object that reaches the parent's {@link _cloneEntry}, which drops it.
 *
 * `at` is where `source` sits (`null` for the map itself) and `depth` its
 * nesting level (the map is 1).
 */
function _cloneEntries(
  source: object,
  ctx: CloneContext,
  at: EntryPath | null,
  depth: number,
): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (const k of Object.keys(source)) {
    const value = _cloneEntry(source, k, ctx, at, depth);
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
 * Read `source[key]` and clone it, or `undefined` when it has no JSON form
 * — including when it cannot be read or inspected
 * ({@link deepCloneAndFreeze} §4): whatever the read or the clone of this
 * one entry throws makes it "no JSON form" here, so its siblings are still
 * cloned. A value dropped that way is recorded on `ctx.dropped`, under its
 * path, for the warning. (`source` sits at `parent` — `null` for the map
 * itself — at nesting level `depth`.)
 *
 * Except, below the top level, for a value nested past
 * {@link MAX_WIRE_DEPTH} (§5) and for the stack running out: those keep
 * unwinding to the flag's top-level entry, which drops the whole flag —
 * and records only that, in place of whatever was recorded inside the
 * flag. Absorbing either where it surfaced would keep a truncated value:
 * cut at the limit or, for the stack, wherever the stack happened to end
 * — for a chain thousands of levels deep, far past the remote wire's
 * `maxDepth`, which would then drop the entire `flags` update. At the top
 * level the stack has unwound, and every failure is absorbed.
 *
 * "The stack ran out" is decided by `instanceof RangeError` alone, inside
 * its own `try`: the check runs with (nearly) no stack left, and whatever
 * it throws there must not replace the error being classified —
 * undecided means "keep unwinding". (Testing the message is what went
 * wrong first: V8 compiles a regex on first use and, out of stack,
 * reported that as a `SyntaxError`, which replaced the `RangeError` and
 * was absorbed as an ordinary failure one entry up — leaving a chain
 * ~1,800 levels deep.) So any `RangeError` thrown below a top-level entry
 * — a lazy getter formatting an invalid `Date` too — drops that whole
 * flag, and so does a thrown value `instanceof` cannot inspect (a revoked
 * Proxy). The depth limit is a sentinel compared with `===`, which cannot
 * throw. Since the clone itself now recurses at most
 * {@link MAX_WIRE_DEPTH} levels, the stack runs out only inside a
 * getter's own code, or for a caller already deep in the stack.
 */
function _cloneEntry(
  source: object,
  key: string | number,
  ctx: CloneContext,
  parent: EntryPath | null,
  depth: number,
): FlagValue | undefined {
  const at: EntryPath = { parent, key };
  // What was recorded before this entry; kept if the entry is dropped.
  const mark = ctx.dropped.length;
  try {
    return _cloneValue((source as Record<string | number, unknown>)[key], ctx, at, depth + 1);
  } catch (err) {
    const tooDeep = err === TOO_DEEP;
    if (parent !== null) {
      let unwind = true;
      if (!tooDeep) {
        try {
          unwind = err instanceof RangeError;
        } catch {
          // Not inspectable, or no stack left to inspect it: keep unwinding.
        }
      }
      if (unwind) throw err;
    }
    ctx.dropped.length = mark;
    ctx.dropped.push({ path: at, tooDeep });
    return undefined;
  }
}

/**
 * Clone one value into its frozen JSON form, or `undefined` when it has
 * none (see {@link deepCloneAndFreeze} §3 for the mapping). The caller
 * decides what "none" means: dropped from an object, `null` in an array.
 * Throws when `v` cannot be inspected (§4); the caller's
 * {@link _cloneEntry} turns that into "none". Throws {@link TOO_DEEP} when
 * `v` is an object / array whose nesting level (`depth`) is past
 * {@link MAX_WIRE_DEPTH} (§5). `at` is where `v` sits.
 */
function _cloneValue(v: unknown, ctx: CloneContext, at: EntryPath, depth: number): FlagValue | undefined {
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
  const { seen } = ctx;
  // Cycle guard: a value already on the current recursion path is
  // collapsed to `null` rather than recursed into. `FlagValue` has no
  // legal cycle, so `null` is the closest in-contract sentinel. Checked
  // before the depth: a `null` is not a level, the way the wire counts.
  if (seen.has(v)) return null;
  if (depth > MAX_WIRE_DEPTH) throw TOO_DEEP;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      // Index loop, not `v.map()`: `map` keeps holes (and a subclass's
      // species), neither of which is a JSON array. `length` is read once,
      // as `JSON.stringify` does — a Proxy that reports a longer one on
      // every read would otherwise never let the loop end.
      const length = v.length;
      const arr: FlagValue[] = [];
      for (let i = 0; i < length; i++) {
        const e = _cloneEntry(v, i, ctx, at, depth);
        arr.push(e === undefined ? null : e);
      }
      return Object.freeze(arr) as FlagValue;
    }
    return _cloneEntries(v, ctx, at, depth) as FlagValue;
  } finally {
    // Pop on exit so sibling subtrees that legitimately share a nested
    // object ref still clone normally; only ancestor-of-self cycles
    // are collapsed.
    seen.delete(v);
  }
}
