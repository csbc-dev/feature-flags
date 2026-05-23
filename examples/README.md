# @csbc-dev/feature-flags — examples

Runnable integration examples for four browser targets, all served by **one
shared server** that also hosts the server-side Core.

| Example | Path | Integration style | What it shows |
|---|---|---|---|
| [`react/`](./react) | `/react/` | `RemoteCoreProxy` + `bind()` → React state | `useFeatureFlags()` hook |
| [`vue/`](./vue) | `/vue/` | `RemoteCoreProxy` + `bind()` → reactive refs | `useFeatureFlags()` composable |
| [`vanilla/`](./vanilla) | `/vanilla/` | `<feature-flags>` Shell element + `bind()` | imperative DOM, no framework |
| [`wcstack-state/`](./wcstack-state) | `/wcstack-state/` | `<feature-flags>` + `data-wcs` (`@wcstack/state`) | declarative binding, zero per-flag JS |

The rules these examples follow are written down in
**[CONVENTIONS.md](./CONVENTIONS.md)** — read that before adding or changing an
example.

---

## Architecture recap

`@csbc-dev/feature-flags` is **remote-only** (CSBC Case B2). Every flag-evaluation
decision runs server-side in `FlagsCore`; the browser only *observes* the result.

```
 shared server (Node)                       browser example
┌──────────────────────────────┐  /ws (WS) ┌──────────────────────────────┐
│ InMemoryFlagProvider          │◄─────────►│ RemoteCoreProxy              │
│   └─ FlagsCore (Core)         │           │   ├─ bind() → React/Vue/JS   │
│        └─ RemoteShellProxy    │           │   └─ <feature-flags> + data-wcs│
│ static files: /react /vue …   │  (HTTP)   │                              │
│ built package:  /_pkg/        │──────────►│  (wcstack-state imports Shell)│
└──────────────────────────────┘           └──────────────────────────────┘
```

One Node process ([`server/`](./server)) serves every example's compiled output,
serves the built package at `/_pkg/`, and hosts a per-connection
`FlagsCore` + `InMemoryFlagProvider` + `RemoteShellProxy` at `/ws`. No Auth0, no
SaaS account, nothing to sign up for — but the browser speaks the exact same wire
protocol the production stack uses.

Two ways to consume it on the client, both shown here:

- **Bind the proxy directly** (react, vue) — idiomatic in a framework, no custom
  element. This is the path documented in `@wc-bindable/remote`.
- **Use the `<feature-flags>` Shell element** (vanilla, wcstack-state) — the
  element subscribes to a session and re-dispatches the flag surface onto
  itself, which is what makes the declarative `data-wcs` path work. In production
  the session is `<auth0-session>`; here a tiny `<demo-session>` element supplies
  the transport in its place.

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

- **react / vue** never import `@csbc-dev/feature-flags`. They only need the
  wcBindable **declaration** (`FLAGS_DECLARATION`, copied into `src/flags.ts`)
  plus `@wc-bindable/core` and `@wc-bindable/remote` — all bundled by Vite.
- **vanilla** imports the `<feature-flags>` Shell from the package **source** via
  a Vite alias to `../../src`, and Vite bundles it.
- **wcstack-state** is buildless and single-file: it imports the **built** Shell
  from `/_pkg/index.js` (served by the shared server) through an import map, and
  loads `@wcstack/state` from a pinned CDN URL. See its `index.html` and
  CONVENTIONS.md §7.4.

---

## Notes

- **Initial flag state is the empty map `{}`** — but it arrives by two different
  mechanisms (Shell-bound vs proxy-bound). CONVENTIONS.md §7.3 has the details;
  vanilla shows a "Waiting…" placeholder, wcstack-state tolerates undefined deep
  paths, react/vue seed `{}` in framework state.
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
