// Rewrites the single-file build for hosts that supply their own document
// wrapper: keeps the title, font links, styles, scripts and body content, and
// drops the <!doctype>/<html>/<head>/<body> shell.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(HERE, '..', 'dist-single', 'index.html');
const out = process.argv[2] || path.join(HERE, '..', 'dist-single', 'artifact.html');

const html = fs.readFileSync(src, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';

const keptHead = head
  .replace(/<meta\s+charset=[^>]*>/gi, '')
  .replace(/<meta\s+name="viewport"[^>]*>/gi, '')
  .replace(/<link\s+rel="icon"[^>]*>/gi, '')
  .trim();

fs.writeFileSync(out, `${keptHead}\n${body.trim()}\n`);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
