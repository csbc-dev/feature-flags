/**
 * Self-contained demo server for the @csbc-dev/feature-flags examples.
 *
 * NO Auth0, NO external flag service — everything runs in-process so the
 * four browser examples (React / Vue / Vanilla / @wcstack-state) can be
 * driven without signing up for anything.
 *
 * What it mirrors from a real deployment:
 *   - Each WebSocket connection gets its OWN `FlagsCore` +
 *     `InMemoryFlagProvider` pair (in production the per-session isolation
 *     comes from @csbc-dev/auth0; here we just make one per socket).
 *   - The Core is wired to the socket through `RemoteShellProxy`, so the
 *     browser speaks the exact same wire protocol the production stack
 *     uses (`createRemoteCoreProxy` on the client ⇄ `RemoteShellProxy`
 *     here).
 *
 * What's faked for the demo:
 *   - There is no token, so we identify each connection as `"guest"` by
 *     explicitly calling `core.identify("guest")` on connect. (This is a
 *     manual call — NOT FlagsCore's `userContext`-driven auto-identify, which
 *     only fires when the Core is constructed WITH a `userContext`; the demo
 *     passes none.) The browser can re-`identify("alice" | "bob")` to watch
 *     targeting rules change the flag map.
 *   - A timer flips `beta_banner` every few seconds so every example shows
 *     a live provider→Core→socket PUSH update with zero extra wiring.
 *
 * Run:  npm install && npm run dev     (listens on ws://localhost:8787)
 *
 * NOTE: imports come from `../../src/server/index.js` (the package SOURCE),
 * which `tsx` resolves to the `.ts` files — no build of the root package is
 * required. Always use the `/server` subpath on Node: the root entry pulls
 * in `HTMLElement` and would throw under Node.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type { ServerTransport, ServerMessage, ClientMessage } from "@wc-bindable/remote";
import { FlagsCore, InMemoryFlagProvider } from "../../src/server/index.js";
import type { InMemoryFlagDefinition } from "../../src/server/index.js";

const PORT = Number(process.env.PORT ?? 8787);

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter
//
// `@wc-bindable/remote` ships a `WebSocketServerTransport`, but hand-rolling
// the ~12-line adapter keeps the example dependency-light and shows exactly
// what the transport contract is: send JSON, forward parsed messages, signal
// close.
//
// In production prefer the shipped transport — `new WebSocketServerTransport(ws)`
// in place of `createWsServerTransport(ws)` below — it handles framing edge
// cases (binary frames, parse errors, backpressure) this teaching adapter
// deliberately omits.
// ---------------------------------------------------------------------------
function createWsServerTransport(ws: WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => {
        // Guard the parse: a malformed-JSON or binary frame must not throw
        // out of the ws 'message' listener (that would surface as an
        // uncaught exception and could take the demo server down). The
        // shipped `WebSocketServerTransport` handles these cases for you —
        // this is the one robustness corner the teaching adapter restores.
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
// Values use the package-wide "wrapped" shape `{ enabled, value }` so the
// same binding template (`flags.X.enabled` / `flags.X.value`) works whether
// you later swap InMemory for Flagsmith / Unleash / LaunchDarkly.
//
// Targeting rules below are deliberately trivial (match on `userId`) so the
// browser can flip them by calling `identify("alice")` / `identify("bob")`.
// ---------------------------------------------------------------------------
function buildFlags(): InMemoryFlagDefinition[] {
  return [
    {
      // ON only for alice → demonstrates per-user targeting.
      key: "new_checkout_flow",
      defaultValue: { enabled: false, value: null },
      rules: [
        {
          // NOTE: `rule.key` is required by the InMemoryFlagRule type but is
          // NOT used during evaluation — the provider's `_evaluate` writes the
          // result under the enclosing `def.key`, so a rule's `key` is only a
          // (here matching) label. Any value would produce the same flag map.
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
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const provider = new InMemoryFlagProvider({ flags: buildFlags() });
  const core = new FlagsCore({ provider });

  // Wire the Core to this socket. From now on every Core event
  // (flags-changed / identified-changed / loading-changed / error) is
  // forwarded across the wire to this client's RemoteCoreProxy.
  const transport = createWsServerTransport(ws);
  const shell = new RemoteShellProxy(core, transport);

  // No auth token in the demo: identify everyone as "guest" so the initial
  // flag map is non-empty. The browser can re-identify as alice / bob.
  //
  // FlagsCore routes provider failures to the `error` channel rather than
  // rejecting, so this promise won't reject with InMemoryFlagProvider. The
  // `.catch` is here so that swapping in a real provider whose `identify`
  // CAN reject (network/auth) leaves a trace in the server log instead of an
  // unhandled rejection.
  void core.identify("guest").catch((e) => {
    console.error("[demo-server] initial identify('guest') failed:", e);
  });

  // Live PUSH demo: flip `beta_banner` on a timer. `setFlag` notifies the
  // provider's subscribers synchronously → FlagsCore re-publishes `flags`
  // → RemoteShellProxy forwards the update → the client's bound state
  // updates with no client-side polling.
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

console.log(`[demo-server] listening on ws://localhost:${PORT}`);
console.log("[demo-server] flags: new_checkout_flow, dark_mode, cta_text, beta_banner");
console.log("[demo-server] try identify('alice') or identify('bob') from a client");
