import { useFeatureFlags } from "./flags";
import type { FlagValue } from "./flags";

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

export default function App() {
  const { flags, identified, loading, error, identify, reload } = useFeatureFlags();
  const entries = Object.entries(flags);

  return (
    <main>
      <h1>@csbc-dev/feature-flags — React</h1>
      <p className="hint">
        Flags evaluated server-side, observed over a <code>RemoteCoreProxy</code>.
        Re-identify to watch targeting rules change <code>new_checkout_flow</code>,
        <code> dark_mode</code> and <code>cta_text</code>. <code>beta_banner</code> is
        flipped by the server every few seconds — a live push update.
      </p>

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
