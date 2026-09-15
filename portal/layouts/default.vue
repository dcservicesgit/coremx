<template>
  <v-app>
    <alert />
    <v-app-bar v-if="!isMail" flat border>
      <v-app-bar-title>CoreMX</v-app-bar-title>
      <v-btn to="/mail">Webmail</v-btn>
      <v-btn to="/coremx">Mail administration</v-btn>
      <v-btn to="/admin/auth/passkeysetup">Passkeys</v-btn>
      <v-btn to="/admin/auth/logout">Sign out</v-btn>
    </v-app-bar>
    <v-main>
      <v-progress-linear v-if="!store.websocketConnected" indeterminate aria-label="Connecting to CoreMX" />
      <NuxtPage />
    </v-main>
  </v-app>
</template>
<script setup>
import { useMainStore } from '~/store';
const store = useMainStore();
const route = useRoute();
const isMail = computed(() => route.path === '/mail');
const { $dcsajax } = useNuxtApp();
onMounted(() => {
  store.enable_connection = true;
});
watch(
  () => store.websocketConnected,
  async (connected) => {
    if (!connected) return;
    try {
      const response = await $dcsajax({ Controller: 'auth', handle: 'thisdevice', data: {} });
      if (response.status === 100) store.thisdevice.user = response.payload.user;
    } catch {
      /* Central's transport manages reconnect and authentication routing. */
    }
  }
);
</script>
