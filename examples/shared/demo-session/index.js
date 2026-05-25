/**
 * Public API for the shared <demo-session> demo transport ("distribution"
 * entry). Import this when you want to register the element yourself (e.g. the
 * vanilla example bundles it and calls `defineDemoSession()`); load `./auto.js`
 * instead when you just want it registered as a side effect (the wcstack-state
 * example loads the esbuild pre-bundle of `./auto.js` — `auto.bundle.js`, built
 * by `npm run build:shared` — via `<script src=".../auto.bundle.js">`).
 */
export { DemoSession, FLAGS_DECLARATION, flagsWsUrl } from "./DemoSession.js";
import { DemoSession } from "./DemoSession.js";

/** Register <demo-session> (idempotent). Pass a tag name to override. */
export function defineDemoSession(tagName = "demo-session") {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, DemoSession);
  }
}
