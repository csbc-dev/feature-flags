import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// Consume the package straight from SOURCE (like the vanilla example) so this
// example runs against the working tree without building the root package
// first — Vite resolves the `.js` specifiers in the source to their `.ts`
// files automatically. The matching tsconfig `paths` entry lets `tsc` resolve
// the same imports during the typecheck step. The `@csbc-dev/feature-flags`
// element (Shell) + the shared `<demo-session>` are bound with `useWcBindable`
// from `@wc-bindable/react`.
export default defineConfig({
  // Built output is served under the `/react/` path prefix by the shared
  // server, so asset URLs must be relative (see CONVENTIONS.md §2).
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      // The `/server` pattern is listed first so it wins over the root pattern.
      {
        find: /^@csbc-dev\/feature-flags\/server$/,
        replacement: resolve(repoRoot, "src/server/index.ts"),
      },
      {
        find: /^@csbc-dev\/feature-flags$/,
        replacement: resolve(repoRoot, "src/index.ts"),
      },
    ],
  },
  server: {
    port: 5173,
    // Allow Vite to serve files from the repo root (the aliased package source
    // and the shared <demo-session> live above this example directory).
    fs: { allow: [repoRoot] },
    // Optional dev convenience: the documented run path is the shared server.
    // When using Vite HMR, proxy the Core socket so the derived `/ws` works.
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
  },
});
