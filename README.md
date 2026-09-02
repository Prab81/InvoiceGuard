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

## Evidence is optional, the verdict is capped by it

The invoice is the only required input. Everything else is optional and
composes — supply any combination and the checks that can run, run:

| Evidence supplied | Checks that run | Best verdict available |
|---|---|---|
| Invoice only | 30 of 60 | No tampering found — payee unverified |
| + known-good bank details | 39 of 60 | Likely authentic |
| + known-good invoice | 52 of 60 | Likely authentic |
| + building contract | 45 of 60 | Likely authentic |
| + contract and known-good invoice | 59 of 60 | Likely authentic |

**Screening one invoice alone is worth doing.** All the document forensics run —
overlays, hidden text under a patch, typography drift, metadata, arithmetic. The
bundled tamper and retype samples both reach a blocking verdict on the invoice
alone.

**What one document can never tell you is where the money is going.** A faithful
copy of a genuine invoice with only the account changed is clean on every check
a single file can answer — we measured it: it scores 0. So the tool will not say
*likely authentic* without something to check the payee against. It says
**"No tampering found — payee unverified"** instead, and names what it did not
check. A verdict should never imply more assurance than the evidence carries.

After every screening the result states what more would buy:
*"14 more with a known-good invoice · 5 more with known-good bank details ·
6 more with the building contract"* — derived from the reasons the rules
themselves gave, so the hint cannot drift from the engine.

---

### The building contract is the strongest anchor

Every other baseline sits downstream of the channel the attacker compromised: a
reference invoice comes out of the borrower's mailbox, typed details from
someone who may be reading the hijacked thread, a learned account from a payment
that already settled. The executed contract is held by the bank, signed before
the first claim, and the fraudster never sees it — so where the contract and the
payment history disagree, the contract wins.

Seven checks run off it, including the two that reach past redirection into
over-claiming: a claim larger than its stage's share of the contract sum, and a
drawdown that would take the project past the contract sum altogether.

Measured on the adversarial clone: the contract alone blocks it at **100**,
where a known-good invoice reaches **78**.

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

## Exporting an assessment

Every screening can be saved as **Word (.docx)** or **PDF** from the verdict
panel. Both are generated in the browser from one shared report model, so the
two exports of the same assessment can never disagree. The report carries the
verdict, every rule that fired with its evidence and action, the attribute
comparison, the full ledger, both documents' details — and a **Policy in force**
section that states plainly whether the shipped rule set was used unchanged, or
names every check that was switched off, retuned or added.

> Some sandboxed preview hosts silently drop downloads a page starts itself.
> On a normal deployment both buttons download; in a sandboxed preview the app
> says so rather than letting the file appear to vanish.

---

## Settings: tuning the policy

The **Settings** panel lists all 53 checks grouped by layer. For each one you can:

* switch it **on or off** — a disabled check is dropped from the ledger and scores nothing
* change its **severity** and **weight**
* and, at the top, move the **band thresholds** and **layer caps**

Changes apply to the assessment already on screen immediately — no re-upload —
so you can watch the score move as you tune. The policy is saved in the browser
and can be **exported and imported as JSON**, which is what makes it reviewable
and version-controllable rather than a setting someone changed once.

### Adding your own checks

Custom checks are **declarative, not code**: pick a field, a comparison and a
value. That is a deliberate limit — letting a reviewer type JavaScript into a
fraud tool would be a security hole, and it could not run under the page's
content-security policy anyway.

29 fields are exposed (payment instrument, supplier identity, invoice content,
file metadata, page structure) with 13 comparisons including
`differs from the known good`, `matches the pattern` and `is one of`. Between
them they express most policy-style rules — approved producer lists, ABN
allowlists, terms floors, size ceilings.

**What still needs engine work:** anything requiring *new evidence* from the
page rather than a new comparison of evidence already extracted — a new overlay
heuristic, a different typography profile, a new forensic signal. Those are
additions to `src/engine/extract.js` and `catalog.js`, not settings.

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
npm test         # 45 engine tests
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
