import { createApp } from "vue";
import { bootstrapFlags } from "@csbc-dev/feature-flags";
import { defineDemoSession } from "../../shared/demo-session/index.js";
import App from "./App.vue";
import "./styles.css";

// Register the custom elements the App renders, BEFORE the app mounts:
//   - <demo-session> : the demo transport (stands in for <auth0-session>).
//   - <feature-flags>: the package's Shell (registered by bootstrapFlags()).
// Both are idempotent. The <feature-flags> Shell tolerates being mounted before
// its target resolves (it retries), so mount order is not a concern.
defineDemoSession();
bootstrapFlags();

createApp(App).mount("#app");
