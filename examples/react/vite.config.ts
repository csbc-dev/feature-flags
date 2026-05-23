import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Built output is served under the `/react/` path prefix by the shared
  // server, so asset URLs must be relative (see CONVENTIONS.md §2).
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    // Optional dev convenience: the documented run path is the shared server.
    // When using Vite HMR, proxy the Core socket so the derived `/ws` works.
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true } },
  },
});
