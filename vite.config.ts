import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron/simple';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        // Zweiter Einstiegspunkt: Worker-Thread für die Nutzungsauswertung (dist-electron/usage-worker.js).
        entry: { main: 'electron/main.ts', 'usage-worker': 'electron/usage-worker.ts' },
        vite: {
          // Gebündelte CommonJS-Abhängigkeiten brauchen `require` im ESM-Hauptprozess.
          build: { rollupOptions: { output: { banner: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } } },
        },
        onstart({ startup }) {
          return startup(['.', '--no-sandbox']);
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: { rollupOptions: { output: { format: 'es', entryFileNames: 'preload.mjs' } } },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
