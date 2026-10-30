import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Terminal-Bundle (Kommandozeile/TUI): reines Node ohne Electron. Läuft mit Node oder mit dem Electron-Binary (ELECTRON_RUN_AS_NODE=1).
export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  build: {
    ssr: 'cli/entry.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'quorum.mjs', banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  },
  ssr: { noExternal: true },
});
