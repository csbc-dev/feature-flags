/**
 * Vanilla example for @csbc-dev/feature-flags.
 *
 * Unlike the React / Vue examples (which bind the RemoteCoreProxy directly),
 * this one drives the actual <feature-flags> Shell element — the package's
 * primary deliverable — plus a tiny <demo-session> element that supplies the
 * transport in place of <auth0-session>.
 *
 * Pipeline:
 *   <demo-session>  opens the socket, exposes `.proxy` / `.ready`
 *        ↓ (auth0-session:ready-changed)
 *   <feature-flags> subscribes to the proxy, re-dispatches the flag surface
 *        ↓ (bind)
 *   this script    renders the DOM
 */
import { bootstrapFlags } from "@csbc-dev/feature-flags";
import type { Flags, FlagMap, FlagValue } from "@csbc-dev/feature-flags";
import { bind } from "@wc-bindable/core";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
} from "@wc-bindable/remote";

const DEMO_SERVER_URL = "ws://localhost:8787";

// FlagsCore bindable surface, needed to build the RemoteCoreProxy below.
// This example DOES import the browser entry (`@csbc-dev/feature-flags`), but
// the root entry does not re-export the wcBindable declaration —
// `FLAGS_WC_BINDABLE` is an internal const in `src/wcBindable.ts` — so the
// proxy's descriptor has to be declared here. MUST stay identical to
// `FlagsCore.wcBindable`. (The React/Vue copies exist for a different reason:
// avoiding a server-entry import in a framework bundle.)
const FLAGS_DECLARATION: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "flags", event: "feature-flags:flags-changed" },
    { name: "identified", event: "feature-flags:identified-changed" },
    { name: "loading", event: "feature-flags:loading-changed" },
    { name: "error", event: "feature-flags:error" },
  ],
  commands: [
    { name: "identify", async: true },
    { name: "reload", async: true },
  ],
};

/**
 * Minimal stand-in for <auth0-session>. <feature-flags> only needs a target
 * element that structurally exposes `.proxy` (a RemoteCoreProxy) and `.ready`
 * (a boolean), and that fires `auth0-session:ready-changed` when readiness
 * flips. That's the whole contract — so we can satisfy it without Auth0.
 */
class DemoSession extends HTMLElement {
  private _proxy: RemoteCoreProxy | null = null;
  private _ready = false;
  private _ws: WebSocket | null = null;

  get proxy(): RemoteCoreProxy | null {
    return this._proxy;
  }
  get ready(): boolean {
    return this._ready;
  }

  connectedCallback(): void {
    this.style.display = "none";
    const url = this.getAttribute("url") || DEMO_SERVER_URL;
    const ws = new WebSocket(url);
    this._ws = ws;
    const transport = new WebSocketClientTransport(ws);
    // Proxy is created up front; it buffers its `sync` request until the
    // socket opens. We flip `ready` on open so <feature-flags> binds only
    // once the transport is live.
    this._proxy = createRemoteCoreProxy(FLAGS_DECLARATION, transport);
    ws.addEventListener("open", () => this._setReady(true));
    ws.addEventListener("close", () => this._setReady(false));
  }

  disconnectedCallback(): void {
    this._setReady(false);
    this._proxy?.dispose();
    this._ws?.close();
    this._proxy = null;
    this._ws = null;
  }

  private _setReady(value: boolean): void {
    if (this._ready === value) return;
    this._ready = value;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", { detail: value }));
  }
}
customElements.define("demo-session", DemoSession);

// Register <feature-flags>.
bootstrapFlags();

// --- Render -----------------------------------------------------------------

// The `as Flags` cast is sound because bootstrapFlags() above ran
// synchronously — customElements.define() upgrades the already-connected
// <feature-flags id="flags"> in place before this line, so the element really
// is a Flags instance here. The cast does hide that ordering dependency: if
// you ever query the element BEFORE bootstrapFlags(), prefer
// `await customElements.whenDefined("feature-flags")` first.
const flagsEl = document.getElementById("flags") as Flags;
const body = document.getElementById("flags-body") as HTMLTableSectionElement;
const sIdentified = document.getElementById("s-identified")!;
const sLoading = document.getElementById("s-loading")!;
const sError = document.getElementById("s-error")!;
const sErrorWrap = document.getElementById("s-error-wrap")!;
const callout = document.getElementById("callout") as HTMLElement;

const state = {
  flags: {} as FlagMap,
  identified: false,
  loading: false,
  error: null as Error | null,
};

function isEnabled(value: FlagValue): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as { enabled?: boolean }).enabled === true;
  }
  return Boolean(value);
}

function render(): void {
  sIdentified.textContent = String(state.identified);
  sLoading.textContent = String(state.loading);
  sError.textContent = state.error ? state.error.message : "none";
  sErrorWrap.classList.toggle("err", Boolean(state.error));

  const entries = Object.entries(state.flags);
  if (entries.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="hint">Waiting for the first flag snapshot…</td></tr>`;
  } else {
    body.innerHTML = entries
      .map(([name, value]) => {
        const on = isEnabled(value);
        // Flag keys are schema-less and server-defined; escape them the same
        // way as the value so swapping InMemory for a real provider with
        // dynamic/untrusted keys can't inject markup here.
        return `<tr>
          <td><code>${escapeHtml(name)}</code></td>
          <td><span class="badge ${on ? "on" : "off"}">${on ? "ON" : "OFF"}</span></td>
          <td><code>${escapeHtml(JSON.stringify(value))}</code></td>
        </tr>`;
      })
      .join("");
  }

  const checkout = state.flags.new_checkout_flow as { enabled?: boolean } | undefined;
  callout.hidden = checkout?.enabled !== true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// bind() to the <feature-flags> ELEMENT (not the proxy). The element re-
// dispatches the proxy's surface as its own events, which is exactly what
// makes the declarative `data-wcs` path possible too (see @wcstack-state).
//
// Keep the unbind handle and release it on unload — the React example calls
// unbind() on effect cleanup and the Vue example calls it in onUnmounted, so
// this matches their lifecycle discipline rather than leaking the
// subscription. (A standalone page has no component teardown, so beforeunload
// is the equivalent hook.)
const unbind = bind(flagsEl, (name, value) => {
  switch (name) {
    case "flags":
      state.flags = (value ?? {}) as FlagMap;
      break;
    case "identified":
      state.identified = value === true;
      break;
    case "loading":
      state.loading = value === true;
      break;
    case "error":
      state.error = (value as Error | null) ?? null;
      break;
  }
  render();
});
window.addEventListener("beforeunload", () => unbind());

render();

// --- Controls ---------------------------------------------------------------
// `identify()` / `reload()` on the Shell delegate to the session proxy. They
// reject if called before the session is ready, so guard with a catch.
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-identify]")) {
  btn.addEventListener("click", () => {
    void flagsEl.identify(btn.dataset.identify!).catch((e) => console.warn(e));
  });
}
document.getElementById("btn-reload")!.addEventListener("click", () => {
  void flagsEl.reload().catch((e) => console.warn(e));
});
