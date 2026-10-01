import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the build can be hosted from any sub-path
  // (GitHub Pages, a CDN folder, or opened from disk via a static server).
  base: './',
  build: {
    rollupOptions: {
      output: {
        // pdf.js ships its worker as .mjs, and static hosts that do not know
        // that extension serve it as application/octet-stream, which a browser
        // then refuses to run as a module. Emit it as .js so it works
        // wherever the site is put.
        assetFileNames: (asset: { names?: string[]; name?: string }) => {
          const name = asset.names?.[0] ?? asset.name ?? '';
          return name.endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
