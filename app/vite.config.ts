import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import website from '../website/vite.config';

/**
 * The app is the website's editor, built from the website's own source, with
 * one module swapped: `#platform`, which in the app saves files with the
 * phone's file system and share sheet instead of a browser download.
 */
export default mergeConfig(
  website,
  defineConfig({
    root: fileURLToPath(new URL('../website', import.meta.url)),
    resolve: {
      alias: { '#platform': fileURLToPath(new URL('./src/platform.ts', import.meta.url)) },
    },
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
    },
  }),
);
