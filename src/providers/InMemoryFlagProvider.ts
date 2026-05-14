import type { FlagIdentity, FlagMap, FlagProvider, FlagUnsubscribe, FlagValue } from "../types.js";
import { deepCloneAndFreeze } from "../freeze.js";
import { raiseError } from "../raiseError.js";
import { identityKey as _identityKey } from "./_identityKey.js";

/**
 * Simple per-identity flag rule. The first matching entry wins; if no
 * entry matches, the flag's default value is used.
 */
export interface InMemoryFlagRule<T extends FlagValue = FlagValue> {
  /** Flag key. */
  key: string;
  /** Value returned to identities matching `predicate`. */
  value: T;
  /** Match predicate — receives the {@link FlagIdentity}. */
  predicate: (identity: FlagIdentity) => boolean;
}

/**
 * Definition of a single flag known to the in-memory provider.
 */
export interface InMemoryFlagDefinition<T extends FlagValue = FlagValue> {
  key: string;
  /** Value returned when no rule matches. */
  defaultValue: T;
  rules?: InMemoryFlagRule<T>[];
}

export interface InMemoryFlagProviderOptions {
  flags?: InMemoryFlagDefinition[];
}

/**
 * Reference Provider for tests, demos, and local development.
 *
 * Evaluates flag values in-process from a list of {@link InMemoryFlagDefinition}.
 * Changes pushed via {@link setFlag} / {@link setFlags} are delivered to all
 * current subscribers synchronously. Subscribers receive the full
 * evaluated map — never a delta — mirroring the wire contract of the
 * remote-facing `FlagsCore`.
 */
export class InMemoryFlagProvider implements FlagProvider {
  private _flags: Map<string, InMemoryFlagDefinition> = new Map();
  // Subscribers are keyed by the canonical identity key (userId +
  // serialized attrs). Two identities sharing the same userId but
  // differing on attrs are tracked separately — the per-rule
  // predicate may evaluate to different values for them, so they
  // must not share a bucket. Aligned with FlagsmithProvider /
  // UnleashProvider, which use the same `_identityKey`.
  private _subscribers: Map<string, Set<{ identity: FlagIdentity; onChange: (next: FlagMap) => void }>> = new Map();
  private _disposed = false;

  constructor(options: InMemoryFlagProviderOptions = {}) {
    for (const def of options.flags ?? []) {
      this._flags.set(def.key, def);
    }
  }

  async identify(identity: FlagIdentity): Promise<FlagMap> {
    if (this._disposed) raiseError("InMemoryFlagProvider: provider has been disposed.");
    return this._evaluate(identity);
  }

  subscribe(
    identity: FlagIdentity,
    onChange: (next: FlagMap) => void,
    // Accepted solely to match the {@link FlagProvider} interface so
    // `new InMemoryFlagProvider()` can be used directly (not just via
    // the interface type) with all three arguments. Intentionally
    // unused: this provider has no polling baseline to seed —
    // `onChange` is invoked deterministically from `setFlag` /
    // `setFlags`, never from a polling diff.
    _initial?: FlagMap,
  ): FlagUnsubscribe {
    if (this._disposed) {
      raiseError("InMemoryFlagProvider: cannot subscribe on a disposed provider.");
    }
    const key = _identityKey(identity);
    const bucket = this._subscribers.get(key) ?? new Set();
    const entry = { identity, onChange };
    bucket.add(entry);
    this._subscribers.set(key, bucket);
    return () => {
      const current = this._subscribers.get(key);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this._subscribers.delete(key);
    };
  }

  async reload(identity: FlagIdentity): Promise<FlagMap> {
    if (this._disposed) raiseError("InMemoryFlagProvider: provider has been disposed.");
    return this._evaluate(identity);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._subscribers.clear();
    this._flags.clear();
  }

  // --- Test / demo helpers ----------------------------------------------

  /**
   * Replace the value (or default value) of a single flag and notify
   * every subscriber with a freshly evaluated map. After `dispose()`
   * this is an explicit no-op — `dispose()` clears `_flags` and
   * `_subscribers`, so a write here would otherwise either revive
   * the provider (writing into the cleared flag map without any live
   * subscribers) or silently drop the notification by virtue of an
   * empty subscriber set. The explicit guard keeps the post-dispose
   * contract obvious to future readers.
   */
  setFlag<T extends FlagValue>(key: string, defaultValue: T): void {
    if (this._disposed) return;
    const existing = this._flags.get(key);
    if (existing) {
      this._flags.set(key, { ...existing, defaultValue });
    } else {
      this._flags.set(key, { key, defaultValue });
    }
    this._notifyAll();
  }

  /**
   * Replace the full flag set with a new list of definitions and notify
   * every subscriber. After `dispose()` this is an explicit no-op —
   * see {@link setFlag} for the rationale.
   */
  setFlags(flags: InMemoryFlagDefinition[]): void {
    if (this._disposed) return;
    this._flags.clear();
    for (const def of flags) this._flags.set(def.key, def);
    this._notifyAll();
  }

  private _evaluate(identity: FlagIdentity): FlagMap {
    const out: Record<string, FlagValue> = {};
    for (const def of this._flags.values()) {
      let value: FlagValue = def.defaultValue;
      if (def.rules) {
        for (const rule of def.rules) {
          // `predicate` is caller-supplied — a thrown predicate must
          // not break evaluation for the rest of the flag set or
          // (via `_notifyAll`) for sibling subscribers. Skip the
          // rule on throw, surface a console.warn so misbehaving
          // rules stay visible, and fall through to the next rule
          // (or the default value if none match).
          let matched = false;
          try {
            matched = rule.predicate(identity);
          } catch (err) {
            console.warn(
              `[@csbc-dev/feature-flags] InMemoryFlagProvider: rule predicate for "${def.key}" threw and was skipped.`,
              err,
            );
            continue;
          }
          if (matched) {
            value = rule.value;
            break;
          }
        }
      }
      out[def.key] = value;
    }
    // Deep-clone-and-freeze every level to match Flagsmith / Unleash /
    // LaunchDarkly providers: evaluated values here share references
    // with the rule definitions stored in `this._flags`, so a shallow freeze
    // would leak source-of-truth refs to consumers (e.g. arrays or
    // `{ enabled, value }` objects could be mutated through the
    // evaluated map and bleed into the next evaluation). FlagsCore
    // does its own deep-clone as a final guard, but making every
    // Provider emit isolated snapshots keeps the contract symmetric
    // and avoids relying on the Core for safety.
    return deepCloneAndFreeze(out);
  }

  private _notifyAll(): void {
    // Snapshot both the bucket map and each subscriber set before
    // iterating: a synchronous unsubscribe from inside an `onChange`
    // handler can delete an empty bucket from the outer Map (see the
    // unsubscribe closure in `subscribe`), which would otherwise
    // mutate the live Map under the outer for-of cursor.
    for (const bucket of Array.from(this._subscribers.values())) {
      const entries = Array.from(bucket);
      // `bucket` is keyed by the canonical identity key, so every
      // entry in it shares the same `userId` + serialized `attrs`.
      // Rule predicates are a pure function of the `FlagIdentity`
      // content, so they evaluate identically for every entry —
      // evaluate ONCE per bucket and fan the single result out, the
      // same shape FlagsmithProvider (`_pollBucket`) and
      // UnleashProvider (`_onChanged`) already use. The prior
      // per-subscriber `_evaluate` ran the rule set (and a
      // `deepCloneAndFreeze`) N times for an N-subscriber bucket with
      // an identical result each time.
      /* v8 ignore start -- a bucket only exists while it has >=1 subscriber (the unsubscribe closure deletes empty buckets eagerly), so an empty `entries` reaching this line is not reproducible */
      if (entries.length === 0) continue;
      /* v8 ignore stop */
      const next = this._evaluate(entries[0].identity);
      for (const { onChange } of entries) {
        // Isolate each subscriber: a synchronous throw from one
        // onChange must not abort the fan-out to the rest.
        try {
          onChange(next);
        } catch (err) {
          console.warn(
            "[@csbc-dev/feature-flags] InMemoryFlagProvider: a subscriber's onChange threw during fan-out and was isolated.",
            err,
          );
        }
      }
    }
  }
}
