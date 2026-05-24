/**
 * React example for @csbc-dev/feature-flags — via the OFFICIAL adapter.
 *
 * Unlike a hand-rolled `bind()` hook, this uses `useWcBindable` from
 * `@wc-bindable/react`. That adapter is ELEMENT-based: it binds the bindable
 * surface of a real `<feature-flags>` Shell element (attached through a ref)
 * into React state. So this example renders the Shell plus a `<demo-session>`
 * transport (the stand-in for `<auth0-session>`) — the same elements the
 * vanilla and wcstack-state examples drive — and lets the adapter do the
 * subscribe/replay/cleanup that the old custom hook did by hand.
 *
 *   <demo-session>  opens the socket, exposes `.proxy` / `.ready`
 *        ↓ (auth0-session:ready-changed)
 *   <feature-flags> subscribes to the proxy, re-dispatches the flag surface
 *        ↓ (useWcBindable → bind)
 *   App            renders the bound `values`
 *
 * Both elements are registered in `main.tsx` before React mounts.
 */
import { useCallback, useRef } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { Flags, FlagsValues, FlagValue } from "@csbc-dev/feature-flags";

/** Render a single flag value (wrapped `{ enabled, value }` or raw). */
function FlagRow({ name, value }: { name: string; value: FlagValue }) {
  const wrapped =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { enabled?: boolean; value?: FlagValue })
      : null;
  const enabled = wrapped ? wrapped.enabled === true : Boolean(value);

  return (
    <tr>
      <td><code>{name}</code></td>
      <td>
        <span className={enabled ? "badge on" : "badge off"}>
          {enabled ? "ON" : "OFF"}
        </span>
      </td>
      <td><code>{JSON.stringify(value)}</code></td>
    </tr>
  );
}

// Initial values so the first render is clean (before the first server
// snapshot). The adapter merges each `feature-flags:*-changed` push on top.
const INITIAL: FlagsValues = { flags: {}, identified: false, loading: false, error: null };

export default function App() {
  // `useWcBindable` returns a callback ref to attach to the element + the live
  // bound `values` (flags / identified / loading / error). Commands are NOT
  // part of the bound surface, so we keep our own ref to the element to call
  // its `identify()` / `reload()` methods, and compose it with the adapter's
  // ref in one callback.
  const [bindRef, values] = useWcBindable<Flags, FlagsValues>(INITIAL);
  const elRef = useRef<Flags | null>(null);
  const ref = useCallback(
    (node: Flags | null) => {
      elRef.current = node;
      bindRef(node);
    },
    [bindRef],
  );

  const { flags, identified, loading, error } = values;
  const entries = Object.entries(flags);

  // identify()/reload() on the Shell delegate to the session proxy and reject
  // if called before the session is ready, so guard with a catch.
  const identify = (userId: string) =>
    void elRef.current?.identify(userId).catch((e) => console.warn(e));
  const reload = () => void elRef.current?.reload().catch((e) => console.warn(e));

  return (
    <main>
      <h1>@csbc-dev/feature-flags — React</h1>
      <p className="hint">
        Flags evaluated server-side, observed through the <code>&lt;feature-flags&gt;</code>
        Shell with <code>useWcBindable</code> (the <code>@wc-bindable/react</code> adapter).
        Re-identify to watch targeting rules change <code>new_checkout_flow</code>,
        <code> dark_mode</code> and <code>cta_text</code>. <code>beta_banner</code> is
        flipped by the server every few seconds — a live push update.
      </p>

      {/*
        Transport + Shell — both headless (display:none), they render nothing.
        `<feature-flags target="flags-session">` resolves `<demo-session>` by id
        and subscribes to its RemoteCoreProxy; `ref` binds it via useWcBindable.
      */}
      <demo-session id="flags-session"></demo-session>
      <feature-flags ref={ref} id="flags" target="flags-session"></feature-flags>

      <div className="status">
        <span>identified: <b>{String(identified)}</b></span>
        <span>loading: <b>{String(loading)}</b></span>
        <span className={error ? "err" : ""}>error: <b>{error ? error.message : "none"}</b></span>
      </div>

      <div className="controls">
        <button onClick={() => identify("alice")}>identify("alice")</button>
        <button onClick={() => identify("bob")}>identify("bob")</button>
        <button onClick={() => identify("guest")}>identify("guest")</button>
        <button onClick={() => reload()}>reload()</button>
      </div>

      {entries.length === 0 ? (
        <p className="hint">Waiting for the first flag snapshot…</p>
      ) : (
        <table>
          <thead>
            <tr><th>flag</th><th>state</th><th>raw value</th></tr>
          </thead>
          <tbody>
            {entries.map(([name, value]) => (
              <FlagRow key={name} name={name} value={value} />
            ))}
          </tbody>
        </table>
      )}

      {/* Example of conditional rendering driven by a single flag. */}
      {(() => {
        const flag = flags.new_checkout_flow as { enabled?: boolean } | undefined;
        return flag?.enabled ? (
          <p className="callout">🎉 New checkout flow is enabled for this identity.</p>
        ) : null;
      })()}
    </main>
  );
}
