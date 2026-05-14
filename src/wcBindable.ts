import type { FlagMap, IWcBindable } from "./types.js";

/**
 * Shared bindable surface for the feature-flags Core and Shell.
 *
 * `FlagsCore` (server, `EventTarget`) and `<feature-flags>` (browser,
 * `HTMLElement`) MUST advertise the identical `static wcBindable`
 * descriptor — they are the two ends of one protocol, and any drift
 * between them is a silent protocol mismatch (a property the Shell
 * re-dispatches under a name the Core never published, or vice versa).
 * Defining the descriptor once here makes that impossible.
 */
export const FLAGS_WC_BINDABLE: IWcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "flags",      event: "feature-flags:flags-changed" },
    { name: "identified", event: "feature-flags:identified-changed" },
    { name: "loading",    event: "feature-flags:loading-changed" },
    { name: "error",      event: "feature-flags:error" },
  ],
  commands: [
    { name: "identify", async: true },
    { name: "reload",   async: true },
  ],
};

/**
 * Canonical empty flag map. Frozen so it is safe to share as the
 * initial value of both the Core and the Shell without either side
 * being able to mutate it.
 */
export const EMPTY_FLAGS: FlagMap = Object.freeze({});
