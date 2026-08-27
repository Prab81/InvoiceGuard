# InvoiceGuard

Screening for redirected and forged supplier invoices presented against
construction loan drawdowns.

Two parts, one rule set:

* **The console** — at the repository root. A browser-only app: drop in an
  invoice plus the known-good payment details and get a verdict, every rule
  that fired with its evidence, and a comparison that explains what each
  difference means. pdf.js parses the file client-side, so an invoice under
  review never leaves the reviewer's machine.
* **The service** — in [`service/`](service). The integration-grade Python
  engine, which holds a supplier baseline across the whole loan book and is
  where the cross-payee mule-account check belongs.

They share rule ids and weights and are tested against the same corpus.

> **The bundled corpus is de-identified.** The builder, ABN, licence number,
> contacts, borrowers and both account numbers are fictional; only the
> structure of the case is real. Do not load a live customer's documents into a
> publicly deployed instance.

---

## The case it is built around

Two invoices from the same builder, on the same letterhead, for the same job,
addressed to the same borrowers. One is genuine. One pays a different bank.

|               | Genuine `INV-101538`         | Forged `INV-101544` |
|---------------|------------------------------|---------------------|
| Bank          | ANZ                          | Commonwealth        |
| BSB / account | 013 006 / 384920175          | 062-000 / 10456213  |
| Account name  | Harrowgate Homes Pty Ltd     | Harrowgate Homes Pty Ltd |
| PDF producer  | Microsoft: Print To PDF      | Pdftools SDK        |
| PDF version   | 1.7                          | 1.4                 |
| Title         | `Invoice INV-101538 (1).pdf` | *(absent)*          |
| Author        | J Mejia                      | *(absent)*          |

Everything a human reviewer normally checks passes on the forgery. The ABN
satisfies the ATO modulus-89 checksum. The BSB is real and correctly paired
with the printed bank name. The account name matches the builder exactly, so
Confirmation of Payee would not have stopped it. The GST arithmetic is exact.
Nothing inside the document contradicts anything else inside the document.

Which is the whole design lesson: **a forged invoice is only detectable against
something outside itself** — the supplier's payment history, their previous
documents, or the file's own structure.


### A second, independent case

The corpus carries two unrelated builders, because the two fraud shapes look
nothing alike.

**Harrowgate Homes** — the forger controls the document only. The invoice is
internally perfect; only the destination account and the file's own structure
give it away.

**Calderwood Constructions** — the attacker also controls the email channel,
which is what supplier-email compromise actually looks like. The forged invoice
carries a reply domain one homoglyph from the real one
(`calderwoodconstructlons.com.au`), the attacker's callback number, terms
compressed from 14 days to 3, urgency wording, and a polite notice announcing
the "new" bank details.

That second case fires four rules the first never touches — `DOC_LOOKALIKE_DOMAIN`,
`DOC_PHONE_CHANGED`, `DOC_TERMS_SHORTENED`, `DOC_URGENCY_LANGUAGE` — and
demonstrates the model's precision from the other side: because the change *is*
announced, `PAY_ACCOUNT_CHANGED_SILENTLY` correctly stands down while the
account change still blocks the drawdown.

---

## Is a known-good invoice mandatory?

Yes — known-good details are, in one of two forms. Measured against the
bundled forgery rather than assumed:

| Known-good input | Checks that run | Score | Verdict |
|---|---|---|---|
| Nothing | 30 of 53 | 28 | Review only — **the forgery gets through** |
| Bank details typed in | 36–39 of 53 | 90 | Block |
| A known-good invoice | 51 of 53 | 100 | Block |

So the console refuses to run until one of the two is present. A reference
invoice runs more checks; typed BSB and account number are enough to block.

The crude overlay tamper is the exception — it scores 100 with no known-good
input at all, because the original account is still recoverable underneath the
patch. Forgery and tamper are different problems, and the console says which
one it found.

---

## What the reviewer sees

* **Verdict** — score, band, the action it implies, and how many of the 50
  checks actually ran.
* **Rules triggered** — each with the parameter it examined, the rule id, the
  evidence, and the action.
* **Full rule ledger** — all 53 checks in three states: triggered, clear, and
  *not run with the reason why*. A check that silently does not run is worse
  than one that fails loudly.
* **Attribute comparison** — grouped by what each attribute is for, separating
  the fields that legitimately differ between two invoices (number, dates,
  amount — shown grey) from the controls a supplier's own template should have
  held constant (shown flagged), each with a plain-English note on why it
  matters.

---

## Typography checks

A forger who retypes a field inside the page's own tool keeps the typeface and
misses the point size. Three checks cover that, all comparing typeface
*families* rather than PostScript names, so a bold total is never an anomaly:

| Check | What it catches |
|---|---|
| `FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK` | the block mixes two families — part of it was retyped |
| `FOR_FONT_SIZE_DRIFT_IN_PAYMENT_BLOCK` | the block mixes two point sizes — the same trick, invisible to a font-name check |
| `FOR_TYPOGRAPHY_OUTLIER_IN_FIGURES` | one amount set differently from every other amount on the page |

The bundled `retyped_INV-101549.pdf` exists to prove the second and third:
its patch is Helvetica throughout, half a point smaller, so the family check
correctly stays silent and only the size checks fire.

`FOR_FONT_DRIFT_IN_PAYMENT_BLOCK` covers the remaining case — the *whole* block
set in a typeface used nowhere else — and is mutually exclusive with the family
check, so a single edit is never counted twice.

---

## Running the console

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 33 engine tests
npm run build    # -> dist/
```

## Deploying to Vercel

The console is at the repository root, so there is nothing to configure:

1. Vercel → **Add New… → Project** → import this repository
2. **Deploy**

Vite is auto-detected. `vercel.json` pins the build command, output directory
and security headers.

Or from a machine with the CLI:

```bash
npx vercel --prod
```

## Running the service

```bash
cd service
./run.sh                              # http://127.0.0.1:8000
./.venv/bin/python -m pytest tests -q  # 30 tests
```

Full rule catalogue, scoring model and limitations: [`service/README.md`](service/README.md).

---

## Layout

```
index.html  vite.config.js  vercel.json     the console (Vercel deploys this)
src/engine/
  reference.js   BSB registry, ABN checksum, editor fingerprints, stage vocabulary
  extract.js     PDF -> fields, geometry and forensic facts (raw bytes + pdf.js)
  catalog.js     all 53 rules, declared as data so the ledger renders itself
  scoring.js     weighted model with per-layer caps -> score, band, decision
  analyze.js     orchestration, known-good normalisation, explained comparison
src/ui/          console
public/samples/  the de-identified corpus, served to the browser
tests/           23 engine tests

service/
  invoiceguard/  the Python engine (same rule ids and weights)
  samples/       corpus generator and baseline seeder
  tests/         20 tests
  web/           the service's own review console
```

The corpus is generated, not committed by hand. `service/samples/make_samples.py`
writes it; copy it across with:

```bash
cp service/samples/*.pdf public/samples/ && node scripts/inline-samples.mjs
```

## Single-file build

`npm run build:single` emits `dist-single/index.html` — one self-contained file
with the samples inlined and pdf.js parsing on the main thread instead of in a
worker. `node scripts/to-artifact.mjs <out.html>` strips the document shell for
hosts that supply their own.
