/**
 * Shared demo server for the @csbc-dev/feature-flags examples.
 *
 * ONE server does everything the four browser examples need:
 *
 *   1. Static file serving for each example's compiled output, under a path
 *      prefix (`/react/`, `/vue/`, `/vanilla/`, `/wcstack-state/`).
 *   2. Serves the built package at `/_pkg/` (→ repo `dist/`) so the buildless
 *      wcstack-state example can `import` the real <feature-flags> Shell.
 *   3. Hosts a FlagsCore over WebSocket at `/ws` — one
 *      `FlagsCore` + `InMemoryFlagProvider` + `RemoteShellProxy` per connection.
 *
 * Everything is same-origin on one port, so the browser examples derive the
 * socket URL from `location` (`ws(s)://<host>/ws`) and never hard-code a port.
 *
 * NO Auth0, NO external flag service — the whole thing runs in-process. What it
 * mirrors from a real deployment: each connection gets its OWN Core/provider
 * pair (in production the per-session isolation comes from @csbc-dev/auth0), and
 * the Core is wired to the socket through `RemoteShellProxy`, so the browser
 * speaks the exact same wire protocol the production stack uses.
 *
 * NOTE: imports come from `../../dist/server/index.js` (the BUILT package), so
 * the repo must be built first (`npm run build` at the repo root). The
 * `/_pkg/` mount serves that same `dist/`, so the build is a prerequisite for
 * serving regardless — see examples/CONVENTIONS.md §3. Always use the `/server`
 * subpath on Node: the root entry pulls in `HTMLElement` and would throw.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type { ServerTransport, ServerMessage, ClientMessage } from "@wc-bindable/remote";
import { FlagsCore, InMemoryFlagProvider } from "../../dist/server/index.js";
import type { InMemoryFlagDefinition } from "../../dist/server/index.js";

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/** A path prefix mapped onto a directory of compiled/static files. */
export interface Mount {
  /** URL prefix, must start and end with `/`, e.g. `"/react/"`. */
  prefix: string;
  /** Absolute directory the prefix serves from. */
  root: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Resolve a request pathname to an absolute file inside one of the mounts. */
function resolveFile(mounts: Mount[], pathname: string): { mount: Mount; file: string } | null {
  // Longest matching prefix wins (so `/_pkg/server/...` is not shadowed).
  const mount = mounts
    .filter((m) => pathname.startsWith(m.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!mount) return null;

  let relative = pathname.slice(mount.prefix.length);
  if (relative === "" || relative.endsWith("/")) relative += "index.html";

  // Resolve and confine to the mount root — reject path traversal.
  const file = resolve(mount.root, relative);
  const rootWithSep = mount.root.endsWith(sep) ? mount.root : mount.root + sep;
  if (file !== mount.root && !file.startsWith(rootWithSep)) return null;
  return { mount, file };
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  mounts: Mount[],
  landingHtml: string,
): Promise<void> {
  // Parse + percent-decode the path defensively: `decodeURIComponent` throws a
  // URIError on malformed escapes (e.g. a bare `%`), and an uncaught throw here
  // would reject the handler promise and crash the whole server (taking every
  // example down). A malformed URL is a client error, so answer 400 and move on.
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingHtml);
    return;
  }

  // A bare mount root without the trailing slash (`/react`) must redirect to
  // `/react/`, otherwise the built page's relative asset URLs (`./assets/...`)
  // resolve against `/` and 404.
  const needsSlash = mounts.find((m) => pathname + "/" === m.prefix);
  if (needsSlash) {
    res.writeHead(301, { Location: pathname + "/" });
    res.end();
    return;
  }

  const resolved = resolveFile(mounts, pathname);
  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  try {
    const content = await readFile(resolved.file);
    const type = MIME_TYPES[extname(resolved.file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not Found: ${pathname}`);
  }
}

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter
//
// `@wc-bindable/remote` ships a `WebSocketServerTransport`, but hand-rolling
// the ~12-line adapter keeps the example dependency-light and shows exactly
// what the transport contract is: send JSON, forward parsed messages, signal
// close. In production prefer the shipped transport — it handles framing edge
// cases (binary frames, parse errors, backpressure) this teaching adapter
// deliberately omits (we restore only the parse guard below).
// ---------------------------------------------------------------------------
function createWsServerTransport(ws: WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(data)) as ClientMessage;
        } catch (err) {
          console.warn("[demo-server] dropping unparseable client frame:", err);
          return;
        }
        handler(msg);
      });
    },
    onClose(handler: () => void) {
      ws.on("close", handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Demo flag set
//
// Values use the package-wide "wrapped" shape `{ enabled, value }` so the same
// binding template (`flags.X.enabled` / `flags.X.value`) works whether you
// later swap InMemory for Flagsmith / Unleash / LaunchDarkly. Targeting rules
// are deliberately trivial (match on `userId`) so the browser can flip them by
// calling `identify("alice")` / `identify("bob")`.
// ---------------------------------------------------------------------------
export function buildDemoFlags(): InMemoryFlagDefinition[] {
  return [
    {
      // ON only for alice → demonstrates per-user targeting.
      key: "new_checkout_flow",
      defaultValue: { enabled: false, value: null },
      rules: [
        {
          key: "new_checkout_flow",
          value: { enabled: true, value: null },
          predicate: (id) => id.userId === "alice",
        },
      ],
    },
    {
      // ON only for bob.
      key: "dark_mode",
      defaultValue: { enabled: false, value: null },
      rules: [
        {
          key: "dark_mode",
          value: { enabled: true, value: null },
          predicate: (id) => id.userId === "bob",
        },
      ],
    },
    {
      // A string-valued flag — alice gets different copy.
      key: "cta_text",
      defaultValue: { enabled: true, value: "Buy now" },
      rules: [
        {
          key: "cta_text",
          value: { enabled: true, value: "Start free trial" },
          predicate: (id) => id.userId === "alice",
        },
      ],
    },
    {
      // Toggled by the server timer below — the live PUSH demo.
      key: "beta_banner",
      defaultValue: { enabled: false, value: null },
    },
  ];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface FlagsDemoServerOptions {
  port: number;
  /** Static mounts (path prefix → directory). `/ws` and `/` are reserved. */
  mounts: Mount[];
  /** HTML served at `/`. */
  landingHtml: string;
  /** WebSocket endpoint path. Default `/ws`. */
  wsPath?: string;
}

export function createFlagsDemoServer(options: FlagsDemoServerOptions): void {
  const { port, mounts, landingHtml, wsPath = "/ws" } = options;

  const httpServer = createServer((req, res) => {
    // Safety net: serveStatic guards its own known failure modes, but a
    // rejected handler promise must never go unhandled (Node aborts the
    // process on an unhandled rejection, which would kill every example).
    serveStatic(req, res, mounts, landingHtml).catch((err) => {
      console.warn("[demo-server] request handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: wsPath });

  wss.on("connection", (ws) => {
    const provider = new InMemoryFlagProvider({ flags: buildDemoFlags() });
    const core = new FlagsCore({ provider });

    // Wire the Core to this socket. Every Core event (flags-changed /
    // identified-changed / loading-changed / error) is now forwarded across
    // the wire to this client's RemoteCoreProxy.
    const shell = new RemoteShellProxy(core, createWsServerTransport(ws));

    // No auth token in the demo: identify everyone as "guest" so the initial
    // flag map is non-empty. The browser can re-identify as alice / bob.
    // FlagsCore routes provider failures to the `error` channel rather than
    // rejecting, so this won't reject with InMemoryFlagProvider; the `.catch`
    // leaves a trace if a real provider's `identify` rejects.
    void core.identify("guest").catch((e) => {
      console.error("[demo-server] initial identify('guest') failed:", e);
    });

    // Live PUSH demo: flip `beta_banner` on a timer. `setFlag` notifies the
    // provider's subscribers synchronously → FlagsCore re-publishes `flags` →
    // RemoteShellProxy forwards the update → the client's bound state updates
    // with no client-side polling.
    let bannerOn = false;
    const timer = setInterval(() => {
      bannerOn = !bannerOn;
      provider.setFlag("beta_banner", { enabled: bannerOn, value: null });
    }, 4000);

    ws.on("close", () => {
      clearInterval(timer);
      shell.dispose();
      void core.dispose();
    });

    console.log("[demo-server] client connected");
  });

  httpServer.listen(port, () => {
    console.log(`[demo-server] http   → http://localhost:${port}/`);
    console.log(`[demo-server] socket → ws://localhost:${port}${wsPath}`);
    console.log("[demo-server] flags: new_checkout_flow, dark_mode, cta_text, beta_banner");
    console.log("[demo-server] try identify('alice') or identify('bob') from a client");
  });
}
