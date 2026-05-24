/**
 * Entry point for the one shared example server.
 *
 * Mounts each example's compiled output, serves a landing page at `/`, and
 * hosts FlagsCore over `/ws`. See examples/CONVENTIONS.md §2 for the contract
 * this implements. (The wcstack-state example loads the published
 * `<feature-flags>` Shell from the esm.run CDN, so the server no longer serves
 * the package itself.)
 *
 * Run:  npm install && npm start   (from examples/)  — builds first, then serves
 *       npm run dev                (from examples/server) — serve without rebuild
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createFlagsDemoServer, type Mount } from "../shared/flagsDemoServer.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesRoot = resolve(here, "..");

const PORT = Number(process.env.PORT ?? 8080);

const mounts: Mount[] = [
  { prefix: "/react/", root: resolve(examplesRoot, "react/dist") },
  { prefix: "/vue/", root: resolve(examplesRoot, "vue/dist") },
  { prefix: "/vanilla/", root: resolve(examplesRoot, "vanilla/dist") },
  // wcstack-state is buildless — served raw (its index.html + shared modules).
  // It loads the <feature-flags> Shell from the esm.run CDN, so there is no
  // package mount here (see examples/CONVENTIONS.md §7.4).
  { prefix: "/wcstack-state/", root: resolve(examplesRoot, "wcstack-state") },
  // Shared browser modules (the <demo-session> transport), loaded buildless by
  // the wcstack-state example; the vanilla example bundles the same source.
  { prefix: "/_shared/", root: resolve(examplesRoot, "shared") },
];

const EXAMPLES = [
  { path: "/react/", title: "React", blurb: "The <feature-flags> Shell bound with useWcBindable (@wc-bindable/react)." },
  { path: "/vue/", title: "Vue", blurb: "The <feature-flags> Shell bound with useWcBindable (@wc-bindable/vue)." },
  { path: "/vanilla/", title: "Vanilla", blurb: "The <feature-flags> Shell element + raw bind(), no framework." },
  { path: "/wcstack-state/", title: "@wcstack/state", blurb: "Declarative data-wcs binding, zero per-flag JS." },
];

const landingHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>@csbc-dev/feature-flags — examples</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  p.lead { color: #666; }
  ul { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
  li a { display: block; padding: 1rem 1.25rem; border: 1px solid #8884; border-radius: 10px; text-decoration: none; color: inherit; }
  li a:hover { border-color: #16a34a; background: #16a34a14; }
  li a b { font-size: 1.05rem; }
  li a span { display: block; color: #777; font-size: 0.9rem; margin-top: 0.2rem; }
  code { background: #8881; padding: 0.1em 0.35em; border-radius: 4px; }
</style>
</head>
<body>
<h1>@csbc-dev/feature-flags — examples</h1>
<p class="lead">
  Four browser targets, one server-side <code>FlagsCore</code> over <code>/ws</code>.
  Flags are evaluated on the server; the browser only observes. <code>beta_banner</code>
  toggles itself every few seconds — a live push.
</p>
<ul>
${EXAMPLES.map((e) => `  <li><a href="${e.path}"><b>${e.title}</b><span>${e.blurb}</span></a></li>`).join("\n")}
</ul>
</body>
</html>`;

createFlagsDemoServer({ port: PORT, mounts, landingHtml });
