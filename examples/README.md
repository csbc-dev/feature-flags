# @csbc-dev/feature-flags — examples

Runnable integration examples for four browser targets, all served by **one
shared server** that also hosts the server-side Core.

| Example | Path | Integration style | What it shows |
|---|---|---|---|
| [`react/`](./react) | `/react/` | `<feature-flags>` Shell + `useWcBindable` | the official `@wc-bindable/react` adapter |
| [`vue/`](./vue) | `/vue/` | `<feature-flags>` Shell + `useWcBindable` | the official `@wc-bindable/vue` adapter |
| [`vanilla/`](./vanilla) | `/vanilla/` | `<feature-flags>` Shell element + raw `bind()` | imperative DOM, no framework |
| [`wcstack-state/`](./wcstack-state) | `/wcstack-state/` | `<feature-flags>` + `data-wcs` (`@wcstack/state`) | declarative binding, zero per-flag JS |

The rules these examples follow are written down in
**[CONVENTIONS.md](./CONVENTIONS.md)** — read that before adding or changing an
example.

---

## Architecture recap

`@csbc-dev/feature-flags` is **remote-only** (CSBC Case B2). Every flag-evaluation
decision runs server-side in `FlagsCore`; the browser only *observes* the result.

```
  shared server (Node)                         browser example
┌───────────────────────────────┐            ┌─────────────────────────────────┐
│ InMemoryFlagProvider           │            │ <demo-session> (RemoteCoreProxy) │
│   └─ FlagsCore (Core)          │  /ws (WS)  │   └─ <feature-flags> Shell       │
│        └─ RemoteShellProxy     │◄──────────►│        ├─ useWcBindable (R/Vue)  │
├───────────────────────────────┤            │        ├─ raw bind()   (vanilla) │
│ static files: /react /vue …    │  (HTTP)    │        └─ data-wcs   (wcstack)   │
│ built package:  /_pkg/         │───────────►│                                  │
└───────────────────────────────┘            └─────────────────────────────────┘
```

One Node process ([`server/`](./server)) serves every example's compiled output,
serves the built package at `/_pkg/`, and hosts a per-connection
`FlagsCore` + `InMemoryFlagProvider` + `RemoteShellProxy` at `/ws`. No Auth0, no
SaaS account, nothing to sign up for — but the browser speaks the exact same wire
protocol the production stack uses.

All four examples drive the real `<feature-flags>` Shell — the package's primary
deliverable. The element subscribes to a session and re-dispatches the flag
surface onto itself, which is what makes every binding style below work. In
production the session is `<auth0-session>`; here a tiny `<demo-session>` element
supplies the transport in its place. What differs is *how* the Shell is bound:

- **Official framework adapter** (react, vue) — `useWcBindable` from
  `@wc-bindable/react` / `@wc-bindable/vue`.
- **Raw `bind()`** (vanilla) — the lowest-level `@wc-bindable/core` primitive.
- **Declarative `data-wcs`** (wcstack-state) — no per-flag JavaScript.

> Binding the `RemoteCoreProxy` directly (without the element) is also possible —
> it's the `@wc-bindable/remote` primitive — but the element + official adapter is
> the idiomatic path, so that's what these examples show.

---

## Running

```bash
cd examples
npm install      # installs the server + react + vue + vanilla workspaces
npm run build    # tsc the package, then vite-build react / vue / vanilla
npm start        # build (again, if needed) + serve on http://localhost:8080
```

Then open <http://localhost:8080/> and pick an example.

- `npm run serve` — serve without rebuilding (use after `npm run build`).
- `PORT=3000 npm run serve` — serve on a different port.

Click **identify("alice")** / **identify("bob")** to watch server-side targeting
rules change the flag map, and **reload()** to force a fresh snapshot. The
`beta_banner` flag toggles on its own — that's the provider→Core→socket push path.

> **Dev mode (optional).** Each framework example keeps a Vite `dev` script for
> HMR (`cd examples/react && npm run dev`). It proxies `/ws` to the shared
> server, so start `npm run serve` first. The documented, canonical run path is
> the shared server, not the Vite dev server (CONVENTIONS.md §2).

---

## How the examples resolve the package

- **react / vue** import the `<feature-flags>` Shell from the package **source**
  via a Vite alias to `../../src` (with a matching tsconfig `paths` entry so the
  `tsc` / `vue-tsc` typecheck agrees), the official `@wc-bindable/react` /
  `@wc-bindable/vue` adapter from npm, and the shared `<demo-session>` transport
  from `../../shared/demo-session`. Vite bundles them all. Vue also sets
  `compilerOptions.isCustomElement` so the custom elements aren't treated as Vue
  components.
- **vanilla** imports the `<feature-flags>` Shell from the package **source** via
  a Vite alias to `../../src`, and the shared `<demo-session>` transport from
  `../../shared/demo-session`; Vite bundles both.
- **wcstack-state** is buildless and has **no inline JavaScript**: its own state
  + `data-wcs` bindings live in one `index.html`. It registers `<feature-flags>`
  via the **built** package's `/auto` entry (`/_pkg/src/auto/auto.min.js`) and the shared
  `<demo-session>` via `/_shared/demo-session/auto.js` — both side-effect
  `<script src>` modules served by the shared server — plus `@wcstack/state` from
  a pinned CDN URL. The `<demo-session>` source is the *same* module vanilla
  bundles. See its `index.html` and CONVENTIONS.md §7.4.

---

## Notes

- **Initial flag state is the empty map `{}`** — all four examples are
  Shell-bound, so `<feature-flags>` replays its frozen `{}` on bind before the
  first server snapshot. CONVENTIONS.md §7.3 has the details; vanilla shows a
  "Waiting…" placeholder, wcstack-state tolerates undefined deep paths, react/vue
  seed `useWcBindable` with explicit initial values.
- **Wrapped flag shape.** The demo flags use the package-wide `{ enabled, value }`
  shape, so the same access pattern (`flags.X.enabled` / `flags.X.value`) works if
  you later swap `InMemoryFlagProvider` for Flagsmith / Unleash / LaunchDarkly.
- **The WebSocket URL is derived from `location`** (`ws(s)://<host>/ws`) in every
  example — same-origin with the shared server, no hard-coded ports.
- **Going to production:** replace `<demo-session>` with `<auth0-session>` and the
  demo server with something like:

  ```ts
  createAuthenticatedWSS({
    port: 8080,
    auth0Domain: "your.auth0.domain",
    auth0Audience: "https://api.example.com/",
    createCores: (user) => new FlagsCore({ provider, userContext: user }),
    // Re-identify on token refresh so targeting follows the latest claims.
    onTokenRefresh: (core, user) => (core as FlagsCore).updateUserContext(user),
  });
  ```

  See the package [README](../README.md) for the complete `createAuthenticatedWSS`
  options and the Flagsmith / Unleash / LaunchDarkly server setups.
