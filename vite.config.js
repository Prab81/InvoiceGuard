import { defineConfig } from 'vite';

export default defineConfig({
  define: { __SINGLE_FILE__: 'false' },
  // The inlined sample corpus is only for the single-file build; the hosted
  // build serves the same PDFs from /samples, so keep them out of the bundle.
  resolve: { alias: [
    { find: /^html2canvas$/, replacement: '/src/report/optional-stub.js' },
    { find: /^canvg$/, replacement: '/src/report/optional-stub.js' },
    { find: /^dompurify$/, replacement: '/src/report/optional-stub.js' },
{ find: './samples.inline.js', replacement: '/src/ui/samples.stub.js' }] },
  base: './',
  build: {
    // pdf.js is large and ships as one chunk by design; the warning is noise here.
    chunkSizeWarningLimit: 1600,
  },
});
