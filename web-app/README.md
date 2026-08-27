# InvoiceGuard console

The MVP: upload an invoice plus the known-good payment details, get a verdict
and see exactly which rule fired and why.

Everything runs in the browser — pdf.js parses the file client-side, so an
invoice under review never leaves the reviewer's machine. That matters for a
bank demo: no upload endpoint, no retention question, no data agreement.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 23 engine tests
npm run build    # -> dist/
```

## Is a known-good invoice mandatory?

Yes — known-good details are, in one of two forms. This was measured rather
than assumed, against the bundled forgery:

| Known-good input | Checks that run | Score | Verdict |
|---|---|---|---|
| Nothing | 27 of 50 | 28 | Review only — **the forgery gets through** |
| Bank details typed in | 33–36 of 50 | 90 | Block |
| A known-good invoice | 48 of 50 | 100 | Block |

A competent forgery carries a valid ABN, a real BSB correctly paired with its
bank, an exact account-name match and perfect GST arithmetic. Nothing inside
the page contradicts anything else inside the page, so screening it alone
finds nothing decisive. The UI therefore refuses to run until one of the two
known-good inputs is present.

The crude overlay tamper is the exception — it is caught on structure alone,
because the original account is still recoverable underneath the patch. That
is the difference between a forgery and a tamper, and the console reports it
as such.

## The rule ledger

The console shows all 50 checks, not just the ones that fired:

* **triggered** — with the parameter it looked at, the evidence, and the action
* **clear** — it ran and found nothing
* **not run** — with the reason, e.g. *"Needs a known-good reference invoice —
  typed details do not carry this."*

A check that silently does not run is worse than one that fails loudly, which
is why the third state is shown as prominently as the first.

## Layout

```
src/engine/
  reference.js   BSB registry, ABN checksum, editor fingerprints, stage vocabulary
  extract.js     PDF -> fields, geometry and forensic facts (raw bytes + pdf.js)
  catalog.js     all 50 rules, declared as data so the ledger renders itself
  scoring.js     weighted model with per-layer caps -> score, band, decision
  analyze.js     orchestration, known-good normalisation, diff table
src/ui/          console
public/samples/  the de-identified corpus
tests/           23 tests over the same corpus the Python service uses
```

## Deploying to Vercel

The project lives in a subdirectory of this repository, so set the root
directory when importing:

1. Vercel → **Add New… → Project** → import this repository.
2. **Root Directory**: `InvoiceGuard/web-app`.
3. Framework preset is detected as Vite; build `npm run build`, output `dist`.
4. Deploy.

Or from a machine with the CLI:

```bash
cd InvoiceGuard/web-app
npx vercel --prod
```

`vercel.json` already pins the framework, build command, output directory and
security headers, so no further configuration is needed.

## Single-file build

`npm run build:single` emits `dist-single/index.html` — one self-contained
file with the samples inlined and pdf.js parsing on the main thread instead of
in a worker. For hosts that serve a single document and supply their own
`<html>` wrapper, `node scripts/to-artifact.mjs <out.html>` strips the shell.

## Two engines, one rule set

`InvoiceGuard/invoiceguard/` (Python) is the integration-grade engine: it runs
server-side, holds a supplier baseline across the whole loan book, and is where
the mule-account check across unrelated payees belongs. This browser engine is
the reviewer's console. They share rule ids and weights and are tested against
the same corpus, so findings are directly comparable.
