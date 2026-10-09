import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// The Tauri build of the desktop renderer: the same sources as the Electron build
// (electron.vite.config.ts, renderer section) into a separate output directory, so
// both shells can be built side by side while the migration is in flight.
// See docs/tauri-migration-plan.md (P1).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist-tauri/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        'mermaid-sandbox': resolve(__dirname, 'src/renderer/mermaid-sandbox.html')
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true
  }
})
