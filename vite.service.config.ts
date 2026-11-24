import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'desktop/service.ts', outDir: 'dist-service', target: 'node24', minify: false,
    rollupOptions: { output: { entryFileNames: 'quorum-service.mjs' } },
  },
  ssr: { noExternal: true },
});
