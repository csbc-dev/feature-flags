// JSX typing for the custom elements this example renders. React 18 does not
// auto-type unknown intrinsic elements, so without this `<feature-flags>` /
// `<demo-session>` would be type errors. We type them to the real element
// classes so `ref` resolves to the element instance (handy for calling its
// `identify()` / `reload()` methods) and `target` is a known attribute.
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { Flags } from "@csbc-dev/feature-flags";
import type { DemoSession } from "../../shared/demo-session/index.js";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "feature-flags": DetailedHTMLProps<HTMLAttributes<Flags>, Flags> & {
        target?: string;
      };
      "demo-session": DetailedHTMLProps<HTMLAttributes<DemoSession>, DemoSession> & {
        url?: string;
      };
    }
  }
}
