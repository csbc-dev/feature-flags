/**
 * Side-effect entry: registers <demo-session> on load — no exports, no call
 * needed by the consumer. Mirrors the CDN `/auto` convention used by the
 * @csbc-dev/* components.
 *
 * The wcstack-state example loads the esbuild PRE-BUNDLE of this file
 * (`auto.bundle.js`, with @wc-bindable/* inlined), built by
 * `npm run build:shared`, so that page needs no import map:
 *
 *   <script type="module" src="/_shared/demo-session/auto.bundle.js"></script>
 */
import { defineDemoSession } from "./index.js";

defineDemoSession();
