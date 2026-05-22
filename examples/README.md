# @csbc-dev/feature-flags — examples

Runnable integration examples for four browser targets:

| Example | Integration style | What it shows |
|---|---|---|
| [`react/`](./react) | `RemoteCoreProxy` + `bind()` → React state | `useFeatureFlags()` hook |
| [`vue/`](./vue) | `RemoteCoreProxy` + `bind()` → reactive refs | `useFeatureFlags()` composable |
| [`vanilla/`](./vanilla) | `<feature-flags>` Shell element + `bind()` | imperative DOM, no framework |
| [`wcstack-state/`](./wcstack-state) | `<feature-flags>` + `data-wcs` | declarative binding, zero per-flag JS |

All four talk to one [`server/`](./server) — a self-contained WebSocket demo
server (`FlagsCore` + `InMemoryFlagProvider` + `RemoteShellProxy`). No Auth0, no
SaaS account, nothing to sign up for.

---

## Architecture recap

`@csbc-dev/feature-flags` is **remote-only** (CSBC Case B2). Every flag-evaluation
decision runs server-side in `FlagsCore`; the browser only *observes* the result.

```
 demo-server (Node)                         browser example
┌───────────────────────────┐  WebSocket  ┌──────────────────────────────┐
│ InMemoryFlagProvider       │◄───────────►│ RemoteCoreProxy              │
│   └─ FlagsCore (Core)      │             │   ├─ bind() → React/Vue/JS   │
│        └─ RemoteShellProxy │             │   └─ <feature-flags> + data-wcs│
└───────────────────────────┘             └──────────────────────────────┘
```

Two ways to consume it on the client, both shown here:

- **Bind the proxy directly** (React, Vue). Idiomatic in a framework — no custom
  element needed. This is the path documented in `@wc-bindable/remote`.
- **Use the `<feature-flags>` Shell element** (Vanilla, @wcstack-state). The
  element subscribes to a session and re-dispatches the flag surface onto itself,
  which is what makes the declarative `data-wcs` path work. In production the
  session is `<auth0-session>`; here a tiny `<demo-session>` element supplies the
  transport in its place.

---

## Running

You need **two terminals**: one for the demo server, one for an example.

### 1. Start the demo server

```bash
cd examples/server
npm install
npm run dev          # listens on ws://localhost:8787
```

The server:
- identifies each connection as `"guest"` on connect by explicitly calling
  `core.identify("guest")` (no real auth in the demo). NOTE: this is a manual
  call, *not* `FlagsCore`'s `userContext`-driven auto-identify — the demo
  constructs `new FlagsCore({ provider })` with no `userContext`, so the Core's
  `ensureIdentified()` / `_autoIdentify()` path stays dormant. In production you
  would arm `userContext` instead and let identification happen automatically.
- defines `new_checkout_flow`, `dark_mode`, `cta_text`, `beta_banner`,
- flips `beta_banner` every ~4 s so you can watch a **live push update**,
- has targeting rules so `identify("alice")` / `identify("bob")` change the map.

### 2. Start an example

```bash
cd examples/react        # or vue / vanilla / wcstack-state
npm install
npm run dev
```

| Example | Dev URL |
|---|---|
| react | http://localhost:5173 |
| vue | http://localhost:5174 |
| vanilla | http://localhost:5175 |
| wcstack-state | http://localhost:5176 |

Click **identify("alice")** / **identify("bob")** to watch server-side targeting
rules change the flag map, and **reload()** to force a fresh snapshot. The
`beta_banner` flag toggles on its own — that's the provider→Core→socket push path.

---

## How the examples resolve the package

The `react/` and `vue/` examples never import `@csbc-dev/feature-flags` itself —
they only need the wcBindable **declaration** (copied into `src/flags.ts`, exactly
as the package README recommends for the browser) plus `@wc-bindable/core` (for
`bind()`) and `@wc-bindable/remote` (for `createRemoteCoreProxy` /
`WebSocketClientTransport`). Both are listed in each example's `package.json`.

The `vanilla/` and `wcstack-state/` examples *do* use the `<feature-flags>` Shell.
Their `vite.config.ts` defines **two** aliases — `@csbc-dev/feature-flags` →
`../../src/index.ts` (browser entry) and `@csbc-dev/feature-flags/server` →
`../../src/server/index.ts` — so they run without building the root package
first. To consume the **built** package instead, run `npm run build` at the repo
root and repoint **both** aliases at `../../dist/index.js` and
`../../dist/server/index.js` respectively (the `vite.config.ts` comment notes
the same).

---

## Notes

- **`@wcstack-state` is loaded from a CDN** (esm.sh) in `wcstack-state/index.html`
  and is *not* installed locally. It is not bundled with this repo, so confirm the
  published package name / version / init export against its own docs and adjust
  the bootstrap line if needed. The `data-wcs` **markup** follows the documented
  syntax; only the runtime bootstrap call is library-specific. The CDN import is
  unpinned (`https://esm.sh/@wcstack-state` → esm.sh `latest`) and the `mount`
  export name is a placeholder; for anything beyond a throwaway demo, pin a
  version (`@wcstack-state@x.y.z`) and use the runtime's real init export.
- **Initial flag state is the empty map `{}`** — but it arrives by two
  different mechanisms depending on the integration style:
  - **vanilla / wcstack-state** (`<feature-flags>` Shell). The element holds
    `flags = EMPTY_FLAGS` and `bind()` replays that frozen `{}` synchronously,
    *before* the first server snapshot. So `flags` is genuinely `{}` (and deep
    paths like `currentFlags.cta_text.value` are `undefined`) for the first
    frame. vanilla special-cases this with a "Waiting for the first flag
    snapshot…" placeholder; wcstack-state instead relies on its declarative
    bindings tolerating undefined deep paths (see the comment in
    `wcstack-state/index.html`).
  - **react / vue** (bind the `RemoteCoreProxy` directly — no `<feature-flags>`
    element). The initial `{}` is the *framework's own* state seed
    (`useState({ flags: {} })` in `react/src/flags.ts`, `ref<FlagMap>({})` in
    `vue/src/flags.ts`). The proxy's cached `flags` is `undefined` until the
    first `sync`, and `bind()` only replays a property whose cached value is
    `!== undefined`, so React/Vue receive NO initial `flags` callback — their
    `{}` comes purely from the ref/state default, then the first real snapshot
    replaces it. They render "Waiting…" off `entries.length === 0`.
- **No build step required** for the demo server or the vanilla/wcstack examples —
  `tsx` (server) and Vite (browser) resolve the `.js` import specifiers in the
  package source to their `.ts` files automatically.
- **Wrapped flag shape.** The demo flags use the package-wide `{ enabled, value }`
  shape, so the same access pattern (`flags.X.enabled` / `flags.X.value`) works if
  you later swap `InMemoryFlagProvider` for Flagsmith / Unleash / LaunchDarkly.
- **Going to production:** replace `<demo-session>` with `<auth0-session>` and the
  demo server with something like:

  ```ts
  createAuthenticatedWSS({
    port: 8080,
    auth0Domain: "your.auth0.domain",
    auth0Audience: "https://api.example.com/",
    createCores: (user) => new FlagsCore({ provider, userContext: user }),
    // Re-identify on token refresh so targeting follows the latest claims —
    // omit this and the flag map stays pinned to the identity at connect.
    onTokenRefresh: (core, user) => (core as FlagsCore).updateUserContext(user),
  });
  ```

  This abbreviates the full setup; see the package [README](../README.md) for the
  complete `createAuthenticatedWSS` options and the Flagsmith / Unleash /
  LaunchDarkly server setups.
