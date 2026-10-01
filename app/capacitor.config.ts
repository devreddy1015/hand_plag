import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.devreddy1015.handscript',
  appName: 'Handscript',
  // The website's editor, built by this folder's vite.config.ts.
  webDir: 'dist',
  // The editor's own background, so the app does not flash white as it opens in dark mode.
  backgroundColor: '#f4f3ef',
  plugins: {
    SystemBars: {
      // The editor does not draw under the status and navigation bars; keep the page clear of them.
      insetsHandling: 'native',
    },
  },
};

export default config;
