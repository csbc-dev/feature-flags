/**
 * @wcstack-state example for @csbc-dev/feature-flags.
 *
 * This file is deliberately thin: with the declarative `data-wcs` runtime
 * (loaded from CDN in index.html) doing the state binding, the only
 * JavaScript needed is:
 *   1. defining the <demo-session> transport element,
 *   2. registering <feature-flags> via bootstrapFlags(),
 *   3. wiring the identify / reload command buttons.
 *
 * Compare this to the React / Vue examples: there the framework owns state and
 * you bind a proxy into it; here the DOM owns state and `<feature-flags>`
 * publishes into it. Both consume the exact same server-side Core.
 */
import { bootstrapFlags } from "@csbc-dev/feature-flags";
import type { Flags } from "@csbc-dev/feature-flags";
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
 * Minimal stand-in for <auth0-session>: <feature-flags> only needs a target
 * exposing `.proxy` / `.ready` that fires `auth0-session:ready-changed`.
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
    this._proxy = createRemoteCoreProxy(FLAGS_DECLARATION, new WebSocketClientTransport(ws));
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

// Command buttons. `identify()` / `reload()` on the Shell delegate to the
// session proxy and reject if the session isn't ready yet, so we guard them
// with `.catch`.
//
// This resolves the SAME element that data-wcs binds (index.html's
// `<feature-flags id="flags" ...>`): the declarative runtime publishes the
// flag surface into the store, while these buttons drive the imperative
// command surface of that one element. The `id="flags"` on it is REQUIRED here
// — without it `getElementById` returns null and the click handlers below
// would throw a synchronous TypeError on `flagsEl.identify(...)` (the property
// access happens before `.catch`, so it can't be swallowed).
//
// The `as Flags` cast is sound because bootstrapFlags() above ran
// synchronously and upgraded <feature-flags id="flags"> in place. If you ever
// query the element BEFORE bootstrapFlags(), await
// `customElements.whenDefined("feature-flags")` first.
const flagsEl = document.getElementById("flags") as Flags;
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-identify]")) {
  btn.addEventListener("click", () => {
    void flagsEl.identify(btn.dataset.identify!).catch((e) => console.warn(e));
  });
}
document.getElementById("btn-reload")!.addEventListener("click", () => {
  void flagsEl.reload().catch((e) => console.warn(e));
});
