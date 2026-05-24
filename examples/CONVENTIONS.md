# csbc-dev examples — conventions (規定)

This document is the **standard every example under `examples/` must follow**. It
exists so that the four browser targets stay structurally consistent, are easy to
compare side by side, and demonstrate the *same* server-side Core through four
different consumption styles.

It applies to `@csbc-dev/feature-flags`, but is written to be lifted into the
other csbc-dev packages (`auth0`, `s3-uploader`, `stripe`, `webauthn`, …) — the
rules are about *how examples are built and served*, not about flags.

> The shape mirrors the `@wcstack/*` example convention (a single shared static
> server, one example per framework, buildless where possible). csbc-dev examples
> additionally have to host a **server-side Core over WebSocket**, which the
> shared server owns.

---

## 1. The four targets (and nothing else)

Every package ships exactly these four browser examples, in this order:

| Dir | Integration style | What it proves |
|---|---|---|
| `react/` | the `<feature-flags>` Shell + `useWcBindable` (`@wc-bindable/react`) | the official React adapter |
| `vue/` | the `<feature-flags>` Shell + `useWcBindable` (`@wc-bindable/vue`) | the official Vue adapter |
| `vanilla/` | the `<feature-flags>` Shell element + raw `bind()` | imperative DOM, no framework |
| `wcstack-state/` | the `<feature-flags>` Shell + `data-wcs` | declarative binding, zero per-flag JS |

All four are **Shell-bound** — they drive the real `<feature-flags>` element
(the package's primary deliverable). What differs is *how* the Shell is bound:

- **Raw `bind()`** (vanilla) — the lowest-level `@wc-bindable/core` primitive.
- **Official framework adapter** (react, vue) — `useWcBindable`, which wraps
  `bind()` and the element's ref into one hook/composable.
- **Declarative `data-wcs`** (wcstack-state) — no per-flag JavaScript at all.

Every example pairs the Shell with the shared `<demo-session>` transport (the
stand-in for `<auth0-session>`). Binding the `RemoteCoreProxy` directly — without
the element — is possible (it's the `@wc-bindable/remote` primitive), but is not
demonstrated here: the element + official adapter is the idiomatic path.

Do not add a fifth framework folder without updating this document first.

---

## 2. One shared server. No per-example dev server for serving.

There is **one** server for all four examples: `examples/server/`. It is the only
thing that is ever started to *serve* the examples. It does three jobs:

1. **Static file serving** for each example's compiled output, under a path prefix:
   `/react/`, `/vue/`, `/vanilla/`, `/wcstack-state/`.
2. **Serves the built package** at `/_pkg/` (→ the repo's `dist/`) so the buildless
   `wcstack-state` example can `import` the real `<feature-flags>` Shell.
3. **Hosts the Core over WebSocket** at `/ws` — a per-connection
   `FlagsCore` + `InMemoryFlagProvider` + `RemoteShellProxy`.

Everything is **same-origin on one port**, so clients never hard-code a host or
port — see §5.

> **Why not Vite's dev server?** Each framework example may *use* Vite (or `tsc`)
> as a **build tool**, but Vite's dev server is not how examples are served. A
> single static server keeps all four examples on one origin, lets them share the
> `/ws` Core and the `/_pkg/` build, and matches how the package is actually
> consumed in production (a CDN/static host + a separate WebSocket backend). The
> per-example `dev` script (Vite HMR) may exist for authoring convenience, but it
> must proxy `/ws` to the shared server and is never the documented run path.

---

## 3. Everything compiles

No example relies on a runtime TypeScript loader resolving `.ts` on the fly to
*serve* the app. The canonical flow is **compile, then serve the compiled
output**:

| Target | Compile step | Output served from |
|---|---|---|
| root package | `tsc` (`npm run build` at repo root) | `dist/` → mounted at `/_pkg/` |
| react | `tsc --noEmit && vite build` | `examples/react/dist/` |
| vue | `vue-tsc --noEmit && vite build` | `examples/vue/dist/` |
| vanilla | `vite build` (esbuild type-strips; the Shell is bundled from `src`, whose full typecheck is the package's own `tsc`) | `examples/vanilla/dist/` |
| wcstack-state | *(none — buildless, single file)* | `examples/wcstack-state/` raw |
| server | runs via `tsx` (type-checked, not bundled) | n/a |

`examples/` has a root `package.json` whose `npm run build` builds the package
and all three compiled examples in order, and whose `npm start` builds (if
needed) and starts the shared server. A green `build` is the bar: an example that
does not type-check is broken.

---

## 4. Directory layout

```
examples/
├── CONVENTIONS.md          # this file
├── README.md               # quick start, points here
├── package.json            # orchestrator: build-all + start
├── server/                 # the one shared server (static + /_pkg/ + /ws Core)
│   ├── server.ts
│   ├── package.json
│   └── tsconfig.json
├── shared/                 # reusable building blocks
│   ├── flagsDemoServer.ts  # createFlagsDemoServer(): static + WebSocket(FlagsCore)
│   └── demo-session/       # the <demo-session> transport, shared by the
│       ├── DemoSession.js  #   Shell-bound examples (class definition)
│       ├── index.js        #   distribution entry: re-exports + defineDemoSession()
│       ├── index.d.ts      #   types for the bundled (vanilla) import
│       └── auto.js         #   side-effect entry: defines <demo-session> on load
├── react/                  # vite build → dist/, served at /react/ (Shell + demo-session via useWcBindable)
├── vue/                    # vite build → dist/, served at /vue/   (Shell + demo-session via useWcBindable)
├── vanilla/                # vite build → dist/, served at /vanilla/  (Shell + demo-session via raw bind())
└── wcstack-state/
    └── index.html          # one file for the example's state + bindings (see §7.4)
```

Compiled `react/dist`, `vue/dist`, `vanilla/dist` and the repo `dist/` are build
artifacts and are git-ignored.

---

## 5. The WebSocket URL is derived, never hard-coded

Because the shared server hosts the page **and** the Core on the same origin,
every example derives the URL from `location`:

```ts
export function flagsWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
```

This one expression is correct whether served by the shared server directly or
behind a Vite dev proxy. No `ws://localhost:8787` literals anywhere.

---

## 6. The Core lives on the server, always

`@csbc-dev/feature-flags` is CSBC Case B2: **remote-only**. No example evaluates
flags, holds an SDK key, or embeds targeting rules in the browser. Each browser
example only *observes* `FlagsCore` over the `/ws` `RemoteShellProxy`. The demo
server stands in for the production `createAuthenticatedWSS` stack — no Auth0, no
SaaS account — but speaks the exact same wire protocol.

The wcBindable **declaration** the proxy needs (`FLAGS_DECLARATION`) is declared
client-side — in the shared `demo-session` module every example uses to build the
`RemoteCoreProxy` — so a browser bundle never imports the server entry or a
provider SDK. That copy MUST stay identical to `FlagsCore.wcBindable`.

---

## 7. Per-target rules

### 7.1 react / vue (Shell-bound via the official adapter)

- Render the real `<feature-flags>` Shell plus the shared `<demo-session>`
  transport, and bind the Shell with `useWcBindable` from `@wc-bindable/react` /
  `@wc-bindable/vue` (an npm dep). The adapter is **element-based**: it takes a
  ref to the element and returns the bound `values` — it handles the
  subscribe / initial-replay / cleanup that a hand-rolled `bind()` hook did.
- `useWcBindable` binds the element's output **properties** only. **Commands**
  (`identify` / `reload`) are not part of the bound surface — keep a ref to the
  element and call its methods (compose it with the adapter's ref). Guard the
  calls with `.catch` (they reject before the session is ready).
- Register both elements before the app mounts (`defineDemoSession()` +
  `bootstrapFlags()` in `main.tsx` / `main.ts`). The Shell tolerates mounting
  before its target resolves, so framework render order is not a concern.
- The package + shared `<demo-session>` are consumed from **source** (like
  vanilla): a Vite alias to `../../src` plus a matching tsconfig `paths` entry so
  the `tsc` / `vue-tsc` typecheck and the Vite bundle agree. Vue additionally
  sets `compilerOptions.isCustomElement` so `<feature-flags>` / `<demo-session>`
  are mounted as custom elements, not resolved as Vue components.
- `vite.config` sets `base: "./"` so built asset URLs resolve under the `/react/`
  (or `/vue/`) path prefix. Keep an optional `dev` script that proxies `/ws`.

### 7.2 vanilla (Shell-bound, compiled)

- Drives the real `<feature-flags>` Shell plus the shared `<demo-session>`
  element (`examples/shared/demo-session`, registered via `defineDemoSession()`)
  that supplies the transport in place of `<auth0-session>` (it exposes `.proxy`
  / `.ready` and fires `auth0-session:ready-changed`).
- `bind()` to the **element** (not the proxy) — the Shell re-dispatches the proxy
  surface as its own events.
- Built with Vite (`base: "./"`); the Shell is bundled from the package source
  via a `tsconfig`/Vite alias to `../../src`, and the shared `demo-session`
  module is bundled from `../../shared`.

### 7.3 Initial flag state

All four are Shell-bound, so the empty map `{}` arrives the same way:
`<feature-flags>` holds `flags = {}` frozen and `bind()` replays it synchronously
before the first server snapshot, so deep paths (`currentFlags.cta_text.value`)
are `undefined` for the first frame. Handle it where it bites:

- **vanilla** shows a "Waiting…" placeholder; **wcstack-state** relies on
  bindings tolerating undefined.
- **react / vue** seed `useWcBindable` with explicit initial values
  (`{ flags: {}, identified: false, loading: false, error: null }`) so the first
  render is clean before the Shell's replayed `{}` arrives.

### 7.4 wcstack-state (Shell-bound, declarative) — the strict rules

This example is held to `@wcstack/state`'s own five rules. It MUST be:

1. **One file for the example itself** — the state, `data-wcs` bindings, and CSS
   all live in `index.html`. No `src/`, no `package.json`, no Vite, no build
   step. The only thing it pulls in beyond the runtime + Shell is the shared
   `<demo-session>` transport (the *same* module the vanilla example bundles),
   loaded over the server's `/_shared/` mount — keeping the binding lesson
   readable in one file without re-duplicating the reused plumbing.
2. **CDN-based for the runtime** — `@wcstack/state` is loaded with its
   self-registering auto entry and **pinned**:

   ```html
   <script type="module" src="https://esm.run/@wcstack/state@1.10.4/auto"></script>
   ```

   No bootstrap call — the `/auto` entry registers `<wcs-state>` on load (Rule 3:
   initial load = tag definitions only).
3. **State declared inline** in `<wcs-state><script type="module">export default
   {…}</script></wcs-state>`. Update by **path assignment** (`this["a.b"] = …`),
   never `this.a.b = …`.
4. **No inline JavaScript — both elements register via side-effect `/auto`
   scripts** served by the demo server:
   - `<feature-flags>` from the built package's `/auto` entry,
     `<script type="module" src="/_pkg/src/auto/auto.min.js">` — the exact file
     npm ships for the `@csbc-dev/feature-flags/auto` export (equivalent to
     `import "@csbc-dev/feature-flags/auto"`). It is served at the package's
     published layout under `/_pkg/` (`/auto` at `/_pkg/src/auto/`, the compiled
     Shell at `/_pkg/dist/`) and its modules import each other relatively, so
     **no** bare `@csbc-dev/feature-flags` import map entry is needed.
   - `<demo-session>` from `<script type="module" src="/_shared/demo-session/auto.js">`.

   The `importmap` therefore only maps the bare `@wc-bindable/core` /
   `@wc-bindable/remote` specifiers reached from the served Shell (`bind()`) and
   transport (`RemoteCoreProxy`) → pinned esm.run URLs that **match the version
   the package was built against** (currently `0.4.0`), so the served Shell and
   the transport share one module instance.
5. **Bindings follow the current `@wcstack/state` spec**, not guesses:
   - Element output properties → state paths:
     `data-wcs="flags: currentFlags; identified: flagsReady; loading: flagsLoading; error: flagsError"`.
   - Text is `textContent:` (or the `text:` alias) — **never** a made-up `text:`-only
     form. Interpolation is `{{ path|filter }}`.
   - Conditionals are `if:` / `elseif:` / `else:` on `<template>`.
   - Commands are invoked **declaratively via command tokens**, never imperative
     `getElementById(...).identify(...)` glue:

     ```html
     <!-- state -->  $commandTokens: ["identifyFlags", "reloadFlags"],
                     identify(_e, who) { this.$command.identifyFlags.emit(who); },
                     reload()          { this.$command.reloadFlags.emit(); }
     <!-- element --> data-wcs="...; command.identify: $command.identifyFlags;
                                     command.reload:  $command.reloadFlags"
     <!-- button -->  data-wcs="onclick: reload"
     ```

     This requires the element's `wcBindable.commands` to be the object form
     `[{ name, async? }]` (the string form was removed in `@wcstack/state`
     v1.9.1). `FlagsCore.wcBindable` already uses the object form.
6. **Ordering**: the `/auto` scripts that register `<demo-session>`
   (`/_shared/demo-session/auto.js`) and `<feature-flags>`
   (`/_pkg/src/auto/auto.min.js`) must run **before** the `@wcstack/state/auto`
   script in document order.
   Module scripts execute in order, so by the time
   `<wcs-state>` scans `data-wcs` both elements are upgraded and their
   `static wcBindable` is readable.

When `@wcstack/state` ships a new version, bump the pinned CDN version here and
re-verify the binding names against `packages/state/README.md` in the wcstack
repo — the binding surface is the contract, and a stale guess is a bug.

---

## 8. Running (canonical)

```bash
# from examples/
npm install            # installs each workspace's deps
npm run build          # builds the package + react + vue + vanilla
npm start              # starts the shared server on http://localhost:8080
```

Then open `http://localhost:8080/` and pick an example. `identify("alice")` /
`identify("bob")` flips server-side targeting; `beta_banner` toggles on its own
(a live provider→Core→socket push).

---

## 9. Checklist for a new example / new package

- [ ] Folder is one of the four canonical names, demonstrating its assigned style.
- [ ] Derives the WS URL from `location` (§5); no host/port literals.
- [ ] Compiles cleanly (§3); served from compiled output, not `.ts` at runtime.
- [ ] Added to the shared server's mount table and the landing page.
- [ ] No SDK, no flag rules, no credentials in the browser (§6).
- [ ] wcstack-state stays a single CDN-based file with current-spec bindings (§7.4).
