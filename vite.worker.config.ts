import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'electron/chat-host/worker.ts', outDir: 'dist-electron', emptyOutDir: false, target: 'node24', minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'chat-worker.js', banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  },
  ssr: { noExternal: true },
});
