/**
 * Side-effect entry point — registers the `<feature-flags>` custom element on
 * import, with no call needed by the consumer. Mirrors the `/auto` convention
 * of the other @csbc-dev/* components (and `@wcstack/*`), so a page can
 * register the Shell with a single tag:
 *
 *   <script type="module" src="https://esm.run/@csbc-dev/feature-flags/auto"></script>
 *
 * It is exactly `bootstrapFlags()` with defaults. When you need custom tag
 * names or want to split registration from configuration, import
 * `bootstrapFlags` (or `registerComponents` / `setConfig`) from the root entry
 * instead.
 */
import { bootstrapFlags } from "./index.js";

bootstrapFlags();
