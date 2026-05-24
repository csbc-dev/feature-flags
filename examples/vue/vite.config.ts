import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// Consume the package straight from SOURCE (like the vanilla example) so this
// example runs against the working tree without building the root package
// first. The matching tsconfig `paths` entry lets `vue-tsc` resolve the same
// imports during the typecheck step. The `@csbc-dev/feature-flags` element
// (Shell) + the shared `<demo-session>` are bound with `useWcBindable` from
// `@wc-bindable/vue`.
export default defineConfig({
  // Built output is served under the `/vue/` path prefix by the shared
  // server, so asset URLs must be relative (see CONVENTIONS.md §2).
  base: "./",
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Treat the package's <feature-flags> Shell and the demo
          // <demo-session> transport as custom elements, not Vue components,
          // so Vue mounts the real custom elements instead of trying to
          // resolve them as components.
          isCustomElement: (tag) => tag === "feature-flags" || tag === "demo-session",
        },
      },
    }),
  ],
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
    port: 5174,
    // Allow Vite to serve files from the repo root (the aliased package source
    // and the shared <demo-session> live above this example directory).
    fs: { allow: [repoRoot] },
    // Optional dev convenience: the documented run path is the shared server.
    // When using Vite HMR, proxy the Core socket so the derived `/ws` works.
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
  },
});
