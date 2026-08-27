// The rule catalogue.
//
// Every check the engine can make is declared here as data, so the console can
// show all of them - the ones that triggered, the ones that came back clear,
// and the ones that could not run because the input needed was not supplied.
// A rule that silently does not run is worse than one that fails loudly.

import {
  BANK_CHANGE_NOTICE, URGENCY_LANGUAGE, accountDigitRange, canonicalBankName,
  classifyStage, lookupBsb, matchEditorFingerprint, validateAbn,
} from './reference.js';
import { daysBetween, metaDateGapHours } from './extract.js';

export const LAYERS = {
  payment: {
    label: 'Payment instrument',
    blurb: 'Where the money actually goes, checked against the known-good details.',
    cap: 62,
  },
  forensics: {
    label: 'Document forensics',
    blurb: 'Evidence of the edit itself, inside the page structure.',
    cap: 55,
  },
  document: {
    label: 'Content and business logic',
    blurb: 'Arithmetic, identity numbers, contacts, numbering and the stage schedule.',
    cap: 40,
  },
  metadata: {
    label: 'File metadata',
    blurb: 'The toolchain that produced the PDF, and what it stopped carrying.',
    cap: 30,
  },
};

const NEEDS_ACCOUNT = 'Needs known-good bank details (a reference invoice, or the details typed in).';
const NEEDS_REFERENCE = 'Needs a known-good reference invoice - typed details do not carry this.';
const NEEDS_PAYMENT = 'No BSB or account number could be read from this invoice.';

const similarity = (a, b) => {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = (s) => { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const A = bigrams(x), B = bigrams(y);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hits = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i !== -1) { pool.splice(i, 1); hits++; } }
  return (2 * hits) / (A.length + B.length);
};

const HOMOGLYPHS = { 0: 'o', 1: 'l', 5: 's', 3: 'e', 4: 'a' };
const skeleton = (s) => String(s).split('').map((c) => HOMOGLYPHS[c] || c).join('').replace(/rn/g, 'm').replace(/vv/g, 'w');
const lookalike = (a, b) => a !== b && (similarity(a, b) >= 0.8 || skeleton(a) === skeleton(b));
const domainOf = (email) => (email && email.includes('@') ? email.split('@')[1].toLowerCase() : null);
const fmt = (n) => Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/* ====================================================================== */
/* Payment instrument                                                     */
/* ====================================================================== */
const paymentRules = [
  {
    id: 'PAY_NO_INSTRUMENT',
    title: 'No payment instrument on the invoice',
    parameter: 'BSB / account / PayID present',
    layer: 'payment', severity: 'medium', weight: 10,
    evaluate({ doc }) {
      const p = doc.payment;
      if (p.bsb || p.accountNumber || p.payid) return null;
      return {
        evidence: 'Neither a BSB and account pair nor a PayID could be read from this document.',
        recommendation: 'Do not pay from this document. Ask the supplier for a compliant tax invoice.',
      };
    },
  },
  {
    id: 'PAY_BSB_UNKNOWN',
    title: 'BSB is not an allocated Australian BSB',
    parameter: 'BSB against the institution registry',
    layer: 'payment', severity: 'high', weight: 22,
    requires: ({ doc }) => (doc.payment.bsb ? null : NEEDS_PAYMENT),
    evaluate({ doc }) {
      const info = lookupBsb(doc.payment.bsb);
      if (info.known) return null;
      return {
        evidence: `BSB ${doc.payment.bsbPrinted || doc.payment.bsb} does not map to any known Australian institution.`,
        recommendation: 'Reject. A valid Australian invoice quotes an allocated BSB.',
      };
    },
  },
  {
    id: 'PAY_BSB_BANK_MISMATCH',
    title: 'Printed bank name contradicts the BSB',
    parameter: 'Bank name vs BSB institution',
    layer: 'payment', severity: 'high', weight: 26,
    requires: ({ doc }) => (doc.payment.bsb && doc.payment.bankPrinted ? null : 'The invoice does not state both a bank name and a BSB.'),
    evaluate({ doc }) {
      const info = lookupBsb(doc.payment.bsb);
      const printed = canonicalBankName(doc.payment.bankPrinted);
      if (!info.known || !printed || info.institution === printed) return null;
      return {
        evidence: `The invoice says "${doc.payment.bankPrinted}" but BSB ${doc.payment.bsbPrinted} belongs to ${info.institution}.`,
        recommendation: 'Hold payment. A real accounting system does not produce this inconsistency.',
      };
    },
  },
  {
    id: 'PAY_ACCOUNT_LENGTH_ODD',
    title: 'Account number length is atypical for the institution',
    parameter: 'Account digit count vs institution norm',
    layer: 'payment', severity: 'low', weight: 7,
    requires: ({ doc }) => (doc.payment.accountNumber && lookupBsb(doc.payment.bsb).known ? null : NEEDS_PAYMENT),
    evaluate({ doc }) {
      const info = lookupBsb(doc.payment.bsb);
      const [lo, hi] = accountDigitRange(info.institution);
      const n = doc.payment.accountNumber.length;
      if (n >= lo && n <= hi) return null;
      return {
        evidence: `${n} digits quoted; ${info.institution} accounts are normally ${lo}-${hi} digits.`,
        recommendation: 'Confirm the account number with the supplier before release.',
      };
    },
  },
  {
    id: 'PAY_NAME_MISMATCH',
    title: 'Account name does not match the supplier on the invoice',
    parameter: 'Account name vs issuing supplier',
    layer: 'payment', severity: 'high', weight: 20,
    requires: ({ doc }) => (doc.payment.accountName && doc.supplierName ? null : 'The invoice does not state both a supplier and an account name.'),
    evaluate({ doc }) {
      const ratio = similarity(doc.payment.accountName, doc.supplierName);
      if (ratio >= 0.6) return null;
      return {
        evidence: `Invoice issued by "${doc.supplierName}" but funds are directed to "${doc.payment.accountName}".`,
        recommendation: 'Third-party payee. Verify any assignment or factoring paperwork before paying.',
        detail: { similarity: Math.round(ratio * 100) / 100 },
      };
    },
  },
  {
    id: 'PAY_MULTIPLE_ACCOUNTS_ON_DOC',
    title: 'More than one bank account is present in the file',
    parameter: 'Distinct BSBs found in the page objects',
    layer: 'payment', severity: 'critical', weight: 40,
    evaluate({ doc }) {
      const bsbs = doc.layout.allBsbMatches || [];
      if (bsbs.length < 2) return null;
      return {
        evidence: `BSBs found on the page: ${bsbs.join(', ')}. A genuine single-payee invoice carries one.`,
        recommendation: 'Treat as tampered. A second account usually means the original details are still in the file, underneath the replacement.',
        detail: { bsbs },
      };
    },
  },
  {
    id: 'PAY_ACCOUNT_CHANGED',
    title: 'Destination account differs from the known-good account',
    parameter: 'BSB + account number vs known good',
    layer: 'payment', severity: 'critical', weight: 42,
    requires: ({ knownGood, doc }) => {
      if (!knownGood?.accounts?.length) return NEEDS_ACCOUNT;
      if (!doc.payment.bsb || !doc.payment.accountNumber) return NEEDS_PAYMENT;
      return null;
    },
    evaluate({ doc, knownGood }) {
      const p = doc.payment;
      const match = knownGood.accounts.find((a) => a.bsb === p.bsb && a.account === p.accountNumber);
      if (match) return null;
      const good = knownGood.accounts[0];
      return {
        evidence: `This invoice directs payment to ${p.bsbPrinted || p.bsb} / ${p.accountNumber}`
          + `${p.bankPrinted ? ` at ${p.bankPrinted}` : ''}. The known-good account is `
          + `${good.bsb} / ${good.account}${good.bank ? ` at ${good.bank}` : ''}.`,
        recommendation: 'Hold the drawdown. Call the supplier on the number recorded in the building contract - never a number taken from this invoice - and confirm the change before releasing any payment.',
        detail: { presented: { bsb: p.bsb, account: p.accountNumber, bank: p.bankPrinted }, knownGood: good },
      };
    },
  },
  {
    id: 'PAY_ACCOUNT_CHANGED_SILENTLY',
    title: 'Bank details changed with no change notice on the document',
    parameter: 'Change-notice wording when the account moved',
    layer: 'payment', severity: 'high', weight: 16,
    requires: ({ knownGood, doc }) => (knownGood?.accounts?.length && doc.payment.bsb ? null : NEEDS_ACCOUNT),
    evaluate({ doc, knownGood }) {
      const p = doc.payment;
      const changed = !knownGood.accounts.some((a) => a.bsb === p.bsb && a.account === p.accountNumber);
      if (!changed || BANK_CHANGE_NOTICE.test(doc.text)) return null;
      return {
        evidence: 'The account changed but the invoice carries no wording announcing new banking details. Legitimate suppliers almost always flag the change; forgers avoid drawing attention to it.',
        recommendation: 'Adds weight to the account-change finding.',
      };
    },
  },
  {
    id: 'PAY_BANK_CHANGED',
    title: 'Receiving institution changed',
    parameter: 'BSB institution vs known-good institution',
    layer: 'payment', severity: 'high', weight: 14,
    requires: ({ knownGood, doc }) => (knownGood?.accounts?.length && doc.payment.bsb ? null : NEEDS_ACCOUNT),
    evaluate({ doc, knownGood }) {
      const good = knownGood.accounts[0];
      const priorInst = lookupBsb(good.bsb).institution || canonicalBankName(good.bank);
      const nowInst = lookupBsb(doc.payment.bsb).institution;
      if (!priorInst || !nowInst || priorInst === nowInst) return null;
      return {
        evidence: `${priorInst} on file, ${nowInst} on this invoice.`,
        recommendation: 'Changing banks mid-contract is uncommon for an established builder.',
      };
    },
  },
  {
    id: 'PAY_NAME_REUSED_WITH_NEW_ACCOUNT',
    title: 'Account name kept identical over a changed account number',
    parameter: 'Account name held constant while the number moved',
    layer: 'payment', severity: 'medium', weight: 12,
    requires: ({ knownGood, doc }) => (
      knownGood?.accounts?.length && doc.payment.bsb && doc.payment.accountName && knownGood.accountName
        ? null : NEEDS_ACCOUNT),
    evaluate({ doc, knownGood }) {
      const p = doc.payment;
      const changed = !knownGood.accounts.some((a) => a.bsb === p.bsb && a.account === p.accountNumber);
      if (!changed || similarity(p.accountName, knownGood.accountName) <= 0.95) return null;
      return {
        evidence: `Account name "${p.accountName}" is unchanged while the BSB and account pair is new. Keeping the name is how a redirection passes a name-only review.`,
        recommendation: 'Do not rely on the account name. Confirmation of Payee will not clear this: the name is only checked against the destination bank’s record, which a mule account may well match.',
      };
    },
  },
  {
    id: 'PAY_ACCOUNT_MATCHES_KNOWN_GOOD',
    title: 'Destination account matches the known-good account',
    parameter: 'BSB + account number vs known good',
    layer: 'payment', severity: 'info', weight: -12, polarity: 'reassuring',
    requires: ({ knownGood, doc }) => (knownGood?.accounts?.length && doc.payment.bsb && doc.payment.accountNumber ? null : NEEDS_ACCOUNT),
    evaluate({ doc, knownGood }) {
      const p = doc.payment;
      const match = knownGood.accounts.find((a) => a.bsb === p.bsb && a.account === p.accountNumber);
      if (!match) return null;
      return {
        evidence: `Payment is directed to ${match.bsb} / ${match.account}, the account supplied as known good.`,
        recommendation: 'No payment-side action required.',
      };
    },
  },
];

/* ====================================================================== */
/* Document forensics                                                     */
/* ====================================================================== */
const forensicsRules = [
  {
    id: 'FOR_HIDDEN_TEXT_UNDER_OVERLAY',
    title: 'Original payment text is still recoverable underneath an overlay',
    parameter: 'Text covered by an opaque shape in the payment block',
    layer: 'forensics', severity: 'critical', weight: 50,
    evaluate({ doc }) {
      const snippets = doc.layout.coveredSnippets || [];
      if (!snippets.length) return null;
      return {
        evidence: `Text sitting beneath an opaque shape in the payment block: ${snippets.join('  |  ')}`,
        recommendation: 'Conclusive tampering. Preserve the file as evidence, block the drawdown and report it - the covered text is the genuine account.',
        detail: { snippets },
      };
    },
  },
  {
    id: 'FOR_OVERPRINTED_TEXT',
    title: 'Two text layers are painted on top of each other',
    parameter: 'Proportion of glyphs overlapping another glyph',
    layer: 'forensics', severity: 'high', weight: 20,
    evaluate({ doc }) {
      const ratio = doc.layout.overprintRatio || 0;
      if (ratio <= 0.02) return null;
      return {
        evidence: `${(ratio * 100).toFixed(1)}% of text runs sit on top of another run. A single template render never overprints itself.`,
        recommendation: 'The instrument reported above is the layer painted last, which is what a reader sees. The layer underneath is the original.',
      };
    },
  },
  {
    id: 'FOR_OVERLAY_IN_PAYMENT_ZONE',
    title: 'A shape or image is drawn over the payment-details block',
    parameter: 'Painted objects intersecting the payment block',
    layer: 'forensics', severity: 'high', weight: 24,
    requires: ({ doc }) => (doc.layout.paymentBlockBbox ? null : 'The payment block could not be located on the page.'),
    evaluate({ doc }) {
      const overlays = doc.layout.overlays || [];
      if (!overlays.length) return null;
      return {
        evidence: `${overlays.length} object(s) intersect the payment block: `
          + overlays.slice(0, 3).map((o) => `${o.kind} at [${o.bbox.join(', ')}]`).join('; '),
        recommendation: 'Inspect the region visually against a known-good invoice from the same supplier.',
        detail: { overlays: overlays.slice(0, 6) },
      };
    },
  },
  {
    id: 'FOR_FONT_DRIFT_IN_PAYMENT_BLOCK',
    title: 'Payment block uses a typeface found nowhere else on the page',
    parameter: 'Fonts in the payment block vs the rest of the page',
    layer: 'forensics', severity: 'high', weight: 22,
    requires: ({ doc }) => (doc.layout.paymentBlockFonts?.length && doc.layout.bodyFonts?.length
      ? null : 'The payment block could not be separated from the body text.'),
    evaluate({ doc }) {
      const exclusive = doc.layout.paymentBlockFonts.filter((f) => !doc.layout.bodyFonts.includes(f));
      if (!exclusive.length) return null;
      return {
        evidence: `Fonts unique to the payment block: ${exclusive.join(', ')}. Body fonts: ${doc.layout.bodyFonts.slice(0, 4).join(', ')}.`,
        recommendation: 'A single template renders one font set. A separate typeface in exactly the block that matters means those characters were typed in later.',
        detail: { exclusive },
      };
    },
  },
  {
    id: 'FOR_TEXT_ALIGNMENT_ANOMALY',
    title: 'Line spacing inside the payment block is irregular',
    parameter: 'Leading between payment-detail lines',
    layer: 'forensics', severity: 'medium', weight: 12,
    requires: ({ doc }) => (doc.layout.lineGapAnomaly != null ? null : 'Fewer than four payment-detail lines were found to measure.'),
    evaluate({ doc }) {
      if (doc.layout.lineGapAnomaly <= 0.35) return null;
      return {
        evidence: `Largest line-gap deviation is ${(doc.layout.lineGapAnomaly * 100).toFixed(0)}% from the block median. Machine-generated blocks hold a constant leading.`,
      };
    },
  },
  {
    id: 'FOR_INCREMENTAL_UPDATE',
    title: 'File was appended to after it was first saved',
    parameter: 'Count of %%EOF markers and cross-reference sections',
    layer: 'forensics', severity: 'high', weight: 20,
    evaluate({ doc }) {
      if (!doc.meta.incrementalUpdates) return null;
      return {
        evidence: `${doc.meta.eofMarkers} %%EOF markers and ${doc.meta.xrefSections} cross-reference section(s): ${doc.meta.incrementalUpdates} incremental update(s).`,
        recommendation: 'The earlier revision is still inside the file and can be reconstructed. Do that before contacting the supplier.',
      };
    },
  },
  {
    id: 'FOR_PAGE_FLATTENED',
    title: 'Page is a flattened image rather than a text document',
    parameter: 'Selectable text layer present',
    layer: 'forensics', severity: 'medium', weight: 14,
    evaluate({ doc }) {
      if (!doc.layout.fullPageImage) return null;
      return {
        evidence: 'The page carries no usable text layer. Flattening destroys the evidence an edit would otherwise leave, and it is not how an accounting system emits an invoice.',
        recommendation: 'Request the original PDF straight from the supplier’s accounting system.',
      };
    },
  },
  {
    id: 'FOR_TEMPLATE_IMAGE_CHANGED',
    title: 'Letterhead artwork does not byte-match the reference',
    parameter: 'Embedded image stream hashes',
    layer: 'forensics', severity: 'medium', weight: 13,
    requires: ({ knownGood, doc }) => {
      if (!knownGood?.imageHashes?.length) return NEEDS_REFERENCE;
      if (!doc.layout.imageHashes?.length) return 'This invoice embeds no images to compare.';
      return null;
    },
    evaluate({ doc, knownGood }) {
      const shared = doc.layout.imageHashes.filter((h) => knownGood.imageHashes.includes(h));
      if (shared.length) return null;
      return {
        evidence: 'No embedded image is byte-identical to the reference invoice. The same template exported twice reuses the same image stream; a rebuilt page does not.',
        detail: { presented: doc.layout.imageHashes.slice(0, 4), knownGood: knownGood.imageHashes.slice(0, 4) },
      };
    },
  },
  {
    id: 'FOR_FONT_SET_CHANGED',
    title: 'The two documents share no fonts',
    parameter: 'Body font set vs the reference',
    layer: 'forensics', severity: 'medium', weight: 12,
    requires: ({ knownGood, doc }) => (knownGood?.bodyFonts?.length && doc.layout.bodyFonts?.length ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const shared = doc.layout.bodyFonts.filter((f) => knownGood.bodyFonts.includes(f));
      if (shared.length) return null;
      return {
        evidence: `Reference: ${knownGood.bodyFonts.slice(0, 4).join(', ')}. This invoice: ${doc.layout.bodyFonts.slice(0, 4).join(', ')}.`,
        recommendation: 'The same template re-exported keeps its typefaces. A different font set means the page was rebuilt.',
      };
    },
  },
  {
    id: 'FOR_TEMPLATE_GEOMETRY_DRIFT',
    title: 'Payment block sits in a different place on the page',
    parameter: 'Position of the BSB line vs the reference',
    layer: 'forensics', severity: 'medium', weight: 10,
    requires: ({ knownGood, doc }) => (knownGood?.bsbAnchor && doc.layout.labelAnchors?.BSB ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const a = knownGood.bsbAnchor, b = doc.layout.labelAnchors.BSB;
      if (Math.abs(a[0] - b[0]) <= 6) return null;
      return {
        evidence: `BSB label starts at x=${a[0]} in the reference and x=${b[0]} here.`,
      };
    },
  },
];

/* ====================================================================== */
/* Content and business logic                                             */
/* ====================================================================== */
const documentRules = [
  {
    id: 'DOC_GST_MISMATCH',
    title: 'GST is not 10% of the subtotal',
    parameter: 'GST vs subtotal',
    layer: 'document', severity: 'high', weight: 20,
    requires: ({ doc }) => (doc.subtotal != null && doc.gst != null ? null : 'The invoice does not state both a subtotal and a GST amount.'),
    evaluate({ doc }) {
      const expected = Math.round(doc.subtotal * 10) / 100;
      if (Math.abs(expected - doc.gst) <= 0.02) return null;
      return {
        evidence: `Subtotal ${fmt(doc.subtotal)} implies GST ${fmt(expected)}; the invoice states ${fmt(doc.gst)}.`,
        recommendation: 'An edited amount that misses one of the totals leaves exactly this trace.',
      };
    },
  },
  {
    id: 'DOC_TOTAL_MISMATCH',
    title: 'Subtotal plus GST does not equal the invoice total',
    parameter: 'Subtotal + GST vs total',
    layer: 'document', severity: 'high', weight: 22,
    requires: ({ doc }) => (doc.subtotal != null && doc.gst != null && doc.total != null ? null : 'The invoice does not state a subtotal, GST and total.'),
    evaluate({ doc }) {
      if (Math.abs(doc.subtotal + doc.gst - doc.total) <= 0.02) return null;
      return {
        evidence: `${fmt(doc.subtotal)} + ${fmt(doc.gst)} = ${fmt(doc.subtotal + doc.gst)}, but the stated total is ${fmt(doc.total)}.`,
      };
    },
  },
  {
    id: 'DOC_AMOUNT_DUE_MISMATCH',
    title: 'Amount due does not reconcile to total less payments',
    parameter: 'Total - payments vs amount due',
    layer: 'document', severity: 'high', weight: 18,
    requires: ({ doc }) => (doc.total != null && doc.amountDue != null ? null : 'The invoice does not state both a total and an amount due.'),
    evaluate({ doc }) {
      const paid = doc.paymentsApplied || 0;
      if (Math.abs(doc.total - paid - doc.amountDue) <= 0.02) return null;
      return {
        evidence: `Total ${fmt(doc.total)} less payments ${fmt(paid)} = ${fmt(doc.total - paid)}, but the stated amount due is ${fmt(doc.amountDue)}.`,
      };
    },
  },
  {
    id: 'DOC_LINES_DONT_SUM',
    title: 'Line items do not sum to the subtotal',
    parameter: 'Sum of line amounts vs subtotal',
    layer: 'document', severity: 'high', weight: 18,
    requires: ({ doc }) => (doc.lineItems.length && doc.subtotal != null ? null : 'No line items could be read from this invoice.'),
    evaluate({ doc }) {
      const sum = doc.lineItems.reduce((t, li) => t + (li.amount || 0), 0);
      if (!sum || Math.abs(sum - doc.subtotal) <= 0.02) return null;
      return { evidence: `Line items total ${fmt(sum)} against a stated subtotal of ${fmt(doc.subtotal)}.` };
    },
  },
  {
    id: 'DOC_ABN_MISSING',
    title: 'No ABN on the document',
    parameter: 'ABN present',
    layer: 'document', severity: 'medium', weight: 12,
    evaluate({ doc }) {
      if (doc.supplierAbn) return null;
      return { evidence: 'A compliant Australian tax invoice must show the supplier’s ABN.' };
    },
  },
  {
    id: 'DOC_ABN_INVALID',
    title: 'ABN fails the ATO checksum',
    parameter: 'ABN modulus-89 check',
    layer: 'document', severity: 'critical', weight: 30,
    requires: ({ doc }) => (doc.supplierAbn ? null : 'No ABN was found on this invoice.'),
    evaluate({ doc }) {
      if (validateAbn(doc.supplierAbn)) return null;
      return {
        evidence: `ABN ${doc.supplierAbn} is not a valid Australian Business Number.`,
        recommendation: 'Reject: this is not a valid tax invoice and the GST is not claimable.',
      };
    },
  },
  {
    id: 'DOC_ABN_CHANGED',
    title: 'ABN differs from the known-good ABN',
    parameter: 'ABN vs known good',
    layer: 'document', severity: 'critical', weight: 28,
    requires: ({ knownGood, doc }) => (knownGood?.abn && doc.supplierAbn ? null : 'No known-good ABN was supplied.'),
    evaluate({ doc, knownGood }) {
      const norm = (v) => String(v).replace(/\D/g, '');
      if (norm(knownGood.abn) === norm(doc.supplierAbn)) return null;
      return {
        evidence: `Known good ${knownGood.abn}; this invoice ${doc.supplierAbn}.`,
        recommendation: 'Check the ABR for a related entity; otherwise treat this as a different party entirely.',
      };
    },
  },
  {
    id: 'DOC_LICENCE_CHANGED',
    title: 'Builder licence number differs from the known-good licence',
    parameter: 'Licence number vs known good',
    layer: 'document', severity: 'medium', weight: 12,
    requires: ({ knownGood, doc }) => (knownGood?.licence && doc.supplierLicence ? null : 'No known-good licence number was supplied.'),
    evaluate({ doc, knownGood }) {
      if (knownGood.licence === doc.supplierLicence) return null;
      return {
        evidence: `Known good ${knownGood.licence}; this invoice ${doc.supplierLicence}.`,
        recommendation: 'Verify against the state building-licence register.',
      };
    },
  },
  {
    id: 'DOC_LOOKALIKE_DOMAIN',
    title: 'Contact email uses a look-alike domain',
    parameter: 'Email domain vs known good, homoglyph-folded',
    layer: 'document', severity: 'critical', weight: 35,
    requires: ({ knownGood, doc }) => (knownGood?.emails?.length && doc.supplierEmail ? null : 'No known-good email address was supplied.'),
    evaluate({ doc, knownGood }) {
      if (knownGood.emails.includes(doc.supplierEmail)) return null;
      const now = domainOf(doc.supplierEmail);
      const known = [...new Set(knownGood.emails.map(domainOf).filter(Boolean))];
      if (!now || !known.some((d) => lookalike(now, d))) return null;
      return {
        evidence: `"${now}" closely resembles the known domain(s) ${known.join(', ')}.`,
        recommendation: 'Classic thread-hijack setup: any reply goes to the attacker. Escalate, and warn the borrower directly by phone.',
      };
    },
  },
  {
    id: 'DOC_CONTACT_CHANGED',
    title: 'Contact email differs from the known-good address',
    parameter: 'Email address vs known good',
    layer: 'document', severity: 'medium', weight: 12,
    requires: ({ knownGood, doc }) => (knownGood?.emails?.length && doc.supplierEmail ? null : 'No known-good email address was supplied.'),
    evaluate({ doc, knownGood }) {
      if (knownGood.emails.includes(doc.supplierEmail)) return null;
      const now = domainOf(doc.supplierEmail);
      const known = [...new Set(knownGood.emails.map(domainOf).filter(Boolean))];
      if (known.some((d) => lookalike(now, d))) return null; // reported as a look-alike instead
      return { evidence: `Known good: ${knownGood.emails.join(', ')}. This invoice: ${doc.supplierEmail}.` };
    },
  },
  {
    id: 'DOC_PHONE_CHANGED',
    title: 'Contact phone number differs from the known-good number',
    parameter: 'Phone number vs known good',
    layer: 'document', severity: 'high', weight: 16,
    requires: ({ knownGood, doc }) => (knownGood?.phones?.length && doc.supplierPhone ? null : 'No known-good phone number was supplied.'),
    evaluate({ doc, knownGood }) {
      const norm = (v) => String(v).replace(/\D/g, '');
      if (knownGood.phones.some((p) => norm(p) === norm(doc.supplierPhone))) return null;
      return {
        evidence: `Known good: ${knownGood.phones.join(', ')}. This invoice: ${doc.supplierPhone}.`,
        recommendation: 'Never call back on a number printed on the document under review.',
      };
    },
  },
  {
    id: 'DOC_DUE_BEFORE_ISSUE',
    title: 'Due date falls before the invoice date',
    parameter: 'Due date vs invoice date',
    layer: 'document', severity: 'high', weight: 18,
    requires: ({ doc }) => (doc.invoiceDate && doc.dueDate ? null : 'The invoice date or due date could not be read.'),
    evaluate({ doc }) {
      const terms = daysBetween(doc.invoiceDate, doc.dueDate);
      if (terms >= 0) return null;
      return { evidence: `Issued ${doc.invoiceDate}, due ${doc.dueDate}.` };
    },
  },
  {
    id: 'DOC_TERMS_SHORTENED',
    title: 'Payment terms are shorter than the supplier’s norm',
    parameter: 'Days between issue and due date vs known good',
    layer: 'document', severity: 'medium', weight: 10,
    requires: ({ knownGood, doc }) => (knownGood?.termsDays?.length && doc.invoiceDate && doc.dueDate ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const terms = daysBetween(doc.invoiceDate, doc.dueDate);
      const usual = median(knownGood.termsDays);
      if (terms >= usual - 3) return null;
      return {
        evidence: `${terms}-day terms against a usual ${usual} days. Compressed terms reduce the time available to check.`,
      };
    },
  },
  {
    id: 'DOC_DUPLICATE_NUMBER',
    title: 'Invoice number has already been presented',
    parameter: 'Invoice number vs known good',
    layer: 'document', severity: 'high', weight: 25,
    requires: ({ knownGood, doc }) => (knownGood?.invoiceNumbers?.length && doc.invoiceNumber ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      if (!knownGood.invoiceNumbers.includes(doc.invoiceNumber)) return null;
      if (knownGood.sha256 === doc.sha256) return null; // the very same file
      return {
        evidence: `${doc.invoiceNumber} matches an invoice number already presented, on a different file.`,
        recommendation: 'Duplicate presentment. Check whether the original was already paid.',
      };
    },
  },
  {
    id: 'DOC_SEQUENCE_VELOCITY_LOW',
    title: 'Invoice numbering barely advanced over a long gap',
    parameter: 'Number increment vs elapsed days',
    layer: 'document', severity: 'medium', weight: 11,
    requires: ({ knownGood, doc }) => (
      knownGood?.invoiceNumbers?.length && knownGood.invoiceDates?.length && doc.invoiceNumber && doc.invoiceDate
        ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const numeric = (s) => { const m = String(s || '').match(/\d+/g); return m ? +m[m.length - 1] : null; };
      const cur = numeric(doc.invoiceNumber);
      const prev = numeric(knownGood.invoiceNumbers[0]);
      const days = daysBetween(knownGood.invoiceDates[0], doc.invoiceDate);
      if (cur == null || prev == null || days == null) return null;
      const delta = cur - prev;
      if (delta < 0) {
        return {
          evidence: `${doc.invoiceNumber} dated ${doc.invoiceDate} follows number ${prev} dated ${knownGood.invoiceDates[0]}. The sequence runs backwards.`,
          severity: 'medium', weight: 14,
        };
      }
      if (days < 60 || delta > 8 || delta === 0) return null;
      return {
        evidence: `Only ${delta} invoice number(s) issued across ${days} days. An active builder issues many more; a number picked to look plausible often lands close to the last one seen.`,
        detail: { delta, days },
      };
    },
  },
  {
    id: 'DOC_STAGE_ALREADY_CLAIMED',
    title: 'This construction stage has already been claimed',
    parameter: 'Progress-claim stage vs stages already drawn',
    layer: 'document', severity: 'high', weight: 24,
    requires: ({ knownGood, doc }) => (knownGood?.stages?.length && doc.lineItems.length ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const stage = doc.lineItems.map((li) => classifyStage(li.description)).find(Boolean);
      if (!stage || !knownGood.stages.includes(stage.name)) return null;
      if (knownGood.sha256 === doc.sha256) return null;
      return {
        evidence: `Claiming "${stage.name}" when that stage appears in the known-good history (${knownGood.stages.join(', ')}).`,
        recommendation: 'Confirm against the fixed-price contract’s stage schedule before releasing funds.',
      };
    },
  },
  {
    id: 'DOC_URGENCY_LANGUAGE',
    title: 'Document uses pressure language',
    parameter: 'Urgency wording in the body text',
    layer: 'document', severity: 'low', weight: 6,
    evaluate({ doc }) {
      const m = doc.text.match(URGENCY_LANGUAGE);
      if (!m) return null;
      return { evidence: `Matched "${m[0]}". Urgency is used to push a payment past the normal checks.` };
    },
  },
];

/* ====================================================================== */
/* File metadata                                                          */
/* ====================================================================== */
const metadataRules = [
  {
    id: 'META_EDITOR_FINGERPRINT',
    title: 'Produced by a PDF editing or re-rendering tool',
    parameter: 'Producer / Creator against known editor fingerprints',
    layer: 'metadata', severity: 'medium', weight: 13,
    evaluate({ doc }) {
      const hit = matchEditorFingerprint(doc.meta.producer, doc.meta.creator);
      if (!hit) return null;
      return {
        evidence: `Producer/Creator: "${doc.meta.producer || '-'}" / "${doc.meta.creator || '-'}" - ${hit.label}, ${hit.note}.`,
        recommendation: 'Ask the supplier which system issued the invoice, and compare with the answer on file.',
        detail: { tool: hit.label },
      };
    },
  },
  {
    id: 'META_PRODUCER_CHANGED',
    title: 'Produced by different software than the known-good invoice',
    parameter: 'Producer string vs known good',
    layer: 'metadata', severity: 'high', weight: 18,
    requires: ({ knownGood, doc }) => (knownGood?.producers?.length && doc.meta.producer ? null : 'No known-good producer was supplied.'),
    evaluate({ doc, knownGood }) {
      if (knownGood.producers.includes(doc.meta.producer.trim())) return null;
      return {
        evidence: `Known good: ${knownGood.producers.join(', ')}. This document: "${doc.meta.producer}".`,
        recommendation: 'A supplier’s billing system rarely changes between invoices. Weigh alongside the payment findings.',
      };
    },
  },
  {
    id: 'META_PRODUCER_CONSISTENT',
    title: 'Producer matches the known-good toolchain',
    parameter: 'Producer string vs known good',
    layer: 'metadata', severity: 'info', weight: -6, polarity: 'reassuring',
    requires: ({ knownGood, doc }) => (knownGood?.producers?.length && doc.meta.producer ? null : 'No known-good producer was supplied.'),
    evaluate({ doc, knownGood }) {
      if (!knownGood.producers.includes(doc.meta.producer.trim())) return null;
      return { evidence: `"${doc.meta.producer}" matches the software recorded for this supplier.` };
    },
  },
  {
    id: 'META_STRIPPED',
    title: 'Document identity fields were removed',
    parameter: 'Title and Author in the document information dictionary',
    layer: 'metadata', severity: 'high', weight: 15,
    evaluate({ doc, knownGood }) {
      const missing = [];
      if (!doc.meta.title) missing.push('Title');
      if (!doc.meta.author) missing.push('Author');
      if (!missing.length) return null;
      const referenceHad = knownGood?.titlePresent || knownGood?.authors?.length;
      if (!referenceHad) {
        return {
          evidence: `${missing.join(' and ')} absent from the document information dictionary.`,
          severity: 'low', weight: 5,
        };
      }
      return {
        evidence: `${missing.join(' and ')} absent. The known-good invoice carries`
          + `${knownGood.titlePresent ? ` title "${knownGood.title}"` : ''}`
          + `${knownGood.titlePresent && knownGood.authors?.length ? ' and' : ''}`
          + `${knownGood.authors?.length ? ` author ${knownGood.authors.join(', ')}` : ''}.`,
        recommendation: 'Re-rendering a PDF through an editor is the usual cause of a blank info dictionary.',
      };
    },
  },
  {
    id: 'META_AUTHOR_UNKNOWN',
    title: 'Document author is not the known-good author',
    parameter: 'Author vs known good',
    layer: 'metadata', severity: 'medium', weight: 9,
    requires: ({ knownGood, doc }) => (knownGood?.authors?.length && doc.meta.author ? null : 'No known-good author was supplied.'),
    evaluate({ doc, knownGood }) {
      if (knownGood.authors.includes(doc.meta.author)) return null;
      return { evidence: `Author "${doc.meta.author}"; known good: ${knownGood.authors.join(', ')}.` };
    },
  },
  {
    id: 'META_PDF_VERSION_DOWNGRADE',
    title: 'PDF specification version went backwards',
    parameter: 'PDF version vs known good',
    layer: 'metadata', severity: 'medium', weight: 9,
    requires: ({ knownGood, doc }) => (knownGood?.pdfVersions?.length && doc.meta.pdfVersion ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const newest = Math.max(...knownGood.pdfVersions.map(Number).filter((n) => !Number.isNaN(n)));
      const now = Number(doc.meta.pdfVersion);
      if (Number.isNaN(now) || Number.isNaN(newest) || now >= newest) return null;
      return {
        evidence: `The known-good invoice is PDF ${knownGood.pdfVersions.join(', ')}; this one is PDF ${doc.meta.pdfVersion}. A downgrade means the file was re-written by a different generator, not re-exported by the same one.`,
      };
    },
  },
  {
    id: 'META_SIZE_ANOMALY',
    title: 'File size is far from the template norm',
    parameter: 'Bytes per page vs known good',
    layer: 'metadata', severity: 'medium', weight: 11,
    requires: ({ knownGood, doc }) => (knownGood?.byteSize && doc.byteSize && doc.meta.pageCount ? null : NEEDS_REFERENCE),
    evaluate({ doc, knownGood }) {
      const ratio = doc.byteSize / knownGood.byteSize;
      if (ratio < 1.8 && ratio > 0.55) return null;
      return {
        evidence: `${doc.byteSize.toLocaleString()} bytes against a ${knownGood.byteSize.toLocaleString()}-byte reference for the same template (${ratio.toFixed(1)}x). Re-rasterising a page or re-embedding full fonts inflates the file.`,
        detail: { bytes: doc.byteSize, reference: knownGood.byteSize, ratio: Math.round(ratio * 100) / 100 },
      };
    },
  },
  {
    id: 'META_MODIFIED_AFTER_CREATION',
    title: 'Document was modified after it was created',
    parameter: 'ModDate vs CreationDate',
    layer: 'metadata', severity: 'medium', weight: 10,
    requires: ({ doc }) => (metaDateGapHours(doc.meta) != null ? null : 'The file does not carry both a creation and a modification timestamp.'),
    evaluate({ doc }) {
      const gap = metaDateGapHours(doc.meta);
      if (gap <= 0.05) return null;
      return {
        evidence: `ModDate is ${gap.toFixed(1)} hours after CreationDate.`,
        recommendation: 'Accounting exports write both timestamps at once; a gap means a later save.',
      };
    },
  },
  {
    id: 'META_CREATED_BEFORE_INVOICE_DATE',
    title: 'PDF was created before the invoice date printed on it',
    parameter: 'File creation date vs invoice date',
    layer: 'metadata', severity: 'high', weight: 16,
    requires: ({ doc }) => (doc.meta.creationDate && doc.invoiceDate ? null : 'The creation date or the invoice date could not be read.'),
    evaluate({ doc }) {
      const delta = daysBetween(doc.invoiceDate, doc.meta.creationDate.slice(0, 10));
      if (delta == null || delta >= -1) return null;
      return {
        evidence: `File created ${doc.meta.creationDate.slice(0, 10)}, invoice dated ${doc.invoiceDate}.`,
        recommendation: 'A document cannot predate the transaction it records.',
      };
    },
  },
  {
    id: 'META_CREATED_LONG_AFTER_INVOICE_DATE',
    title: 'PDF was created long after the printed invoice date',
    parameter: 'File creation date vs invoice date',
    layer: 'metadata', severity: 'medium', weight: 10,
    requires: ({ doc }) => (doc.meta.creationDate && doc.invoiceDate ? null : 'The creation date or the invoice date could not be read.'),
    evaluate({ doc }) {
      const delta = daysBetween(doc.invoiceDate, doc.meta.creationDate.slice(0, 10));
      if (delta == null || delta <= 45) return null;
      return {
        evidence: `File created ${doc.meta.creationDate.slice(0, 10)}, invoice dated ${doc.invoiceDate} - ${delta} days earlier.`,
        recommendation: 'Consistent with an old invoice being re-issued with edits.',
      };
    },
  },
  {
    id: 'META_XMP_SAVE_CHAIN',
    title: 'XMP metadata records a save or edit chain',
    parameter: 'XMP DocumentID, InstanceID and history events',
    layer: 'metadata', severity: 'medium', weight: 9,
    requires: ({ doc }) => (doc.meta.hasXmp ? null : 'This file carries no XMP metadata packet.'),
    evaluate({ doc }) {
      const m = doc.meta;
      if (!(m.xmpDocumentId && m.xmpInstanceId && m.xmpDocumentId !== m.xmpInstanceId && m.xmpHistoryEvents)) return null;
      return { evidence: `${m.xmpHistoryEvents} recorded history event(s); InstanceID differs from DocumentID.` };
    },
  },
  {
    id: 'META_ENCRYPTED',
    title: 'Document carries encryption or permission flags',
    parameter: 'Encryption dictionary',
    layer: 'metadata', severity: 'low', weight: 4,
    evaluate({ doc }) {
      if (!doc.meta.encrypted) return null;
      return { evidence: 'An owner password or permission flags are set on this file.' };
    },
  },
];

export const RULES = [...paymentRules, ...forensicsRules, ...documentRules, ...metadataRules];
export const RULE_COUNT = RULES.length;
