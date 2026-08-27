# InvoiceGuard

Screening for redirected and forged supplier invoices presented against
construction loan drawdowns.

**Two parts.** [`web-app/`](web-app) is the reviewer's console — a browser-only
MVP where you upload an invoice plus the known-good payment details and see the
verdict and every rule that fired. `invoiceguard/` is the integration-grade
Python service, which holds a supplier baseline across the whole loan book and
is where the cross-payee mule-account check belongs. They share rule ids and
weights and are tested against the same corpus.

Both are built around the shape of a real redirection case: two invoices from
the same builder, on the same letterhead, for the same job, addressed to the
same borrowers. One is genuine. One pays a different bank.

> **The bundled corpus is de-identified.** The builder, ABN, licence number,
> contacts, borrowers and both account numbers are fictional; only the structure
> of the case is real. Do not load a live customer's documents into a publicly
> deployed instance.

|                   | Genuine `INV-101538`         | Forged `INV-101544`   |
|-------------------|------------------------------|-----------------------|
| Bank              | ANZ                          | Commonwealth          |
| BSB / account     | 013 006 / 384920175          | 062-000 / 10456213    |
| Account name      | Harrowgate Homes Pty Ltd        | Harrowgate Homes Pty Ltd |
| PDF producer      | Microsoft: Print To PDF      | Pdftools SDK          |
| PDF version       | 1.7                          | 1.4                   |
| Title             | `Invoice INV-101538 (1).pdf` | *(absent)*            |
| Author            | J Mejia                      | *(absent)*            |
| File size         | 269,474 bytes                | 570,435 bytes         |

Everything a human reviewer normally checks passes on the forgery. The ABN
`53 173 584 802` is a valid ABN — it satisfies the ATO modulus-89 checksum. BSB
`062-000` is a real Commonwealth Bank BSB, correctly paired with the printed
bank name. The account name matches the builder exactly, so Confirmation of
Payee would not have stopped it either. The GST arithmetic is exact. Nothing
inside the document contradicts anything else inside the document.

That is the design lesson this system is built on: **a forged invoice is only
detectable against something outside itself** — the supplier's payment history,
the supplier's previous documents, or the file's own structure. So the engine
runs five layers, and weights the ones a fraudster cannot control the highest.


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

## The five layers

### 1. Payment instrument — *where the money actually goes*
Redirection fraud must change one thing. Every other edit is decoration, which
is why this layer carries the largest weight and the highest cap.

| Code | What it catches |
|---|---|
| `PAY_ACCOUNT_CHANGED` | **critical** — destination differs from every account this supplier has been paid at |
| `PAY_ACCOUNT_SHARED_ACROSS_SUPPLIERS` | **critical** — one account collecting for unrelated payees: a mule account |
| `PAY_MULTIPLE_ACCOUNTS_ON_DOC` | **critical** — more than one BSB in the page objects |
| `PAY_BSB_BANK_MISMATCH` | printed bank name contradicts the BSB registry |
| `PAY_BSB_UNKNOWN` | BSB not allocated to any institution |
| `PAY_ACCOUNT_CHANGED_SILENTLY` | account changed with no change-notice wording — genuine suppliers announce it |
| `PAY_BANK_CHANGED` | receiving institution changed |
| `PAY_NAME_REUSED_WITH_NEW_ACCOUNT` | same account name over a new account number — how a redirect survives a name-only review |
| `PAY_NAME_MISMATCH` | account name does not match the issuing supplier |
| `PAY_ACCOUNT_LENGTH_ODD` | account digits atypical for that institution |
| `PAY_ACCOUNT_VERIFIED_MATCH` | *negative weight* — matches the call-back-verified account on file |

### 2. Document forensics — *evidence of the edit itself*
These do not infer tampering, they show it.

| Code | What it catches |
|---|---|
| `FOR_HIDDEN_TEXT_UNDER_OVERLAY` | **critical** — the original account is still recoverable under the patch |
| `FOR_INVISIBLE_TEXT` | white-on-white text left behind by a replaced field |
| `FOR_OVERLAY_IN_PAYMENT_ZONE` | a shape or image drawn over the payment block |
| `FOR_FONT_DRIFT_IN_PAYMENT_BLOCK` | a typeface used *only* in the block that matters |
| `FOR_INCREMENTAL_UPDATE` | multiple `%%EOF`/xref sections: the file was appended to after saving |
| `FOR_TEXT_ALIGNMENT_ANOMALY` | irregular leading where a machine would hold it constant |
| `FOR_PAGE_FLATTENED` | page rasterised to destroy the evidence an edit leaves |
| `FOR_ANNOTATION_TEXT` | text laid over the page as an annotation |
| `FOR_TEMPLATE_IMAGE_CHANGED` | letterhead artwork no longer byte-matches the supplier's template |

The overlay case needs one non-obvious trick. When a payment block is patched,
the replacement is painted on top of the original at the same coordinates, and
naive text extraction interleaves the two into nonsense:

```
BBaannkk:: A CNoZmmonwealth
BBSSBB:: 001674 0-24422
```

`extract.py` reconstructs the page **once per (font, size) group**, because an
overlay and the text it hides almost never share a typeface. Both layers then
read cleanly, and the one painted last — the one a human sees — is identified by
content-stream position:

```
[Helvetica]          Bank: ANZ  BSB: 013 006  Account: 384920175     <- hidden original
[AAAAAA+DejaVuSans]  Bank: Commonwealth  BSB: 062-000  Account: 10456213   <- overlay
```

### 3. File metadata — *the toolchain, and what it stopped carrying*
Metadata is trivially editable, so nothing here is proof and nothing here is
weighted as proof. Its job is corroboration.

`META_PRODUCER_CHANGED` · `META_EDITOR_FINGERPRINT` (Pdftools SDK, iLovePDF,
Smallpdf, Sejda, PDF24, Foxit, Nitro, Acrobat, Ghostscript, Chromium
print-to-PDF, macOS Quartz, iText, PDFtk) · `META_STRIPPED` ·
`META_AUTHOR_UNKNOWN` · `META_PDF_VERSION_DOWNGRADE` · `META_SIZE_ANOMALY` ·
`META_MODIFIED_AFTER_CREATION` · `META_CREATED_BEFORE_INVOICE_DATE` ·
`META_XMP_SAVE_CHAIN`

### 4. Content & business logic
`DOC_GST_MISMATCH` · `DOC_TOTAL_MISMATCH` · `DOC_AMOUNT_DUE_MISMATCH` ·
`DOC_LINES_DONT_SUM` · `DOC_ABN_INVALID` (offline modulus-89) · `DOC_ABN_CHANGED` ·
`DOC_LICENCE_CHANGED` · `DOC_LOOKALIKE_DOMAIN` (homoglyph + edit distance:
`harrowgatehornes.com.au` vs `harrowgatehomes.com.au`) · `DOC_CONTACT_CHANGED` ·
`DOC_PHONE_CHANGED` · `DOC_DUPLICATE_NUMBER` · `DOC_SEQUENCE_REGRESSION` ·
`DOC_SEQUENCE_VELOCITY_LOW` · `DOC_TERMS_SHORTENED` · `DOC_DUE_BEFORE_ISSUE` ·
`DOC_STAGE_ALREADY_CLAIMED` · `DOC_STAGE_SKIPPED` · `DOC_URGENCY_LANGUAGE`

The construction-specific rules matter here: progress claims follow a
contracted stage order (deposit → site works → base/slab → frame → lock-up →
fixing → completion). A claim that repeats a stage, or skips one, is checked
against what has already been drawn on the file.

### 5. Differential — *this document against a known-good one*
The mode that needs **no history at all**. Everything a supplier's template
holds constant between invoices becomes a control:

`CMP_PAYMENT_CHANGED` · `CMP_PRODUCER_CHANGED` · `CMP_METADATA_STRIPPED` ·
`CMP_SIZE_DIVERGENCE` · `CMP_LOGO_REENCODED` · `CMP_FONT_SET_CHANGED` ·
`CMP_TEMPLATE_GEOMETRY_DRIFT` · `CMP_CONTACT_CHANGED`

---

## Scoring

Additive with per-layer caps, then severity overrides.

```
payment 62 · forensics 55 · document 40 · metadata 30 · compare 30   (caps)
```

* **Caps** stop a document being condemned by metadata trivia alone. The
  payment layer keeps the largest cap because it is the one layer a fraudster
  must trip.
* **Severity overrides the arithmetic.** One `critical` finding forces at least
  78 — findings at that level are categorical, not cumulative.
* **Negative weights exist.** A call-back-verified account match subtracts, so
  a clean invoice actually scores clean rather than merely low.
* **Confidence is reported separately from score.** With no supplier history
  the engine says so instead of quietly returning a comfortable number.

| Score | Band | Action |
|---|---|---|
| 75–100 | High risk — block | Do not release. Treat as attempted redirection. |
| 50–74 | Suspicious — hold | Hold the drawdown, verify out-of-band. |
| 25–49 | Review | Human reviewer confirms details independently. |
| 0–24 | Likely authentic | Normal payment controls still apply. |

The score is triage. **The reason codes are the output**, because a held
drawdown has to be explainable to the customer, the broker and AFCA.

---

## Results on the bundled corpus

| Document | Score | Band |
|---|---|---|
| `authentic_INV-101538.pdf` (on file) | 0 | Likely authentic |
| `authentic_INV-101551.pdf` (genuine, never seen) | 0 | Likely authentic |
| `fraudulent_INV-101544.pdf` | 100 | **High risk — block** |
| `tampered_INV-101541.pdf` | 100 | **High risk — block** |
| `fraudulent` vs `authentic`, **zero history** | 78 | **High risk — block** |

The forgery is caught in single-document mode by the account change plus nine
corroborating findings; in comparison mode it is caught with no history at all.

---

## Running it

```bash
cd InvoiceGuard
./run.sh                      # http://127.0.0.1:8000
```

`run.sh` creates the virtualenv, generates the sample corpus, seeds the demo
baseline and starts the server. Then either drop a PDF into **Invoice under
review**, add a second PDF as **Known-good reference** for comparison mode, or
click one of the bundled test documents.

```bash
./.venv/bin/python -m pytest tests -q     # 20 tests
./.venv/bin/python samples/make_samples.py   # regenerate the corpus
./.venv/bin/python samples/seed_baseline.py  # reset the demo history
```

### API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/analyze` | `invoice` (+ optional `reference`, `supplier_hint`) → full assessment |
| `POST` | `/api/analyze/sample` | screen a bundled sample by name |
| `GET` | `/api/baselines` | supplier baselines on file |
| `POST` | `/api/baselines/accept` | record a document as genuine; `verified=true` marks the account call-back confirmed |
| `POST` | `/api/baselines/seed` | load the demo history |
| `DELETE` | `/api/baselines` | clear |
| `GET` | `/api/health` | liveness |

---

## Layout

```
invoiceguard/
  extract.py     PDF -> fields + geometry + forensic facts (3 readers: raw bytes, pypdf, pdfplumber)
  reference.py   BSB registry, ABN checksum, editor fingerprints, stage vocabulary
  baseline.py    supplier baselines + the portfolio-wide payee-account ledger
  rules/         payment · forensics · metadata · document · compare
  scoring.py     weighted model -> score, band, decision, confidence
  analyzer.py    orchestration
  api.py         FastAPI
web/             single-page console
samples/         corpus generator + baseline seeder
tests/           20 tests
```

---

## What this does not do

Stated plainly, because a fraud control that oversells itself is worse than none.

* **The letterhead is usually an image.** Supplier identity is read from the
  text layer — account name, then any company-suffixed entity, then the header
  lines. When a logo carries the only instance of the trading name, the API
  takes a `supplier_hint`, and production needs OCR over the header region.
* **The BSB table is a working subset**, not the full AusPayNet directory (which
  is published fortnightly). `reference.py` keeps the same shape so swapping the
  source is a one-function change. ABN validation is the offline checksum only;
  it does not confirm the ABN belongs to this entity or that it was
  GST-registered on the invoice date — that needs the ABR web service.
* **Metadata proves nothing on its own.** An attacker who sets `/Producer` to
  `Microsoft: Print To PDF` defeats layer 3 entirely. It is weighted as
  corroboration and capped at 30 for exactly that reason.
* **No delivery-channel signals.** The strongest real-world indicator of a
  hijacked invoice is in the email that carried it — SPF/DKIM/DMARC results,
  reply-to divergence, a display name that does not match the sending domain,
  a thread that changed sender mid-conversation. Those live at the mail gateway
  and should feed the same scorer as an additional layer.
* **The baseline is a JSON file.** It stands in for what a bank already has:
  payee master data and a settled-payments ledger. `BaselineStore`'s interface
  (`get_supplier`, `observe`, `suppliers_for_account`) is what production would
  put in front of those.
* **It does not decide.** It triages, and it hands a reviewer the evidence.

## Where it goes next

1. **Wire the account ledger to the whole book.** The mule-account check
   (`PAY_ACCOUNT_SHARED_ACROSS_SUPPLIERS`) is worth more than everything else
   combined once it runs across every payee the bank pays, not one JSON file.
   One account collecting for two unrelated builders is close to conclusive.
2. **Ingest at the loan-origination system and the mail gateway**, not at a
   console. Screening should happen when the claim arrives, before a human has
   formed a view.
3. **Confirmation of Payee on the new account, always** — but note what the
   case above shows: the forger kept the account *name* identical, so a name
   check alone clears it. The control that works is a call-back to the number in
   the building contract, never a number on the invoice.
4. **Feed analyst dispositions back as labels.** After a few thousand
   adjudicated cases, a gradient-boosted model over these same features can take
   over the weighting. Keep the rules underneath: they give day-one coverage on
   patterns with no training data, and they give the explanation the score
   cannot.
