import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// root = src so that popup.html is emitted as dist/popup/popup.html with relative asset URLs.
export default defineConfig(({ mode }) => ({
  root: 'src',
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    minify: mode !== 'development',
    sourcemap: mode === 'development',
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash:8].js',
        assetFileNames: 'assets/[name]-[hash:8][extname]',
      },
    },
  },
}));
