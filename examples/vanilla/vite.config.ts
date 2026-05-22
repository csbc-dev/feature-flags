import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// Consume the package straight from SOURCE so the example runs without first
// building the root package — Vite resolves the `.js` specifiers in the
// source to their `.ts` files automatically. To consume the *built* package
// instead, point these at `dist/index.js` / `dist/server/index.js` and run
// `npm run build` at the repo root first.
export default defineConfig({
  resolve: {
    alias: [
      // This browser example imports ONLY the root entry (`@csbc-dev/feature-flags`).
      // The `/server` alias is kept as a safety net: if anything ever pulls the
      // server subpath into the browser bundle by mistake, it resolves to source
      // (failing loudly on the `HTMLElement`-free Node entry) instead of
      // silently 404-ing on the bare package specifier. The more-specific
      // `/server` pattern is listed first so it wins over the root pattern.
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
    port: 5175,
    // Allow Vite to serve files from the repo root (the aliased package
    // source lives above this example directory).
    fs: { allow: [repoRoot] },
  },
});
