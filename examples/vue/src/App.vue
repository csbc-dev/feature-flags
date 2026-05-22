<script setup lang="ts">
import { computed } from "vue";
import { useFeatureFlags, type FlagValue } from "./flags";

const { flags, identified, loading, error, identify, reload } = useFeatureFlags();

const entries = computed(() => Object.entries(flags.value));

function isEnabled(value: FlagValue): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as { enabled?: boolean }).enabled === true;
  }
  return Boolean(value);
}

const newCheckout = computed(
  () => (flags.value.new_checkout_flow as { enabled?: boolean } | undefined)?.enabled === true,
);
</script>

<template>
  <main>
    <h1>@csbc-dev/feature-flags — Vue</h1>
    <p class="hint">
      Flags evaluated server-side, observed over a <code>RemoteCoreProxy</code>.
      Re-identify to watch targeting rules change <code>new_checkout_flow</code>,
      <code>dark_mode</code> and <code>cta_text</code>. <code>beta_banner</code> is
      flipped by the server every few seconds — a live push update.
    </p>

    <div class="status">
      <span>identified: <b>{{ identified }}</b></span>
      <span>loading: <b>{{ loading }}</b></span>
      <span :class="{ err: error }">error: <b>{{ error ? error.message : "none" }}</b></span>
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
