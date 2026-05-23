import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // Built output is served under the `/vue/` path prefix by the shared
  // server, so asset URLs must be relative (see CONVENTIONS.md §2).
  base: "./",
  plugins: [vue()],
  server: {
    port: 5174,
    // Optional dev convenience: the documented run path is the shared server.
    // When using Vite HMR, proxy the Core socket so the derived `/ws` works.
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
  },
});
