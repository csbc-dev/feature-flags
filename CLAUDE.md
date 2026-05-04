# CLAUDE.md

This repository (`@csbc-dev/feature-flags`) was re-packaged from [`@wc-bindable/flags`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/flags) as a member of the csbc-dev/arch architecture family. The two documents below are the prerequisites for understanding the design intent.

---

## 1. Overview of wc-bindable-protocol

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its own reactive properties. It enables reactivity systems such as React / Vue / Svelte / Angular / Solid to bind to arbitrary components without writing framework-specific glue code.

### Core idea

- The component author declares **what** is bindable.
- The framework consumer decides **how** to bind it.
- Neither side needs to know about the other.

### How to declare

Just write the schema in the `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // optional
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // optional
  };
}
```

| Field | Required | Role |
|---|---|---|
| `properties` | ✅ | Properties whose state changes are notified via `CustomEvent` (output) |
| `inputs` | — | Settable properties (input; declaration only — no automatic sync) |
| `commands` | — | Invokable methods (intended for remote proxies and tooling) |

### How binding works

An adapter only needs to do the following:

1. Read `target.constructor.wcBindable`.
2. Verify `protocol === "wc-bindable" && version === 1`.
3. For each `property`, immediately read `target[name]` and emit it as the initial value, then subscribe to `event`.

`bind()` can be implemented in roughly 20 lines. Framework adapters fit in tens of lines.

### Out of scope (deliberately)

- Automatic two-way synchronization (reflecting inputs is the caller's responsibility).
- Form integration.
- SSR / hydration.
- Value type / schema validation.

### Why EventTarget

Setting `EventTarget` (rather than `HTMLElement`) as the minimum requirement lets the same protocol run in non-browser runtimes such as Node.js / Deno / Cloudflare Workers. Since `HTMLElement` is a subclass of `EventTarget`, Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Overview of the Core/Shell Bindable Component (CSBC) architecture

Built on top of wc-bindable-protocol, this architecture **moves business logic — especially asynchronous code — out of the framework layer and into the Web Component layer**, structurally eliminating framework lock-in.

### The problem it solves

The real source of framework migration cost is not UI compatibility but **async logic that is tightly coupled to framework-specific lifecycle APIs (`useEffect` / `onMounted` / `onMount` …)**. Templates can be rewritten mechanically, but async code requires semantic understanding, which makes the porting cost explode.

### Three-layer structure

1. **Headless Web Component layer** — encapsulates async work (fetch / WebSocket / timers, etc.) and state (`value`, `loading`, `error`, …) inside the component. It has no UI and behaves as a pure service layer.
2. **Protocol layer (wc-bindable-protocol)** — exposes that state externally via `static wcBindable` + `CustomEvent`.
3. **Framework layer** — connects to the protocol with a thin adapter and renders the received state. **No async code lives here.**

### Core / Shell separation

The Headless layer is further split into two. **The single invariant is not "the Shell is always thin," but where decision authority lives:**

- **Core (`EventTarget`) — owns decisions.**
  Business logic, policies, state transitions, authorization-related behavior, event emission. If kept DOM-free, it can also be carried into Node.js / Deno / Workers.
- **Shell (`HTMLElement`) — owns only the execution that cannot be delegated.**
  Framework integration, DOM lifecycle, work that can only run in the browser.

The design key is the **target injection** pattern: the Core's constructor accepts an arbitrary `EventTarget` and dispatches every event onto it. When the Shell passes `this`, Core events fire directly from the DOM element — no re-dispatching needed.

### Four canonical cases

| Case | Core location | Shell role | Examples |
|---|---|---|---|
| A | Browser | Thin wrapper around a browser-bound Core | `auth0-gate` (local) |
| B1 | Server | Thin Shell that brokers commands / acts as a proxy | `ai-agent` (remote) |
| B2 | Server | Observation-only thin Shell (just subscribes to a remote session) | **`feature-flags`** |
| C | Server | Shell that runs a browser-bound data plane | `s3-uploader`, `passkey-auth`, `stripe-checkout` |

Case C is **a first-class case**, not a deviation from CSBC. It arises whenever a data plane can only run in the browser — direct uploads, WebRTC, WebUSB, `File System Access API`, user-gesture-bound work, Stripe Elements (to stay out of PCI scope), etc. Even if the Shell becomes thicker, **as long as decisions stay in the Core**, it is not a CSBC violation.

> Invariant:
> **The Core owns every decision. The Shell owns only the execution that cannot be delegated.**

### Three boundaries crossed

| Boundary | Crossing entity | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-free; runs on Node / Deno / Workers |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding |
| Network boundary | `@wc-bindable/remote` | Proxy EventTarget + JSON wire protocol |

`@wc-bindable/remote` is a pair of `RemoteShellProxy` (server-side) and `RemoteCoreProxy` (client-side). It pushes the Core fully to the server while leaving the client-side `bind()` unchanged. The default transport is WebSocket, but anything that satisfies the minimal `ClientTransport` / `ServerTransport` interfaces — MessagePort / BroadcastChannel / WebTransport, etc. — is swappable.

### Position of this package

`@csbc-dev/feature-flags` is **Case B2**: every flag-evaluation decision (provider SDK integration, targeting-rule evaluation, identity management, change notification) lives in `FlagsCore` (Core, `EventTarget`) on the server side. The `<feature-flags>` element (Shell, `HTMLElement`) is a pure **observation-only adapter** that subscribes over a remote session and republishes the evaluation results locally. The Shell is given no command surface (no mutating methods) — the truth of the flags is always centralized in the server-side Core, so confidential flags and paid SDK keys are never exposed to the client.

Reference: [csbc-dev/arch (formerly hawc)](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. Overview of this project

`@csbc-dev/feature-flags` is a headless feature-flag observation component for the wc-bindable ecosystem. It is **not** a visual UI widget — it is a pure observation node that bridges server-side flag evaluation to reactive browser-side state.

### Public surface

- **Output state**: `flags` (a frozen `Record<string, FlagValue>` map), `identified`, `loading`, `error`.
- **Input / commands**: `identify(userId, attrs)`, `reload()`.
- **Custom element**: `<feature-flags>` (Shell). Consumed declaratively from HTML, e.g. `data-wcs="flags: currentFlags; identified: flagsReady"`.

The browser holds no SDK, no targeting logic, and no flag-service credentials. Everything runs server-side inside `FlagsCore`; the Shell only re-dispatches the bindable surface received over a `RemoteCoreProxy`.

### Why server-side evaluation

Running the targeting evaluation in the browser leaks two things:

1. **Rule leakage** — anyone reading `window.LaunchDarkly.__rules` in DevTools sees the full rollout strategy (experiment names, cohorts).
2. **Identity leakage** — every per-user trait (email / plan / permissions) has to be serialized into the browser, widening the attack surface.

`@csbc-dev/feature-flags` is remote-only by design. A future `mode="local"` for non-sensitive flags is reserved but not shipped in v1.

### Repository layout

| Path | Role |
|---|---|
| [src/index.ts](src/index.ts) | Browser-facing entry. Re-exports `<feature-flags>` (Shell), `bootstrapFlags`, `registerComponents`, `config`. |
| [src/server/index.ts](src/server/index.ts) | DOM-free Node entry. Re-exports `FlagsCore` and the providers. **Always import this path on Node** — the root entry pulls in `HTMLElement`. |
| [src/core/FlagsCore.ts](src/core/FlagsCore.ts) | Core (`EventTarget`). Owns SDK orchestration, identity, flag map, event emission. |
| [src/components/Flags.ts](src/components/Flags.ts) | Shell (`HTMLElement`). Observation-only adapter — subscribes to the session's `RemoteCoreProxy` and re-dispatches. |
| [src/providers/](src/providers/) | Provider adapters: `FlagsmithProvider`, `UnleashProvider`, `LaunchDarklyProvider`, `InMemoryFlagProvider` (for tests). |
| [src/types.ts](src/types.ts) | Shared types (`FlagMap`, `FlagValue`, `FlagIdentity`, provider option shapes). |
| [src/freeze.ts](src/freeze.ts) | Helper for emitting frozen flag maps so reference-equality reactive systems see honest changes. |
| [src/bootstrapFlags.ts](src/bootstrapFlags.ts) / [registerComponents.ts](src/registerComponents.ts) / [config.ts](src/config.ts) | Boot wiring and configurable tag names. |
| [`__tests__/`](__tests__/) | Vitest unit tests. |
| [`tests/`](tests/) | Playwright integration tests. |

### Composition pattern

The canonical setup pairs `<feature-flags>` with `@wc-bindable/auth0`:

```html
<auth0-gate    id="auth"          domain="..." client-id="..." remote-url="wss://api.example.com/flags"></auth0-gate>
<auth0-session id="auth-session"  target="auth" core="flags-core"></auth0-session>
<feature-flags target="auth-session" data-wcs="flags: currentFlags; identified: flagsReady"></feature-flags>
```

- `<auth0-gate>` owns the Auth0 SDK and the authenticated WebSocket.
- `<auth0-session>` collapses authenticated → connected → synced into a single `ready` signal.
- `<feature-flags>` subscribes to the session's `RemoteCoreProxy` and re-dispatches flag events onto itself so `data-wcs` works.

`@csbc-dev/feature-flags` does **not** open its own socket — the transport comes from the auth gate.

### Schema-less flag surface

Feature-flag sets are inherently schema-less (server-side flag additions must not require a client redeploy), but `static wcBindable` is static. The resolution: expose a single `flags` property carrying `Record<string, FlagValue>`. Updates are whole-map (`Object.freeze({ ...next })`), not deltas — at ~100 flags × ~64 bytes the payload stays under 10 KB per update.

Consumers access flags by dotted path: `values.flags.new_checkout_flow.enabled`.

### Provider abstraction

`FlagProvider` (defined in [src/types.ts](src/types.ts)) normalizes Flagsmith / Unleash / LaunchDarkly / in-memory implementations into:

- `subscribe(identity, onChange) → unsubscribe` — push-based per-identity flag stream.
- `evaluate(identity)` — initial fetch.
- `dispose()` — release SDK handles.

`FlagsCore` only depends on this interface, so swapping providers is a constructor-arg change. The default `valueShape` is `"wrapped"` (`{ enabled, value }`) so a single binding template works across every provider; LaunchDarkly's `"raw"` shape is opt-in for LD-only frontends.

### Error contract

- **Provider failures** (`identify` / `subscribe` / `reload`) are published to the `error` / `feature-flags:error` channel and clear `loading`. Bind the state — do not `try / catch` these.
- **Transport failures** are handled one layer up by `<auth0-session>`; the last-known flag map is retained until a fresh session lights up.
- **Precondition violations** (missing provider, dispose-after-use) throw synchronously.

### Testing

- `npm run test` / `npm run test:unit` — Vitest unit tests in [__tests__/](__tests__/).
- `npm run test:coverage` — V8 coverage report, scoped to `src/**/*.ts` and excluding the type-only / re-export entry points.
- `npm run test:integration` — builds the package then runs Playwright against the real Shell.

### Build

- `npm run build` — `tsc` to `dist/`. Output is consumed via the dual `.` (browser) / `./server` (Node) export map declared in [package.json](package.json).
- `npm run dev` — `tsc --watch`.
