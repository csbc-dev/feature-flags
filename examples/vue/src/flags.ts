/**
 * Vue adapter for @csbc-dev/feature-flags.
 *
 * Same idea as the React example: `<feature-flags>` is remote-only, so in a
 * framework you bind the server-side Core's `RemoteCoreProxy` straight into
 * reactive state — no custom element required. (The `<feature-flags>`
 * element is for the declarative `data-wcs` path; see the @wcstack-state
 * example.)
 */
import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { bind } from "@wc-bindable/core";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
} from "@wc-bindable/remote";

/**
 * The FlagsCore bindable surface. MUST stay identical to
 * `FlagsCore.wcBindable`. Copied here (rather than imported from
 * `@csbc-dev/feature-flags/server`) so the browser bundle never pulls in
 * the server-only Core + provider SDKs.
 */
export const FLAGS_DECLARATION: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "flags", event: "feature-flags:flags-changed" },
    { name: "identified", event: "feature-flags:identified-changed" },
    { name: "loading", event: "feature-flags:loading-changed" },
    { name: "error", event: "feature-flags:error" },
  ],
  commands: [
    { name: "identify", async: true },
    { name: "reload", async: true },
  ],
};

// Same-origin socket — the shared server hosts the page AND the Core, so the
// URL is derived from location, never hard-coded (see CONVENTIONS.md §5).
export function flagsWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export type FlagValue =
  | boolean
  | string
  | number
  | null
  | FlagValue[]
  | { [key: string]: FlagValue };
export type FlagMap = Readonly<Record<string, FlagValue>>;

export interface UseFeatureFlags {
  flags: Ref<FlagMap>;
  identified: Ref<boolean>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
  identify: (userId: string, attrs?: Record<string, unknown>) => Promise<void>;
  reload: () => Promise<void>;
}

/** Open a WebSocket and wrap it in a RemoteCoreProxy. */
export function createFlagsProxy(url = flagsWsUrl()): {
  proxy: RemoteCoreProxy;
  close: () => void;
} {
  const ws = new WebSocket(url);
  const transport = new WebSocketClientTransport(ws);
  const proxy = createRemoteCoreProxy(FLAGS_DECLARATION, transport);
  return {
    proxy,
    close: () => {
      proxy.dispose();
      ws.close();
    },
  };
}

/** Composable: subscribe to the remote FlagsCore and expose state + commands. */
export function useFeatureFlags(url = flagsWsUrl()): UseFeatureFlags {
  const flags = ref<FlagMap>({});
  const identified = ref(false);
  const loading = ref(false);
  const error = ref<Error | null>(null);

  let proxy: RemoteCoreProxy | null = null;
  let unbind: (() => void) | null = null;
  let close: (() => void) | null = null;

  onMounted(() => {
    const conn = createFlagsProxy(url);
    proxy = conn.proxy;
    close = conn.close;
    // bind() replays cached values immediately, then streams updates.
    unbind = bind(proxy, (name, value) => {
      switch (name) {
        case "flags":
          flags.value = (value ?? {}) as FlagMap;
          break;
        case "identified":
          identified.value = value === true;
          break;
        case "loading":
          loading.value = value === true;
          break;
        case "error":
          error.value = (value as Error | null) ?? null;
          break;
      }
    });
  });

  onUnmounted(() => {
    unbind?.();
    close?.();
    proxy = null;
  });

  const identify = (userId: string, attrs?: Record<string, unknown>): Promise<void> =>
    proxy ? proxy.invoke("identify", userId, attrs).then(() => undefined) : Promise.resolve();
  const reload = (): Promise<void> =>
    proxy ? proxy.invoke("reload").then(() => undefined) : Promise.resolve();

  return { flags, identified, loading, error, identify, reload };
}
