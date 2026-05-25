/**
 * Smoke check for the wcstack-state example's generated dependency.
 *
 * The wcstack-state example dropped its import map by loading a PRE-BUNDLED
 * <demo-session> transport (auto.bundle.js, esbuild, @wc-bindable/* inlined).
 * That bundle is a build artifact (gitignored), so a generation failure, a
 * source/bundle drift, or a stale `<script src>` reference would otherwise only
 * surface when a human opens /wcstack-state/ in a browser. This dependency-free
 * check ties the three together so CI / `npm run smoke` catches them headlessly.
 *
 * Scope: this is a STATIC check (filesystem + HTML text). It does NOT execute the
 * page, so script-execution order and esm.run CDN runtime compatibility are out
 * of scope — verify those by opening /wcstack-state/ (or a Playwright run) after
 * changes that touch the script tags, the document order, or the runtime/CDN pins.
 *
 * Run it via `npm run smoke` (from examples/), which builds the bundle first:
 *   "smoke": "npm run build:shared && node verify-shared-bundle.mjs"
 */
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(here, "shared/demo-session/auto.bundle.js");
const HTML = resolve(here, "wcstack-state/index.html");
const BUNDLE_URL = "/_shared/demo-session/auto.bundle.js";

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// 1) The bundle exists (build:shared ran and produced it).
let bundle = "";
try {
  await access(BUNDLE);
  bundle = await readFile(BUNDLE, "utf8");
} catch {
  failures.push(`bundle missing: ${BUNDLE} — run \`npm run build:shared\` first`);
}

if (bundle) {
  // 2) Dependencies are inlined — no bare @wc-bindable specifier survives, so the
  //    page genuinely needs no import map. (A leftover bare import = the whole
  //    point of the change regressed.)
  check(
    !/\bfrom\s*["']@wc-bindable\//.test(bundle),
    "bundle still contains a bare `@wc-bindable/*` import — esbuild did not inline the deps",
  );
  // 3) It is the RIGHT source, fully bundled: it registers the element and carries
  //    FlagsCore's declaration. Catches an empty/wrong/half-built artifact.
  check(bundle.includes("customElements.define"), "bundle does not register a custom element");
  check(
    bundle.includes("feature-flags:flags-changed"),
    "bundle is missing FLAGS_DECLARATION (wrong or stale source bundled)",
  );
}

// 4) The example points at the bundle, not the raw source...
const html = await readFile(HTML, "utf8");
check(
  html.includes(`src="${BUNDLE_URL}"`),
  `wcstack-state/index.html does not load ${BUNDLE_URL} (stale or typo'd <script src>)`,
);
// 5) ...and carries no import map (the thing this change removed).
check(
  !/<script[^>]*type=["']importmap["']/.test(html),
  "wcstack-state/index.html still has an <script type=\"importmap\"> — should be gone",
);

if (failures.length) {
  console.error("SMOKE: FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("SMOKE: PASS — shared bundle generated, deps inlined, wcstack-state wired without an import map");
