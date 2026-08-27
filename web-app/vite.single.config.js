// Builds one self-contained HTML file: no separate worker, no fetched samples.
// Used for hosting contexts that only accept a single document.
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  publicDir: false,
  define: { __SINGLE_FILE__: 'true' },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 8000,
  },
});
