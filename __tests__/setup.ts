// Setup file for Vitest (happy-dom environment).
//
// --- Optional peer deps in tests -----------------------------------
//
// `flagsmith-nodejs`, `unleash-client`, and `@launchdarkly/node-server-sdk`
// are declared as OPTIONAL peer deps in `package.json`. None of them
// are listed in `devDependencies`, so they are absent from
// `node_modules/` in this workspace. The provider test suites work
// regardless via Vitest's `vi.mock(specifier, factory)` virtual-module
// support, which serves the factory's return value when no physical
// module is resolved on disk.
//
// No physical SDK needs to be installed to execute this suite. Do
// NOT introduce a hand-placed stub under `node_modules/<peer>/` to
// "make it work" — an earlier revision did that and ended up
// silently masking a vi.hoisted regression in UnleashProvider.test.ts
// (the `vi.mock` factory referenced closure state that vitest could
// not hoist above imports, so the real on-disk stub beat the mock to
// module resolution). The `vi.hoisted(...)` pattern in that test
// file is what keeps the virtual-module path viable; if you add a
// new provider test that depends on a peer SDK, mirror it:
// top-level `vi.mock(specifier, hoistedFactory)` with no physical
// fallback in `node_modules/`.
