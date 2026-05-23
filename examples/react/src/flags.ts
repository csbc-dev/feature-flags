/**
 * React adapter for @csbc-dev/feature-flags.
 *
 * `<feature-flags>` is remote-only: the Core runs on the server and the
 * browser observes its bindable surface through a `RemoteCoreProxy`. In a
 * framework like React you don't need the `<feature-flags>` custom element
 * at all — you bind the proxy straight into component state. (The element
 * exists for the *declarative* `data-wcs` path; see the wcstack-state
 * example, which binds it with @wcstack/state.)
 *
 * This file has three pieces:
 *   1. FLAGS_DECLARATION — the wcBindable surface, copied so the browser
 *      bundle never imports the server entry / provider SDKs.
 *   2. createFlagsProxy — opens the socket and returns a proxy.
 *   3. useFeatureFlags — binds the proxy into React state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
 * `@csbc-dev/feature-flags/server`) so a browser bundle never pulls in the
 * server-only Core + provider SDKs — exactly what the package README
 * recommends for the client side.
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

// Flag value types mirror the package's `FlagValue` / `FlagMap`.
export type FlagValue =
  | boolean
  | string
  | number
  | null
  | FlagValue[]
  | { [key: string]: FlagValue };
export type FlagMap = Readonly<Record<string, FlagValue>>;

export interface FlagsState {
  flags: FlagMap;
  identified: boolean;
  loading: boolean;
  error: Error | null;
}

export interface UseFeatureFlags extends FlagsState {
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
  // createRemoteCoreProxy immediately sends a `sync` request; the transport
  // buffers it until the socket opens.
  const proxy = createRemoteCoreProxy(FLAGS_DECLARATION, transport);
  return {
    proxy,
    close: () => {
      proxy.dispose();
      ws.close();
    },
  };
}

/**
 * Subscribe to the remote FlagsCore and expose its state + commands.
 *
 * The connection is created *inside* the effect so React 18 StrictMode's
 * mount→unmount→mount cycle gets a fresh socket each time (and the previous
 * one is cleanly disposed) instead of binding to an already-disposed proxy.
 */
export function useFeatureFlags(url = flagsWsUrl()): UseFeatureFlags {
  const [state, setState] = useState<FlagsState>({
    flags: {},
    identified: false,
    loading: false,
    error: null,
  });
  const proxyRef = useRef<RemoteCoreProxy | null>(null);

  useEffect(() => {
    const { proxy, close } = createFlagsProxy(url);
    proxyRef.current = proxy;

    // bind() replays the proxy's currently-cached values synchronously,
    // then streams every subsequent update.
    const unbind = bind(proxy, (name, value) => {
      setState((prev) => {
        switch (name) {
          case "flags":
            return { ...prev, flags: (value ?? {}) as FlagMap };
          case "identified":
            return { ...prev, identified: value === true };
          case "loading":
            return { ...prev, loading: value === true };
          case "error":
            return { ...prev, error: (value as Error | null) ?? null };
          default:
            return prev;
        }
      });
    });

    return () => {
      unbind();
      close();
      proxyRef.current = null;
    };
  }, [url]);

  const identify = useCallback(
    (userId: string, attrs?: Record<string, unknown>): Promise<void> =>
      proxyRef.current
        ? proxyRef.current.invoke("identify", userId, attrs).then(() => undefined)
        : Promise.resolve(),
    [],
  );

  const reload = useCallback(
    (): Promise<void> =>
      proxyRef.current
        ? proxyRef.current.invoke("reload").then(() => undefined)
        : Promise.resolve(),
    [],
  );

  return { ...state, identify, reload };
}
