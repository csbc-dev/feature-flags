import type { WcBindableDeclaration } from "@wc-bindable/core";
import type { RemoteCoreProxy } from "@wc-bindable/remote";

/** FlagsCore bindable surface — identical to `FlagsCore.wcBindable`. */
export declare const FLAGS_DECLARATION: WcBindableDeclaration;

/** Same-origin Core socket URL, derived from `location`. */
export declare function flagsWsUrl(): string;

/** Stand-in for `<auth0-session>`: exposes `.proxy` / `.ready`. */
export declare class DemoSession extends HTMLElement {
  get proxy(): RemoteCoreProxy | null;
  get ready(): boolean;
}

/** Register `<demo-session>` (idempotent). */
export declare function defineDemoSession(tagName?: string): void;
