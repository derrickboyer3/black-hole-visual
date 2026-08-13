import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // three's addons import the bare specifier 'three'; without deduping, dev
  // pre-bundling can hand them a second copy of the library
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three'],
  },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
