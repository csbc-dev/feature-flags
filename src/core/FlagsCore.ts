import { raiseError } from "../raiseError.js";
import { deepCloneAndFreeze } from "../freeze.js";
import { EMPTY_FLAGS, FLAGS_WC_BINDABLE } from "../wcBindable.js";
import type {
  FlagIdentity,
  FlagMap,
  FlagProvider,
  FlagsCoreOptions,
  FlagsErrorInfo,
  FlagUnsubscribe,
  IWcBindable,
  UserContextLike,
} from "../types.js";

/**
 * Server-side feature flag Core.
 *
 * Runs in any JavaScript runtime (Node, Deno, Bun, Cloudflare Workers).
 * Talks to the underlying flag service through a pluggable
 * {@link FlagProvider}. Exposes a minimal bindable surface whose only
 * observable property is the full flag map — individual flags are
 * addressed through dotted-path access (`values.flags.<key>`).
 *
 * Lifecycle:
 *
 * 1. Construction captures the provider and optional `userContext`.
 *    No network I/O is performed.
 * 2. If `userContext` is present, `_autoIdentify()` fires on first
 *    public method call (or can be explicitly awaited via
 *    `ensureIdentified()`). This avoids doing work in the constructor
 *    — which runs on the server before the transport is even open —
 *    while still letting the client-side session light up `ready` with
 *    a real flag map in the initial sync batch.
 * 3. `identify()` / `reload()` publish a new `flags` snapshot on
 *    completion. Provider-push updates flow through `subscribe` and
 *    publish the same way.
 */
export class FlagsCore extends EventTarget {
  // Shared with `<feature-flags>` (the Shell) — see `wcBindable.ts`.
  // The Core and Shell are two ends of one protocol; defining the
  // descriptor in one place prevents silent drift.
  static wcBindable: IWcBindable = FLAGS_WC_BINDABLE;

  private _target: EventTarget;
  private _provider: FlagProvider;
  private _userContext: UserContextLike | null;

  private _flags: FlagMap = EMPTY_FLAGS;
  private _identified = false;
  private _loading = false;
  private _error: FlagsErrorInfo | null = null;
  // The exception behind `_error`, before `_toErrorInfo` reduced it for
  // the wire: the provider's own `Error` (class, `stack`, `cause`, extra
  // fields), or the `Error` `_toError` built for a non-`Error` throw.
  // In-process only — see `originalError`. Written only by `_setError`,
  // so it is `null` exactly when `_error` is.
  private _errorSource: Error | null = null;

  private _currentIdentity: FlagIdentity | null = null;
  private _unsubscribeProvider: FlagUnsubscribe | null = null;
  private _disposed = false;

  // Monotonic counter bumped on every identity transition or dispose.
  // Guards async results from superseded identify() / reload() calls
  // against overwriting state owned by a newer identity.
  private _generation = 0;

  // Coalesce auto-identify: multiple concurrent callers (e.g. initial
  // sync + explicit reload() from the client) must observe the same
  // in-flight promise, not race parallel provider calls.
  private _autoIdentifyPromise: Promise<void> | null = null;

  // Tracks any in-flight provider call (identify / reload) so dispose()
  // can await their settlement before tearing the provider down. A
  // single-slot field would lose track of a prior call when a newer
  // identify() overwrites it, leaving the original promise un-awaited
  // by dispose() and re-opening the late-provider-call race.
  private _inFlight: Set<Promise<unknown>> = new Set();

  constructor(options: FlagsCoreOptions) {
    super();
    if (!options || !options.provider) {
      raiseError("FlagsCore: `provider` is required.");
    }
    this._target = options.target ?? this;
    this._provider = options.provider;
    this._userContext = options.userContext ?? null;
  }

  // --- Bindable properties --------------------------------------------------

  /**
   * Current flag map. Frozen snapshot; never mutated in place. A change
   * yields a new object reference so reactive frameworks that rely on
   * reference equality detect the update honestly.
   */
  get flags(): FlagMap {
    return this._flags;
  }

  get identified(): boolean {
    return this._identified;
  }

  get loading(): boolean {
    return this._loading;
  }

  /**
   * Last provider failure, or `null`. A frozen, JSON-safe
   * {@link FlagsErrorInfo} — not an `Error` instance — because this
   * property crosses the remote wire; see `_toErrorInfo`.
   * `<feature-flags>` re-hydrates it into an `Error` on the browser side.
   * Server code that needs the exception itself reads `originalError`.
   */
  get error(): FlagsErrorInfo | null {
    return this._error;
  }

  /**
   * The exception behind `error`, as the Core caught it — for server-side
   * logging and monitoring. It is the provider's own `Error` instance, with
   * its class, `stack`, `cause` and any extra fields intact; for a failure
   * that was not an `Error` (a provider that throws a string, …), it is an
   * `Error` with the same `name` / `message` that `error` describes
   * (`"Error"` / `String(thrown)`, or `"unserializable error value"` when
   * `String(thrown)` itself throws — see `_toError`). A provider `Error`
   * whose `name` / `message` cannot be read as strings is still kept here
   * as-is, while `error` falls back to that fixed text (see
   * `_toErrorInfo`). `null` exactly when `error` is `null`.
   *
   * It is set before the Core dispatches `feature-flags:error`, so a
   * listener on the Core (or on the `target` it was constructed with) can
   * read it:
   *
   * ```ts
   * core.addEventListener("feature-flags:error", () => {
   *   if (core.originalError) log.error(core.originalError);
   * });
   * ```
   *
   * This is the only way to see it in a remote setup: provider failures
   * (`identify` / `subscribe` / `reload`) are published on `error`, not
   * thrown, and `error` itself carries only `{ name, message, code? }`.
   * Precondition violations (missing `userId`, use after `dispose`) throw
   * without touching `error` and do not appear here; nor does the failure
   * of a superseded identify / reload, which is discarded.
   *
   * Deliberately NOT a declared `wcBindable` property (and must never
   * become one): `RemoteShellProxy` reads, forwards and accepts only the
   * declared names, so this value never reaches a `sync`, an `update` or a
   * command reply, and the browser keeps receiving the plain
   * {@link FlagsErrorInfo}. Returned as-is, not copied — it is the
   * exception object itself.
   */
  get originalError(): Error | null {
    return this._errorSource;
  }

  // --- Commands -------------------------------------------------------------

  /**
   * Identify the caller and load the initial flag snapshot.
   *
   * Replaces any prior identity. If the provider supports push updates,
   * this also registers the subscription; an earlier subscription is
   * unwound first.
   */
  async identify(userId: string, attrs?: Record<string, unknown>): Promise<void> {
    if (this._disposed) raiseError("FlagsCore: instance has been disposed.");
    if (!userId) raiseError("FlagsCore.identify: `userId` is required.");

    this._autoIdentifyPromise = null;

    const identity: FlagIdentity = {
      userId,
      attrs: attrs ? { ...attrs } : undefined,
    };
    await this._doIdentify(identity);
  }

  /**
   * Reload the current identity's flag snapshot, bypassing any
   * provider-side cache. No-op if the Core has never been identified.
   */
  async reload(): Promise<void> {
    if (this._disposed) raiseError("FlagsCore: instance has been disposed.");

    // Branch order matters: `_currentIdentity` is the authoritative
    // record of "what identity are we currently trying to run for".
    // It is set at the start of every `identify()` / `updateUserContext()`
    // cycle and is preserved across a failed `_doIdentify` so that
    // reload() can retry the same identity. If we checked
    // `_userContext` first, an explicit `identify("bob")` that failed
    // would silently roll back to the `_userContext`-derived identity
    // (e.g. alice) on the next reload, contradicting the "retry the
    // identity we were just trying" contract.
    const identity = this._currentIdentity;

    if (identity) {
      if (!this._identified) {
        // Current identity has no committed flag map yet (typically
        // an earlier identify() threw partway through). Re-run
        // identify rather than a cache-bypass fetch — reload must
        // not publish flags for an un-committed identity.
        await this._doIdentify(identity);
        return;
      }

      // Normal case: identify was committed, run a cache-bypass
      // fetch for the same identity.
      //
      // NOTE on ordering: reload() deliberately does NOT bump
      // `_generation`. It runs *for the current identity*, not a new
      // one — bumping the generation would silently invalidate the
      // live `subscribe()` callback installed by `_doIdentify` (which
      // captured the pre-reload generation), permanently muting push
      // updates for an identity that was never replaced. So a
      // provider-push that interleaves with an in-flight reload()
      // shares this generation and is NOT dropped. The two can race
      // on `_publishFlags` order, but this is intentionally tolerated:
      // both `reload()` and the subscribe push evaluate against the
      // SAME provider-side cache, so whichever lands last differs from
      // the other by at most one upstream tick, and the next push (or
      // an explicit reload) reconverges. The generation guard's job is
      // to fence *superseded identities*, not to serialize two
      // refreshes of the same one — that ordering is left to the
      // provider's own cache coherence.
      const myGen = this._generation;
      this._setError(null);
      this._setLoading(true);
      // Wrap the provider call itself in the try so a synchronous
      // throw from `provider.reload(identity)` is caught by the same
      // path as an async rejection. Without this, a sync-throwing
      // provider would bypass `finally` and leave `loading=true`.
      // `_publishFlags` stays inside it too: a map it rejects (not an
      // object of flags, or one it cannot enumerate) is a failed reload,
      // published on `error` with the committed map kept.
      let reloadPromise: Promise<FlagMap> | null = null;
      try {
        reloadPromise = this._provider.reload(identity);
        this._inFlight.add(reloadPromise);
        const next = await reloadPromise;
        if (this._generation !== myGen) return;
        this._publishFlags(next);
      } catch (err) {
        if (this._generation !== myGen) return;
        this._setError(_toError(err));
      } finally {
        if (reloadPromise) this._inFlight.delete(reloadPromise);
        if (this._generation === myGen) this._setLoading(false);
      }
      return;
    }

    // No `_currentIdentity` — no identify() has ever been called,
    // successful or otherwise. If a `userContext` is armed, auto-
    // identify with it now; otherwise this is a silent no-op
    // (matches the "errors do not throw" contract — callers that
    // need a hard failure can gate on `identified`).
    if (this._userContext) {
      await this.ensureIdentified();
    }
  }

  /**
   * Trigger auto-identify (if armed) and wait for the first snapshot.
   *
   * Called internally by `reload()` when no identity is set yet, and
   * exposed publicly so the remote session can force the Core to
   * produce a non-empty initial sync. Safe to call concurrently — all
   * callers share the same in-flight promise.
   */
  async ensureIdentified(): Promise<void> {
    if (this._disposed) return;
    if (this._identified || !this._userContext) return;
    if (this._autoIdentifyPromise) return this._autoIdentifyPromise;
    this._autoIdentifyPromise = this._autoIdentify();
    try {
      await this._autoIdentifyPromise;
    } finally {
      this._autoIdentifyPromise = null;
    }
  }

  /**
   * Propagate a refreshed `UserContext`. Re-identifies if `sub` or any
   * targeting-relevant trait has changed, otherwise no-ops.
   *
   * NOT part of the `wcBindable` surface: this is a server-side host
   * API, not a client-invokable command. The canonical caller is
   * `@csbc-dev/auth0`'s `onTokenRefresh` hook — see the README
   * composition examples (`onTokenRefresh: (core, user) =>
   * (core as FlagsCore).updateUserContext(user)`). The auth gate owns
   * the token lifecycle and pushes refreshed claims here; exposing it
   * over `wcBindable` would let the (untrusted) browser drive identity,
   * which is exactly the leak Case B2 is designed to prevent.
   */
  async updateUserContext(user: UserContextLike): Promise<void> {
    if (this._disposed) return;
    const prev = this._userContext;
    this._userContext = user;

    // Decide if traits that feed targeting have actually changed.
    // A change in `raw` alone (non-RBAC claims) doesn't warrant a
    // re-identify — the provider's attrs surface only carries the
    // structured RBAC / profile fields.
    //
    // Compare against `_currentIdentity` as well: a manual
    // `identify("bob")` overrides the userContext-derived identity
    // without touching `_userContext`, so a subsequent token-refresh
    // for the original user (alice) would otherwise match `prev`
    // exactly and no-op, leaving the Core wedged on bob's flag map
    // while the live session is back to alice. Forcing a re-identify
    // when `_currentIdentity` has drifted from `user.sub` keeps
    // `_currentIdentity` and `_userContext` in sync after a refresh.
    if (
      prev &&
      this._currentIdentity?.userId === user.sub &&
      prev.sub === user.sub &&
      prev.email === user.email &&
      prev.name === user.name &&
      _sameStringSet(prev.permissions ?? [], user.permissions ?? []) &&
      _sameStringSet(prev.roles ?? [], user.roles ?? []) &&
      prev.orgId === user.orgId
    ) {
      return;
    }

    // Clear any armed auto-identify promise before running the
    // re-identify — mirrors `identify()`. If an `_autoIdentify` is
    // still in-flight when a token refresh lands here, leaving
    // `_autoIdentifyPromise` set would let a concurrent
    // `ensureIdentified()` early-return on that stale promise (which
    // resolves against the PRE-refresh userContext) while this call is
    // already committing `_doIdentify` for the refreshed identity.
    // Clearing it forces any later `ensureIdentified()` to observe the
    // `_identified` flag this call's `_doIdentify` sets and no-op
    // correctly. The in-flight `_autoIdentify` itself is still fenced
    // by the generation guard bumped inside `_doIdentify`, so its
    // result cannot overwrite the refreshed identity's state.
    this._autoIdentifyPromise = null;

    const identity = _buildIdentity(user);
    await this._doIdentify(identity);
  }

  /**
   * Release provider resources and tear down subscriptions. After
   * dispose, `identify()` / `reload()` throw synchronously; `flags`
   * retains its last value so an already-bound client does not see its
   * state wiped.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._generation++;
    this._autoIdentifyPromise = null;

    // Wait for every in-flight provider call (identify / reload) to
    // settle before tearing the provider down — otherwise a late
    // provider call would land on an already-disposed Provider.
    // `allSettled` so a rejection in any one in-flight does not
    // short-circuit the wait on the others. Generation guards already
    // prevent state corruption; this prevents the misordered call
    // into the SDK.
    if (this._inFlight.size > 0) {
      await Promise.allSettled([...this._inFlight]);
    }
    this._inFlight.clear();

    if (this._unsubscribeProvider) {
      try {
        this._unsubscribeProvider();
      } catch {
        // Subscriber cleanup errors are non-fatal.
      }
      this._unsubscribeProvider = null;
    }

    if (this._provider.dispose) {
      try {
        await this._provider.dispose();
      } catch {
        // Provider dispose errors are non-fatal.
      }
    }
  }

  // --- Private --------------------------------------------------------------

  private async _autoIdentify(): Promise<void> {
    /* v8 ignore start -- ensureIdentified gates on _userContext before calling this; defensive inner guard */
    if (!this._userContext) return;
    /* v8 ignore stop */
    const identity = _buildIdentity(this._userContext);
    await this._doIdentify(identity);
  }

  private async _doIdentify(identity: FlagIdentity): Promise<void> {
    // Bump generation BEFORE starting new work so any still-running
    // prior identify() observes a mismatched generation on resume.
    this._generation++;
    const myGen = this._generation;

    // Tear down the previous subscription immediately. A provider that
    // keeps open SSE / polling per-identity would otherwise leak one
    // subscription per identify() call.
    if (this._unsubscribeProvider) {
      try {
        this._unsubscribeProvider();
      } catch {
        // ignore
      }
      this._unsubscribeProvider = null;
    }

    this._currentIdentity = identity;
    this._setError(null);
    this._setLoading(true);

    let initial: FlagMap;
    // Wrap the provider call itself in the try so a synchronous
    // throw from `provider.identify(identity)` is caught here rather
    // than escaping `_doIdentify` with `loading=true` left on. The
    // publish of its result belongs in the try as well, as in
    // `reload()`: `_publishFlags` throws when the map is not an object of
    // flags or cannot be enumerated at all (see `deepCloneAndFreeze`),
    // and outside the try that rejected `identify()` with `loading=true`
    // and `error` unset.
    let identifyPromise: Promise<FlagMap> | null = null;
    try {
      identifyPromise = this._provider.identify(identity);
      this._inFlight.add(identifyPromise);
      initial = await identifyPromise;
      if (this._generation !== myGen) return;
      this._publishFlags(initial);
    } catch (err) {
      if (this._generation !== myGen) return;
      // The identify cycle for `identity` did NOT commit a flag map.
      // We already tore down the previous identity's subscription and
      // reassigned `_currentIdentity`, so the *old* `_flags` no longer
      // corresponds to `_currentIdentity`. Leaving them in place would
      // violate the invariant "`identified === true` ⇒ `flags` reflect
      // `_currentIdentity`" and — crucially — a subsequent `reload()`
      // would then fetch for the new identity and silently flip the
      // flag map without a matching identify cycle, which is the bug
      // surfaced by the design review (alice → bob identify fails →
      // UI keeps showing alice's flags → reload() hands over bob's).
      //
      // Reset the bindable surface so consumers see: `flags === {}`,
      // `identified === false`, `error` describing `err`. `_currentIdentity`
      // stays set to the failed target so `reload()` can retry it
      // via `_doIdentify` (see `reload()`).
      //
      // A map the provider resolved but `_publishFlags` could not read
      // lands here too, before it changed any state: nothing was
      // committed for `identity`, exactly as if the provider had
      // rejected — so the same reset, and no subscription.
      this._publishFlags(EMPTY_FLAGS);
      this._setIdentified(false);
      this._setError(_toError(err));
      this._setLoading(false);
      return;
    } finally {
      // Drop the in-flight handle on both the success and failure
      // paths from one place — mirrors `reload()`'s `finally`-based
      // cleanup. `identifyPromise` is non-null whenever the provider
      // call was actually issued; a synchronous throw from
      // `_provider.identify` before assignment leaves it null and the
      // guard skips the no-op `delete(null)`.
      if (identifyPromise) this._inFlight.delete(identifyPromise);
    }

    this._setIdentified(true);
    this._setLoading(false);

    // Subscribe AFTER publishing the initial snapshot so there is a
    // well-defined ordering: consumers see `identified=true` with a
    // flag map that is guaranteed to be at least as fresh as the
    // subscribe-time snapshot. We pass `initial` as the third argument
    // so the Provider can use it as its change-detection baseline and
    // stay silent when its first internal tick returns the same data
    // the client already has.
    try {
      this._unsubscribeProvider = this._provider.subscribe(identity, (next) => {
        if (this._generation !== myGen) return;
        // A pushed map that is not an object of flags or cannot be
        // enumerated is a provider failure like a `subscribe` throw:
        // published on `error`, with the last committed map kept. Thrown,
        // it would only reach the provider's fan-out, which isolates and
        // logs it — the update lost and nothing on `error`.
        try {
          this._publishFlags(next);
        } catch (err) {
          // A trap inside `next` may have re-identified before throwing;
          // the failure then belongs to the superseded identity.
          if (this._generation !== myGen) return;
          this._setError(_toError(err));
        }
      }, initial);
    } catch (err) {
      // Subscription failure is non-fatal: the initial snapshot is
      // already installed; we surface the error and let the client
      // rely on explicit `reload()` for subsequent updates.
      /* v8 ignore start -- sync subscribe throw between an already-awaited identify and its own line cannot observe a concurrent gen bump */
      if (this._generation !== myGen) return;
      /* v8 ignore stop */
      this._setError(_toError(err));
    }
  }

  /**
   * Publish a provider's map as the new `flags` snapshot. Throws — before
   * touching any state — when `next` is not an object of flags (a string,
   * an array, `null`, a built-in such as a `Map` / `Date` / `Promise`, …)
   * or cannot be enumerated at all (see
   * `deepCloneAndFreeze`; an entry that merely cannot be read, or that
   * nests deeper than the remote wire carries, is dropped — and logged —
   * there instead). Every caller with a provider's map runs this inside
   * the `try` of the identify / reload / push that delivered it, so that
   * throw is published on `error` as that operation's failure.
   */
  private _publishFlags(next: FlagMap): void {
    // Deep-clone-and-freeze every level. A shallow freeze would leave
    // object-shaped flag values (`{ enabled, value }` / JSON flags)
    // mutable to consumers and would share references back into the
    // Provider's rule definitions — violating the "Frozen snapshot;
    // never mutated in place" contract on `flags` and risking source
    // contamination from consumer-side writes. See `freeze.ts`.
    const snapshot = deepCloneAndFreeze(next);
    this._flags = snapshot;
    this._target.dispatchEvent(new CustomEvent("feature-flags:flags-changed", {
      detail: snapshot,
      bubbles: true,
    }));
  }

  private _setIdentified(value: boolean): void {
    if (this._identified === value) return;
    this._identified = value;
    this._target.dispatchEvent(new CustomEvent("feature-flags:identified-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setLoading(value: boolean): void {
    if (this._loading === value) return;
    this._loading = value;
    this._target.dispatchEvent(new CustomEvent("feature-flags:loading-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  /**
   * The one writer of `error` and `originalError`. Takes the failure
   * already normalized to an `Error` by `_toError` (or `null` to clear),
   * keeps it as `originalError`, and publishes its `_toErrorInfo`
   * reduction as `error`. Never pass a raw caught value: `null` here means
   * "clear", so a provider that throws `null` must go through `_toError`
   * (which turns it into `Error("null")`) like any other failure.
   */
  private _setError(source: Error | null): void {
    // Dedupe only the null → null case. A non-null error is always
    // re-dispatched — a successive distinct failure must stay
    // observable even when it happens to === the previous by
    // reference (pathological, but test frameworks do assert on it).
    if (source === null && this._error === null) return;
    // Both slots are written together (the reduction first, so they cannot
    // part ways) and before the dispatch, so a listener on the Core reads
    // the `originalError` that goes with this event's `detail`.
    const info = source === null ? null : _toErrorInfo(source);
    this._errorSource = source;
    this._error = info;
    this._target.dispatchEvent(new CustomEvent("feature-flags:error", {
      detail: this._error,
      bubbles: true,
    }));
  }
}

/**
 * Message of the `Error` that stands in for a failure the Core cannot
 * describe — a thrown value `String()` rejects (see `_toError`), or an
 * `Error` whose `name` / `message` cannot be read as strings (see
 * `_toErrorInfo`). The same text `@csbc-dev/ami-voice` uses for its own
 * hostile-value fallback.
 */
const UNSERIALIZABLE_ERROR_MESSAGE = "unserializable error value";

/**
 * Normalize a caught provider failure to the `Error` kept as
 * `originalError` (and reduced by `_toErrorInfo` for `error`).
 *
 * An `Error` is returned as the same instance — class, `stack`, `cause`
 * and extra fields untouched. Anything else becomes
 * `new Error(String(err))`: name `"Error"`, message the string form —
 * the reading `error` has always given a non-`Error` throw. `String(err)`
 * is passed explicitly so that `throw undefined` still reads `"undefined"`
 * (`new Error(undefined)` would leave the message empty). As in
 * `@csbc-dev/s3-uploader`'s `toError`, the thrown value is not attached
 * as `cause`. (Unlike it, a plain object with a `message` is not mined
 * for `name` / `message`: `error` has always read it as
 * `String(err)`, and the two must describe the same failure.)
 *
 * Never throws: it runs inside the Core's `catch` blocks, and a throw
 * there would escape the "publish to `error`, never reject" path with
 * `error` unset (and, in `identify`, `loading` stuck at `true`). A value
 * `String()` rejects — `Object.create(null)`, a throwing `toString` /
 * `Symbol.toPrimitive`, an object that converts to a symbol — or one
 * `instanceof` cannot inspect (a revoked `Proxy`) becomes
 * `new Error("unserializable error value")`. (A bare symbol is fine:
 * `String(Symbol("x"))` is `"Symbol(x)"`.)
 */
function _toError(err: unknown): Error {
  try {
    return err instanceof Error ? err : new Error(String(err));
  } catch {
    return new Error(UNSERIALIZABLE_ERROR_MESSAGE);
  }
}

/**
 * Reduce a caught provider failure (normalized by `_toError`) to the
 * JSON-safe {@link FlagsErrorInfo} published on `error` (both the getter
 * and the event `detail`).
 *
 * Why not publish the `Error` itself: `error` is a bindable property,
 * and `@wc-bindable/remote` (0.10+) only carries JSON values. An `Error`
 * instance is not one, so the remote shell would drop every `update` for
 * it and list it in `getterFailures` on `sync` (which reads `core.error`
 * directly — a declaration `getter` could not fix that, and the
 * declaration is shared with the Shell anyway). The browser would see the
 * flag map reset to `{}` with `error` still `null`, silently breaking the
 * "bind the error state" contract. (Before 0.10 the wire coerced it
 * through `JSON.stringify` to `{}`, which lost the message instead.)
 *
 * Kept: `name`, `message`, and a string `code` — the fields
 * `<feature-flags>` restores on its side. `stack`, `cause` and any other
 * field stay in-process on `originalError`. A non-`Error` throw arrives
 * here already as `_toError`'s `new Error(String(err))`, so it reads
 * name `"Error"`, message the string form, no `code`.
 *
 * Never throws, for the same reason as `_toError` (it runs inside
 * `_setError`, called from the Core's `catch` blocks). A provider's own
 * `Error` can still carry a `name` / `message` that `String()` rejects,
 * or a `name` / `message` / `code` getter that throws; such an error is
 * published as `{ name: "Error", message: "unserializable error value" }`
 * while `originalError` keeps the instance itself.
 */
function _toErrorInfo(err: Error): FlagsErrorInfo {
  let info: { name: string; message: string; code?: string };
  try {
    info = { name: String(err.name), message: String(err.message) };
    // Only a string `code` is kept (omitted otherwise, never `undefined`):
    // that is the discriminator shape Node system errors use, and the one
    // the remote error envelope forwards.
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") info.code = code;
  } catch {
    info = { name: "Error", message: UNSERIALIZABLE_ERROR_MESSAGE };
  }
  return Object.freeze(info);
}

/**
 * Flatten a auth0-gate `UserContext` into a {@link FlagIdentity} using
 * a Flagsmith-friendly trait shape:
 *
 *   userId → `sub`
 *   attrs  → { email, name, org_id, permissions, roles }
 *
 * Trait names match Flagsmith's documented convention (lowercase
 * snake-ish), and permission/role arrays are canonicalized by sorting
 * — Auth0 token refreshes do NOT guarantee stable claim ordering, and
 * these fields are semantically sets (membership matters, order does
 * not). Leaving the incoming order in place would let a reorder-only
 * refresh flip the Flagsmith identity key (which hashes `attrs` as-is
 * in its serialized form), tearing down and recreating the poller for
 * the same logical identity.
 *
 * Undefined fields are dropped so targeting rules can distinguish
 * "trait absent" from "trait present but empty".
 */
function _buildIdentity(user: UserContextLike): FlagIdentity {
  const attrs: Record<string, unknown> = {};
  if (user.email !== undefined) attrs.email = user.email;
  if (user.name !== undefined) attrs.name = user.name;
  if (user.orgId !== undefined) attrs.org_id = user.orgId;
  if (user.permissions !== undefined) attrs.permissions = _canonicalArray(user.permissions);
  if (user.roles !== undefined) attrs.roles = _canonicalArray(user.roles);
  return {
    userId: user.sub,
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
  };
}

function _canonicalArray(a: readonly string[]): string[] {
  return [...a].sort();
}

/**
 * Set-equality on two string arrays. Used by `updateUserContext` to
 * decide whether an Auth0 token refresh actually changed the user's
 * RBAC membership, ignoring claim ordering that the provider does not
 * guarantee. Identity-contributing arrays are canonicalized elsewhere
 * (see `_buildIdentity`), so keeping comparison-time and identity-
 * construction-time logic aligned here is what makes a pure reorder a
 * true no-op end-to-end.
 */
function _sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const sa = _canonicalArray(a);
  const sb = _canonicalArray(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}
