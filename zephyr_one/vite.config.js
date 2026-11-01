import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';

const host = process.env.ELECTRON_DEV_HOST || false;

/* Keep the launch shell and product on the exact same theme/menu source.
 * Vite copies these into dist for release and serves them during development;
 * no HTTP core needs to be running for the first frame to have the right UI. */
function sharedNativeUi() {
  return {
    name: 'zephyr-shared-native-ui',
    buildStart() {
      const destination = resolve(__dirname, 'public');
      mkdirSync(destination, { recursive: true });
      for (const file of ['native-ui.css', 'native-ui.js']) {
        cpSync(resolve(__dirname, '../public', file), resolve(destination, file));
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  root: '.',
  publicDir: 'public',
  plugins: [sharedNativeUi()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', port: 1421 }
      : undefined,
  },
  envPrefix: ['VITE_', 'ELECTRON_'],
  base: './',
  build: {
    // Electron 37 embeds Chromium 138 on every desktop platform.
    target: 'chrome138',
    minify: process.env.ELECTRON_DEV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.ELECTRON_DEV_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
