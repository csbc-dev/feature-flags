/**
 * E2E test server for feature-flags remote mode.
 *
 * - Serves static files (dist + test HTML) via HTTP
 * - Provides /admin/set-flag endpoint that mutates the server-side
 *   InMemoryFlagProvider, exercising the Provider → FlagsCore push path
 * - Runs a WebSocket server with FlagsCore connected through RemoteShellProxy
 *
 * Each WebSocket connection gets its own FlagsCore + InMemoryFlagProvider
 * pair, keyed by a client-supplied `session` query parameter. The admin
 * endpoint targets the provider tied to `X-Session-Id`, so parallel test
 * connections cannot cross-contaminate each other's flag state.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type { ServerTransport, ServerMessage, ClientMessage } from "@wc-bindable/remote";
import { FlagsCore } from "../../src/core/FlagsCore.js";
import { InMemoryFlagProvider } from "../../src/providers/InMemoryFlagProvider.js";
import type { InMemoryFlagDefinition } from "../../src/providers/InMemoryFlagProvider.js";
import type { FlagValue } from "../../src/types.js";

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter
// ---------------------------------------------------------------------------

function createWsServerTransport(ws: import("ws").WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => {
        handler(JSON.parse(String(data)));
      });
    },
    onClose(handler: () => void) {
      ws.on("close", handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Default flag rules shared by every fresh session.
// ---------------------------------------------------------------------------

function buildDefaultFlags(): InMemoryFlagDefinition[] {
  return [
    {
      key: "feature-x",
      defaultValue: false,
      rules: [
        {
          key: "feature-x",
          value: true,
          predicate: (id) => id.userId === "alice",
        },
      ],
    },
    {
      key: "feature-y",
      defaultValue: "legacy",
      rules: [
        {
          key: "feature-y",
          value: "new",
          predicate: (id) => id.userId === "bob",
        },
      ],
    },
    {
      key: "feature-z",
      defaultValue: 42,
    },
  ];
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

interface Session {
  provider: InMemoryFlagProvider;
  core: FlagsCore;
}

export function startServer(port: number): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  return new Promise((resolve) => {
    // After the monorepo → standalone-package split, `@wc-bindable/core`
    // and `@wc-bindable/remote` ship as installed npm dependencies, not
    // sibling workspace packages. The integration client.html still
    // resolves them via `/packages/<name>/...` URLs (matching the wire
    // format the original monorepo dev server used) — we satisfy that
    // contract by rewriting the URL prefix to the installed location
    // under `node_modules/@wc-bindable/<name>/`.
    const wcBindableRoot = path.resolve(
      import.meta.dirname,
      "../../node_modules/@wc-bindable",
    );
    const integrationDir = import.meta.dirname;

    const sessions = new Map<string, Session>();

    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";

      // Route: POST /admin/set-flag — mutate the InMemoryFlagProvider bound
      // to the session identified by the `X-Session-Id` header. Bodies are
      // JSON: `{ key: string, defaultValue: FlagValue }`.
      if (url === "/admin/set-flag" && req.method === "POST") {
        const sessionId = String(req.headers["x-session-id"] ?? "");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const session = sessions.get(sessionId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session not found" }));
            return;
          }
          try {
            const parsed = JSON.parse(body) as { key: string; defaultValue: FlagValue };
            session.provider.setFlag(parsed.key, parsed.defaultValue);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "bad request" }));
          }
        });
        return;
      }

      // Route: /client.html
      if (url === "/" || url === "/client.html") {
        const file = path.join(integrationDir, "client.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Route: /packages/<name>/... → node_modules/@wc-bindable/<name>/...
      // The leading `/packages/` prefix is stripped and the remainder
      // resolved against `node_modules/@wc-bindable` so e.g.
      // `/packages/core/dist/index.js` becomes
      // `node_modules/@wc-bindable/core/dist/index.js`.
      if (url.startsWith("/packages/")) {
        // Strip the query / hash before joining — a `?` or `#` in the
        // URL would otherwise become part of the filesystem path.
        const rawPath = url.slice("/packages/".length).split(/[?#]/)[0];
        // Decode percent-escapes so an encoded `%2e%2e` traversal
        // attempt is normalized into real `..` segments BEFORE the
        // containment check below — otherwise the check sees the
        // still-encoded form and `path.resolve` decodes nothing,
        // letting the escaped traversal slip through `fs.existsSync`.
        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(rawPath);
        } catch {
          // Malformed percent-encoding — reject outright.
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const resolved = path.resolve(wcBindableRoot, decodedPath);
        // Containment check: the resolved path must stay inside
        // `wcBindableRoot`. Without this, `/packages/../../../etc/passwd`
        // (or its percent-encoded form) would read files anywhere on
        // disk. Compare against `wcBindableRoot + sep` so a sibling
        // directory sharing the prefix (`@wc-bindable-evil/`) cannot
        // satisfy a naive `startsWith(wcBindableRoot)`.
        if (resolved !== wcBindableRoot && !resolved.startsWith(wcBindableRoot + path.sep)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          const ext = path.extname(resolved);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          fs.createReadStream(resolved).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws, req) => {
      const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const sessionId = reqUrl.searchParams.get("session") ?? crypto.randomUUID();

      const provider = new InMemoryFlagProvider({ flags: buildDefaultFlags() });
      const core = new FlagsCore({ provider });
      sessions.set(sessionId, { provider, core });

      const transport = createWsServerTransport(ws);
      new RemoteShellProxy(core, transport);

      ws.on("close", () => {
        sessions.delete(sessionId);
        void core.dispose();
      });
    });

    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((r) => {
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}
