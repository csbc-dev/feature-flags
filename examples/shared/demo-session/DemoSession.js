/**
 * <demo-session> — class definition.
 *
 * A tiny stand-in for <auth0-session> for the @csbc-dev/feature-flags examples.
 * <feature-flags> only needs a `target` element that structurally exposes
 * `.proxy` (a RemoteCoreProxy) and `.ready` (a boolean) and fires
 * `auth0-session:ready-changed` when readiness flips — that whole contract,
 * without Auth0.
 *
 * Shared by the Shell-bound examples (vanilla bundles this via Vite; the
 * buildless wcstack-state example loads it over the demo server's /_shared/
 * mount). It is plain ESM JS so both consumption styles work; the bare
 * `@wc-bindable/remote` import resolves from node_modules (Vite) or the page's
 * import map (wcstack-state).
 *
 * NOT part of the published package — this is example-only glue. In production
 * the transport comes from <auth0-session>; see the package README.
 */
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
} from "@wc-bindable/remote";

/**
 * FlagsCore bindable surface, needed to build the RemoteCoreProxy. MUST stay
 * identical to `FlagsCore.wcBindable` (the package does not re-export the
 * declaration from its browser entry).
 */
export const FLAGS_DECLARATION = {
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
 * Same-origin socket URL — the shared demo server hosts the page AND the Core,
 * so the URL is derived from location, never hard-coded (CONVENTIONS.md §5).
 */
export function flagsWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export class DemoSession extends HTMLElement {
  _proxy = null;
  _ready = false;
  _ws = null;

  get proxy() {
    return this._proxy;
  }
  get ready() {
    return this._ready;
  }

  connectedCallback() {
    this.style.display = "none";
    // Defer opening the socket until the page has fully loaded, so a
    // declarative binder (<wcs-state>) finishes wiring up BEFORE the first
    // server snapshot arrives. Otherwise, on a fast (localhost) connection the
    // server's one-shot `identified` push can be dispatched before the binder
    // has subscribed — and unlike `flags` (re-pushed every ~4s, so a missed
    // first push self-heals) a deduped one-shot value would then be missed for
    // good. Harmless for bind()-based consumers (vanilla), whose @wc-bindable
    // `bind()` replays the element's cached values on subscribe. A real
    // <auth0-session> opens its socket only after auth completes, so it never
    // races the initial bind; this `load` gate reproduces that ordering.
    if (document.readyState === "complete") this._connect();
    else window.addEventListener("load", () => this._connect(), { once: true });
  }

  _connect() {
    if (this._ws) return;
    const ws = new WebSocket(this.getAttribute("url") || flagsWsUrl());
    this._ws = ws;
    this._proxy = createRemoteCoreProxy(FLAGS_DECLARATION, new WebSocketClientTransport(ws));
    ws.addEventListener("open", () => this._setReady(true));
    ws.addEventListener("close", () => this._setReady(false));
  }

  disconnectedCallback() {
    this._setReady(false);
    this._proxy?.dispose();
    this._ws?.close();
    this._proxy = null;
    this._ws = null;
  }

  _setReady(value) {
    if (this._ready === value) return;
    this._ready = value;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", { detail: value }));
  }
}
