<script setup lang="ts">
/**
 * Vue example for @csbc-dev/feature-flags — via the OFFICIAL adapter.
 *
 * Uses `useWcBindable` from `@wc-bindable/vue` instead of a hand-rolled `bind()`
 * composable. That adapter is ELEMENT-based: it binds the bindable surface of a
 * real `<feature-flags>` Shell element (attached through a template ref) into a
 * reactive `values` object. So this example renders the Shell plus a
 * `<demo-session>` transport (the stand-in for `<auth0-session>`) — the same
 * elements the vanilla and wcstack-state examples drive.
 *
 *   <demo-session>  opens the socket, exposes `.proxy` / `.ready`
 *        ↓ (auth0-session:ready-changed)
 *   <feature-flags> subscribes to the proxy, re-dispatches the flag surface
 *        ↓ (useWcBindable → bind)
 *   App            renders the reactive `values`
 *
 * Both elements are registered in `main.ts` before the app mounts.
 */
import { computed } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { Flags, FlagsValues, FlagValue } from "@csbc-dev/feature-flags";

// `flagsRef` is the template ref to attach to <feature-flags> (used both by the
// adapter for binding AND by us to call the element's commands). `values` is the
// reactive bound surface; the initial values keep the first render clean.
const { ref: flagsRef, values } = useWcBindable<Flags, FlagsValues>({
  flags: {},
  identified: false,
  loading: false,
  error: null,
});

const entries = computed(() => Object.entries(values.flags));

function isEnabled(value: FlagValue): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as { enabled?: boolean }).enabled === true;
  }
  return Boolean(value);
}

const newCheckout = computed(
  () => (values.flags.new_checkout_flow as { enabled?: boolean } | undefined)?.enabled === true,
);

// identify()/reload() on the Shell delegate to the session proxy and reject if
// called before the session is ready, so guard with a catch.
function identify(userId: string) {
  void flagsRef.value?.identify(userId).catch((e) => console.warn(e));
}
function reload() {
  void flagsRef.value?.reload().catch((e) => console.warn(e));
}
</script>

<template>
  <main>
    <h1>@csbc-dev/feature-flags — Vue</h1>
    <p class="hint">
      Flags evaluated server-side, observed through the <code>&lt;feature-flags&gt;</code>
      Shell with <code>useWcBindable</code> (the <code>@wc-bindable/vue</code> adapter).
      Re-identify to watch targeting rules change <code>new_checkout_flow</code>,
      <code>dark_mode</code> and <code>cta_text</code>. <code>beta_banner</code> is
      flipped by the server every few seconds — a live push update.
    </p>

    <!--
      Transport + Shell — both headless (display:none), they render nothing.
      <feature-flags target="flags-session"> resolves <demo-session> by id and
      subscribes to its RemoteCoreProxy; `ref` binds it via useWcBindable.
    -->
    <demo-session id="flags-session"></demo-session>
    <feature-flags ref="flagsRef" id="flags" target="flags-session"></feature-flags>

    <div class="status">
      <span>identified: <b>{{ values.identified }}</b></span>
      <span>loading: <b>{{ values.loading }}</b></span>
      <span :class="{ err: values.error }">error: <b>{{ values.error ? values.error.message : "none" }}</b></span>
    </div>

    <div class="controls">
      <button @click="identify('alice')">identify("alice")</button>
      <button @click="identify('bob')">identify("bob")</button>
      <button @click="identify('guest')">identify("guest")</button>
      <button @click="reload()">reload()</button>
    </div>

    <p v-if="entries.length === 0" class="hint">Waiting for the first flag snapshot…</p>
    <table v-else>
      <thead>
        <tr><th>flag</th><th>state</th><th>raw value</th></tr>
      </thead>
      <tbody>
        <tr v-for="[name, value] in entries" :key="name">
          <td><code>{{ name }}</code></td>
          <td>
            <span :class="['badge', isEnabled(value) ? 'on' : 'off']">
              {{ isEnabled(value) ? "ON" : "OFF" }}
            </span>
          </td>
          <td><code>{{ JSON.stringify(value) }}</code></td>
        </tr>
      </tbody>
    </table>

    <p v-if="newCheckout" class="callout">
      🎉 New checkout flow is enabled for this identity.
    </p>
  </main>
</template>
