// Stands in for the report renderers in the single-file build.
//
// Sandboxed preview hosts block downloads a page starts itself, so shipping
// ~450 kB of document toolkit into that build buys a button that cannot work.
// The console keeps the buttons and says where the exports do work.

const message = 'Report export is only available in the deployed app — '
  + 'this preview build leaves the document renderers out and blocks downloads.';

export function buildDocx() { throw new Error(message); }
export function buildPdf() { throw new Error(message); }
