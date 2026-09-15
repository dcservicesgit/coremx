import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import { createVuetify } from 'vuetify';

export default defineNuxtPlugin((app) => {
  const media =
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let appearance = 'system';
  try {
    const stored = localStorage.getItem('coremx.appearance');
    if (stored && ['light', 'dark', 'system'].includes(stored)) appearance = stored;
  } catch {
    /* Browser storage is optional. */
  }
  const resolved = () =>
    appearance === 'system' ? (media?.matches ? 'dark' : 'light') : appearance;
  const vuetify = createVuetify({
    theme: {
      defaultTheme: resolved(),
      themes: {
        light: {
          dark: false,
          colors: {
            background: '#f7f4fa',
            surface: '#ffffff',
            'surface-variant': '#e9dcf6',
            'on-background': '#2e203c',
            'on-surface': '#2e203c',
            'on-surface-variant': '#462265',
            primary: '#7241ac',
            'on-primary': '#ffffff',
            secondary: '#7946b1',
            error: '#a83950',
            success: '#367453',
            warning: '#8a650c',
            info: '#68509a'
          }
        },
        dark: {
          dark: true,
          colors: {
            background: '#14101b',
            surface: '#211a2c',
            'surface-variant': '#3b2a50',
            'on-background': '#f2eafa',
            'on-surface': '#f2eafa',
            'on-surface-variant': '#d1c4e0',
            primary: '#b58ae9',
            'on-primary': '#251334',
            secondary: '#c19af2',
            error: '#ffa4b7',
            success: '#85cea4',
            warning: '#e9c06a',
            info: '#c5aff4'
          }
        }
      }
    }
  });
  app.vueApp.use(vuetify);
  const update = () => {
    vuetify.theme.change(resolved());
    if (typeof document !== 'undefined') document.documentElement.style.colorScheme = resolved();
  };
  const changed = (event: Event) => {
    const value = (event as CustomEvent).detail;
    if (['light', 'dark', 'system'].includes(value)) {
      appearance = value;
      update();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('coremx-appearance', changed);
    media?.addEventListener('change', update);
    update();
    app.vueApp.onUnmount(() => {
      window.removeEventListener('coremx-appearance', changed);
      media?.removeEventListener('change', update);
    });
  }
});
