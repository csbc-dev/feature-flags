import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapFlags } from "@csbc-dev/feature-flags";
import { defineDemoSession } from "../../shared/demo-session/index.js";
import App from "./App";
import "./styles.css";

// Register the custom elements the App renders, BEFORE React mounts:
//   - <demo-session> : the demo transport (stands in for <auth0-session>).
//   - <feature-flags>: the package's Shell (registered by bootstrapFlags()).
// Both are idempotent. The <feature-flags> Shell tolerates being mounted before
// its target resolves (it retries), so React's render order is not a concern.
defineDemoSession();
bootstrapFlags();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
