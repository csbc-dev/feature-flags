import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// Same source-consuming setup as the vanilla example. @wcstack-state itself is
// NOT resolved here — it is loaded from a CDN inside index.html.
export default defineConfig({
  resolve: {
    alias: [
      // Like the vanilla example, this browser example uses ONLY the root
      // entry; the `/server` alias is a safety net so an accidental server-
      // subpath import resolves to source and fails loudly rather than 404-ing.
      // The more-specific `/server` pattern is listed first so it wins.
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
    port: 5176,
    fs: { allow: [repoRoot] },
  },
});
