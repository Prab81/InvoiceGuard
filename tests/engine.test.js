// Engine tests. Run: npm test
//
// These use the same generated corpus as the Python service, so the two
// implementations can be compared directly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extract, setPdfjs, parseDate, fontFamily } from '../src/engine/extract.js';
import { analyze, knownGoodFromDetails, knownGoodFromReference } from '../src/engine/analyze.js';
import { RULES } from '../src/engine/catalog.js';
import { score } from '../src/engine/scoring.js';
import { lookupBsb, validateAbn, canonicalBankName, matchEditorFingerprint } from '../src/engine/reference.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, '..', 'public', 'samples');

const KNOWN_GOOD_DETAILS = {
  bank: 'ANZ', bsb: '013 006', account: '384920175',
  accountName: 'Harrowgate Homes Pty Ltd', abn: '53 173 584 802',
  email: 'accounts@harrowgatehomes.com.au', phone: '0491 570 110',
};

const docs = {};
const load = (name) => extract(new Uint8Array(fs.readFileSync(path.join(SAMPLES, name))), name);

before(async () => {
  setPdfjs(pdfjs);
  docs.genuine = await load('authentic_INV-101538.pdf');
  docs.genuineNew = await load('authentic_INV-101551.pdf');
  docs.forged = await load('fraudulent_INV-101544.pdf');
  docs.tampered = await load('tampered_INV-101541.pdf');
  docs.cwGenuine = await load('authentic_INV-2291.pdf');
  docs.cwForged = await load('fraudulent_INV-2304.pdf');
  docs.retyped = await load('retyped_INV-101549.pdf');
});

const firedIds = (r) => r.ledger.filter((e) => e.status === 'triggered').map((e) => e.id);

/* ------------------------------------------------------------ reference */
test('ABN checksum accepts the real ABN and rejects a mutated one', () => {
  assert.equal(validateAbn('53 173 584 802'), true);
  assert.equal(validateAbn('98 479 906 917'), false);
  assert.equal(validateAbn('1234'), false);
});

test('BSB registry resolves both banks in the case', () => {
  assert.match(lookupBsb('013 006').institution, /Australia and New Zealand/);
  assert.equal(lookupBsb('062-000').institution, 'Commonwealth Bank of Australia');
  assert.equal(lookupBsb('999-999').known, false);
});

test('printed bank names resolve to the registry name', () => {
  assert.equal(canonicalBankName('ANZ'), lookupBsb('013006').institution);
  assert.equal(canonicalBankName('Commonwealth'), lookupBsb('062000').institution);
});

test('editor fingerprints catch re-render tooling but not accounting exports', () => {
  assert.match(matchEditorFingerprint('Pdftools SDK', '').label, /Pdftools/);
  assert.equal(matchEditorFingerprint('iLovePDF', '').label, 'iLovePDF');
  assert.equal(matchEditorFingerprint('Microsoft: Print To PDF', ''), null);
});

test('Australian dates parse day-first', () => {
  assert.equal(parseDate('05 Nov 2025'), '2025-11-05');
  assert.equal(parseDate('24/02/2026'), '2026-02-24');
  assert.equal(parseDate('nope'), null);
});

/* ----------------------------------------------------------- extraction */
test('fields are read from the genuine invoice', () => {
  const d = docs.genuine;
  assert.equal(d.supplierAbn, '53 173 584 802');
  assert.equal(d.payment.bsb, '013006');
  assert.equal(d.payment.accountNumber, '384920175');
  assert.equal(d.payment.bankPrinted, 'ANZ');
  assert.equal(d.invoiceNumber, 'INV-101538');
  assert.equal(d.invoiceDate, '2025-11-05');
  assert.equal(d.amountDue, 23750);
  assert.equal(d.meta.author, 'J Mejia');
});

test('an ABN printed in 3-3-3 groups is not mistaken for a BSB', () => {
  assert.deepEqual(docs.genuine.layout.allBsbMatches, ['013006']);
});

test('an overlay tamper yields both accounts, and the visible one wins', () => {
  const d = docs.tampered;
  assert.deepEqual([...d.layout.allBsbMatches].sort(), ['013006', '062000']);
  assert.equal(d.payment.bsb, '062000');
  assert.equal(d.payment.accountNumber, '10456213');
  assert.ok(d.layout.coveredSnippets.length, 'the covered original was not recovered');
  assert.ok(d.layout.overprintRatio > 0.02);
});

test('real typeface names are resolved, so fonts compare across documents', () => {
  assert.ok(docs.genuine.layout.bodyFonts.includes('Helvetica'));
  assert.ok(docs.tampered.layout.paymentBlockFonts.some((f) => /DejaVu/.test(f)));
});

/* -------------------------------------------------------------- verdicts */
test('the forgery is blocked when known-good bank details are typed in', () => {
  const r = analyze({ subject: docs.forged, details: KNOWN_GOOD_DETAILS });
  assert.equal(r.risk.band, 'high_risk');
  assert.ok(firedIds(r).includes('PAY_ACCOUNT_CHANGED'));
  assert.ok(firedIds(r).includes('PAY_BANK_CHANGED'));
});

test('the forgery is blocked when a known-good invoice is supplied', () => {
  const r = analyze({ subject: docs.forged, reference: docs.genuine });
  assert.equal(r.risk.band, 'high_risk');
  const fired = firedIds(r);
  for (const id of ['PAY_ACCOUNT_CHANGED', 'META_PRODUCER_CHANGED', 'META_STRIPPED', 'FOR_TEMPLATE_IMAGE_CHANGED']) {
    assert.ok(fired.includes(id), `${id} did not fire`);
  }
});

test('a reference invoice runs more checks than typed details', () => {
  const withRef = analyze({ subject: docs.forged, reference: docs.genuine });
  const withDetails = analyze({ subject: docs.forged, details: KNOWN_GOOD_DETAILS });
  assert.ok(withRef.coverage.ran > withDetails.coverage.ran);
  assert.equal(withRef.coverage.total, RULES.length);
});

test('without known-good input the forgery is NOT caught - which is why it is mandatory', () => {
  const r = analyze({ subject: docs.forged });
  assert.notEqual(r.risk.band, 'high_risk');
  assert.equal(r.risk.confidence.level, 'limited');
  assert.ok(r.notices.some((n) => /strongest check/.test(n.text)));
});

test('the crude overlay tamper is caught on structure alone', () => {
  const r = analyze({ subject: docs.tampered });
  assert.equal(r.risk.band, 'high_risk');
  const fired = firedIds(r);
  for (const id of ['FOR_HIDDEN_TEXT_UNDER_OVERLAY', 'PAY_MULTIPLE_ACCOUNTS_ON_DOC', 'FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK']) {
    assert.ok(fired.includes(id), `${id} did not fire`);
  }
});

test('a genuine invoice scores zero in every input mode', () => {
  for (const opts of [{}, { details: KNOWN_GOOD_DETAILS }, { reference: docs.genuine }]) {
    const r = analyze({ subject: docs.genuineNew, ...opts });
    assert.equal(r.risk.band, 'likely_authentic', JSON.stringify(r.risk.topReasons));
    assert.equal(r.risk.score, 0);
  }
});

test('re-screening the same file against itself does not report a duplicate', () => {
  const r = analyze({ subject: docs.genuine, reference: docs.genuine });
  assert.ok(!firedIds(r).includes('DOC_DUPLICATE_NUMBER'));
  assert.ok(r.notices.some((n) => /same file was supplied twice/.test(n.text)));
});

/* --------------------------------------------------------------- ledger */
test('every rule reports a status, and skipped rules say why', () => {
  const r = analyze({ subject: docs.forged, details: KNOWN_GOOD_DETAILS });
  assert.equal(r.ledger.length, RULES.length);
  for (const e of r.ledger) {
    assert.ok(['triggered', 'clear', 'skipped'].includes(e.status));
    if (e.status === 'skipped') assert.ok(e.reason && e.reason.length > 10, `${e.id} skipped with no reason`);
    if (e.status === 'triggered') assert.ok(e.evidence && e.evidence.length > 10, `${e.id} fired with no evidence`);
    assert.ok(e.parameter, `${e.id} has no parameter description`);
  }
  assert.equal(r.coverage.triggered + r.coverage.clear + r.coverage.skipped, RULES.length);
});

test('rule ids are unique', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ---------------------------------------------------------- known good */
test('typed details and a reference invoice both produce a usable baseline', () => {
  const fromDetails = knownGoodFromDetails(KNOWN_GOOD_DETAILS);
  const fromRef = knownGoodFromReference(docs.genuine);
  assert.deepEqual(fromDetails.accounts[0], { bsb: '013006', account: '384920175', bank: 'ANZ' });
  assert.deepEqual(fromRef.accounts[0], { bsb: '013006', account: '384920175', bank: 'ANZ' });
  assert.equal(fromRef.producers[0], 'Microsoft: Print To PDF');
});

/* --------------------------------------------------------- score model */
test('one critical finding forces a block regardless of the total', () => {
  const r = score([{ layer: 'payment', severity: 'critical', weight: 1 }], { hasKnownGood: true });
  assert.equal(r.band, 'high_risk');
});

test('layer caps stop metadata alone from blocking a payment', () => {
  const noise = Array.from({ length: 10 }, () => ({ layer: 'metadata', severity: 'medium', weight: 12 }));
  const r = score(noise, { hasKnownGood: true });
  assert.equal(r.layerScores.metadata, 30);
  assert.notEqual(r.band, 'high_risk');
});

test('a verified account match pulls the score to zero', () => {
  const r = score([
    { layer: 'payment', severity: 'info', weight: -12 },
    { layer: 'metadata', severity: 'low', weight: 5 },
  ], { hasKnownGood: true });
  assert.equal(r.score, 0);
});

/* ------------------------------------------------------------ resilience */
test('a non-PDF is reported, not thrown', async () => {
  const junk = new Uint8Array(Buffer.from('this is not a pdf at all'));
  const d = await extract(junk, 'junk.txt');
  assert.ok(d.warnings.length);
  const r = analyze({ subject: d, details: KNOWN_GOOD_DETAILS });
  assert.equal(r.ledger.length, RULES.length);
});


/* ------------------------------------------- second case: email compromise */
test('the email-compromise forgery fires the channel rules the first case never touches', () => {
  const r = analyze({ subject: docs.cwForged, reference: docs.cwGenuine });
  assert.equal(r.risk.band, 'high_risk');
  const fired = firedIds(r);
  for (const id of ['PAY_ACCOUNT_CHANGED', 'DOC_LOOKALIKE_DOMAIN', 'DOC_PHONE_CHANGED',
                    'DOC_TERMS_SHORTENED', 'DOC_URGENCY_LANGUAGE']) {
    assert.ok(fired.includes(id), `${id} did not fire`);
  }
});

test('an announced bank change suppresses the silent-change finding but not the block', () => {
  // The forgery politely says "our banking details have changed", which is what
  // a real supplier-email compromise does. The account-change rule must still
  // fire; only the silent-change corroboration should stand down.
  const r = analyze({ subject: docs.cwForged, reference: docs.cwGenuine });
  const fired = firedIds(r);
  assert.ok(fired.includes('PAY_ACCOUNT_CHANGED'));
  assert.ok(!fired.includes('PAY_ACCOUNT_CHANGED_SILENTLY'));
  assert.equal(r.risk.band, 'high_risk');
});

test('the second case is a different supplier with its own valid ABN', () => {
  assert.equal(docs.cwGenuine.supplierName, 'Calderwood Constructions Pty Ltd');
  assert.ok(validateAbn(docs.cwGenuine.supplierAbn));
  assert.notEqual(docs.cwGenuine.supplierAbn, docs.genuine.supplierAbn);
  assert.notEqual(docs.cwGenuine.payment.bsb, docs.genuine.payment.bsb);
});

test('the genuine second-case invoice is clean against its own known good', () => {
  const r = analyze({ subject: docs.cwGenuine, reference: docs.cwGenuine });
  assert.equal(r.risk.band, 'likely_authentic');
  assert.equal(r.risk.score, 0);
});

test('comparing across the two unrelated suppliers is flagged, not scored', () => {
  const r = analyze({ subject: docs.cwForged, reference: docs.genuine });
  assert.ok(r.notices.some((n) => /not look like the same supplier/.test(n.text)));
});


/* ------------------------------------------------------ typography checks */
test('a patch in the page own typeface is caught on point size alone', () => {
  // The retyped sample keeps Helvetica throughout and only drops half a point,
  // so a check that compares typeface names sees a clean document.
  const t = docs.retyped.layout.typography;
  assert.deepEqual(t.paymentDetailFonts.map((f) => f[0]), ['Helvetica']);
  assert.ok(t.paymentDetailSizes.length > 1, 'the mixed point sizes were not detected');

  const r = analyze({ subject: docs.retyped, reference: docs.genuine });
  const fired = firedIds(r);
  assert.ok(fired.includes('FOR_FONT_SIZE_DRIFT_IN_PAYMENT_BLOCK'));
  assert.ok(!fired.includes('FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK'),
    'the family rule must stay silent - that is the point of this sample');
  assert.equal(r.risk.band, 'high_risk');
});

test('an amount set differently from every other amount is flagged', () => {
  const r = analyze({ subject: docs.retyped, reference: docs.genuine });
  const hit = r.ledger.find((e) => e.id === 'FOR_TYPOGRAPHY_OUTLIER_IN_FIGURES');
  assert.equal(hit.status, 'triggered');
  assert.match(hit.evidence, /52,000\.00/);
});

test('a bold total is not a typography anomaly', () => {
  // Genuine templates set the total in bold. Comparing families rather than
  // full PostScript names is what stops that being a finding.
  for (const doc of [docs.genuine, docs.genuineNew, docs.cwGenuine]) {
    assert.equal(doc.layout.typography.figureOutliers.length, 0, doc.filename);
  }
});

test('font families ignore subset prefixes and weight suffixes', () => {
  assert.equal(fontFamily('AAAAAA+DejaVuSans-Bold'), 'DejaVuSans');
  assert.equal(fontFamily('Helvetica-Bold'), 'Helvetica');
  assert.equal(fontFamily('Helvetica'), 'Helvetica');
});

test('the two payment-block font rules never both fire', () => {
  for (const doc of Object.values(docs)) {
    const fired = firedIds(analyze({ subject: doc, reference: docs.genuine }));
    const both = fired.includes('FOR_FONT_DRIFT_IN_PAYMENT_BLOCK')
      && fired.includes('FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK');
    assert.ok(!both, `${doc.filename} double-counted the block font finding`);
  }
});
