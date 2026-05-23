/**
 * Side-effect entry: registers <demo-session> on load — no exports, no call
 * needed by the consumer. Mirrors the CDN `/auto` convention used by the
 * @csbc-dev/* components. Load it with:
 *
 *   <script type="module" src="/_shared/demo-session/auto.js"></script>
 */
import { defineDemoSession } from "./index.js";

defineDemoSession();
