// Orchestration: a PDF plus whatever is known to be good, in; a verdict and a
// full rule ledger, out.

import { LAYERS } from './catalog.js';
import { activeRules, bandsFor, capsFor, defaultPolicy, normalisePolicy } from './policy.js';
import { classifyStage, normaliseBsb } from './reference.js';
import { daysBetween } from './extract.js';
import { score, SEVERITY_RANK } from './scoring.js';

/** Everything the rules can compare against, however it was supplied. */
function emptyKnownGood(source) {
  return {
    source,
    accounts: [], accountName: null, abn: null, licence: null,
    emails: [], phones: [], producers: [], creators: [], authors: [],
    title: null, titlePresent: false, pdfVersions: [], byteSize: null,
    imageHashes: [], bodyFonts: [], bsbAnchor: null,
    invoiceNumbers: [], invoiceDates: [], termsDays: [], stages: [],
    supplierName: null, sha256: null,
  };
}

/** Derive known-good facts from a reference invoice the bank accepts as real. */
export function knownGoodFromReference(ref) {
  const kg = emptyKnownGood('reference-invoice');
  if (ref.payment.bsb && ref.payment.accountNumber) {
    kg.accounts.push({ bsb: ref.payment.bsb, account: ref.payment.accountNumber, bank: ref.payment.bankPrinted });
  }
  kg.accountName = ref.payment.accountName;
  kg.abn = ref.supplierAbn;
  kg.licence = ref.supplierLicence;
  kg.supplierName = ref.supplierName;
  kg.sha256 = ref.sha256;
  if (ref.supplierEmail) kg.emails.push(ref.supplierEmail);
  if (ref.supplierPhone) kg.phones.push(ref.supplierPhone);
  if (ref.meta.producer) kg.producers.push(ref.meta.producer.trim());
  if (ref.meta.creator) kg.creators.push(ref.meta.creator.trim());
  if (ref.meta.author) kg.authors.push(ref.meta.author);
  kg.title = ref.meta.title;
  kg.titlePresent = Boolean(ref.meta.title);
  if (ref.meta.pdfVersion) kg.pdfVersions.push(ref.meta.pdfVersion);
  kg.byteSize = ref.byteSize;
  kg.imageHashes = ref.layout.imageHashes || [];
  kg.bodyFonts = ref.layout.bodyFonts || [];
  kg.bsbAnchor = ref.layout.labelAnchors?.BSB || null;
  if (ref.invoiceNumber) kg.invoiceNumbers.push(ref.invoiceNumber);
  if (ref.invoiceDate) kg.invoiceDates.push(ref.invoiceDate);
  if (ref.invoiceDate && ref.dueDate) {
    const terms = daysBetween(ref.invoiceDate, ref.dueDate);
    if (terms != null) kg.termsDays.push(terms);
  }
  for (const li of ref.lineItems) {
    const stage = classifyStage(li.description);
    if (stage && !kg.stages.includes(stage.name)) kg.stages.push(stage.name);
  }
  return kg;
}

/** Derive known-good facts from details a reviewer typed in. */
export function knownGoodFromDetails(details = {}) {
  const kg = emptyKnownGood('entered-details');
  const bsb = normaliseBsb(details.bsb);
  const account = String(details.account || '').replace(/\D/g, '');
  if (bsb && account) kg.accounts.push({ bsb, account, bank: details.bank || null });
  kg.accountName = details.accountName || null;
  kg.abn = details.abn || null;
  kg.licence = details.licence || null;
  kg.supplierName = details.supplierName || null;
  if (details.email) kg.emails.push(String(details.email).trim().toLowerCase());
  if (details.phone) kg.phones.push(String(details.phone).trim());
  if (details.producer) kg.producers.push(String(details.producer).trim());
  if (details.author) kg.authors.push(String(details.author).trim());
  return kg;
}

export function hasAnyKnownGood(kg) {
  if (!kg) return false;
  return Boolean(
    kg.accounts.length || kg.abn || kg.emails.length || kg.phones.length
    || kg.producers.length || kg.authors.length || kg.licence,
  );
}

/**
 * Run every rule in the catalogue and report each one's status.
 * A rule is `triggered`, `clear`, or `skipped` with the reason it could not run.
 */
export function runRules(ctx, rules) {
  const ledger = [];
  const findings = [];
  for (const rule of rules) {
    const entry = {
      id: rule.id,
      title: rule.title,
      parameter: rule.parameter,
      layer: rule.layer,
      layerLabel: LAYERS[rule.layer]?.label || rule.layer,
      custom: Boolean(rule.custom),
      severity: rule.severity,
      weight: rule.weight,
      polarity: rule.polarity || 'risk',
      status: 'clear',
      reason: null,
      evidence: null,
      recommendation: null,
      detail: null,
    };
    const blocked = rule.requires ? rule.requires(ctx) : null;
    if (blocked) {
      entry.status = 'skipped';
      entry.reason = blocked;
      ledger.push(entry);
      continue;
    }
    let hit = null;
    try {
      hit = rule.evaluate(ctx);
    } catch (err) {
      entry.status = 'skipped';
      entry.reason = `The check could not complete: ${err.message}`;
      ledger.push(entry);
      continue;
    }
    if (!hit) { ledger.push(entry); continue; }
    entry.status = 'triggered';
    entry.severity = hit.severity || rule.severity;
    entry.weight = hit.weight ?? rule.weight;
    entry.evidence = hit.evidence;
    entry.recommendation = hit.recommendation || null;
    entry.detail = hit.detail || null;
    ledger.push(entry);
    findings.push(entry);
  }
  return { ledger, findings };
}

/**
 * The attribute-by-attribute comparison shown to the reviewer.
 *
 * Two properties matter for making a verdict understandable:
 *
 * `expected` marks the fields that legitimately differ between any two
 * invoices - the number, the dates, the amount. Flagging those in red would
 * cry wolf and teach the reviewer to ignore the colour. Only the fields a
 * supplier's own template holds constant are treated as controls.
 *
 * `meaning` is the plain-English reason a difference in that field matters. It
 * is shown next to the row, so the answer to "why is this fraudulent?" sits
 * beside the evidence rather than in a separate document.
 */
const DIFF_GROUPS = {
  payment: 'Where the money goes',
  identity: 'Supplier identity',
  invoice: 'Invoice content',
  metadata: 'How the PDF was made',
  forensics: 'How the page was built',
};

const DIFF_ROWS = [
  { group: 'payment', field: 'Account name', get: (d) => d.payment.accountName,
    meaning: 'Held identical over a changed account number is exactly how a redirection survives a name-only review.' },
  { group: 'payment', field: 'Bank', get: (d) => d.payment.bankPrinted,
    meaning: 'The receiving institution changed. An established builder rarely moves banks mid-contract.' },
  { group: 'payment', field: 'BSB', get: (d) => d.payment.bsbPrinted || d.payment.bsb,
    meaning: 'A different BSB is a different bank and branch. This is the field that moves the money.' },
  { group: 'payment', field: 'Account number', get: (d) => d.payment.accountNumber,
    meaning: 'The field the fraud exists to change. Every other edit is decoration around this one.' },

  { group: 'identity', field: 'Supplier', get: (d) => d.supplierName,
    meaning: 'A different trading name on the same template.' },
  { group: 'identity', field: 'ABN', get: (d) => d.supplierAbn,
    meaning: 'A different ABN is a different legal entity, whatever the letterhead says.' },
  { group: 'identity', field: 'Builder licence', get: (d) => d.supplierLicence,
    meaning: 'Check the state building-licence register before accepting a changed number.' },
  { group: 'identity', field: 'Contact email', get: (d) => d.supplierEmail,
    meaning: 'Replies go here. A changed address is how a hijacked email thread stays hijacked.' },
  { group: 'identity', field: 'Contact phone', get: (d) => d.supplierPhone,
    meaning: 'Never call back on a number that arrived with the change. Use the number in the contract.' },

  { group: 'invoice', field: 'Invoice number', get: (d) => d.invoiceNumber, expected: true },
  { group: 'invoice', field: 'Invoice date', get: (d) => d.invoiceDate, expected: true },
  { group: 'invoice', field: 'Due date', get: (d) => d.dueDate, expected: true },
  { group: 'invoice', field: 'Amount due', expected: true,
    get: (d) => (d.amountDue == null ? null : d.amountDue.toLocaleString('en-AU', { minimumFractionDigits: 2 })) },
  { group: 'invoice', field: 'Payment reference note', get: (d) => d.payment.referenceNote,
    meaning: 'Standing template wording. A change here means the block was retyped.' },

  { group: 'metadata', field: 'PDF producer', get: (d) => d.meta.producer,
    meaning: 'The software that wrote the file. A supplier’s billing system does not change between invoices - a re-render through an editor does.' },
  { group: 'metadata', field: 'PDF creator', get: (d) => d.meta.creator,
    meaning: 'The application the document came from before it was written to PDF.' },
  { group: 'metadata', field: 'Document title', get: (d) => d.meta.title,
    meaning: 'Accounting exports name the file. A blank title means an editor stripped the information dictionary.' },
  { group: 'metadata', field: 'Document author', get: (d) => d.meta.author,
    meaning: 'The bookkeeper who issued it. Losing the author points at the same re-render as the missing title.' },
  { group: 'metadata', field: 'PDF version', get: (d) => d.meta.pdfVersion,
    meaning: 'A version that goes backwards means a different generator re-wrote the page, not the same one exporting again.' },
  { group: 'metadata', field: 'File size', get: (d) => `${d.byteSize.toLocaleString()} bytes`,
    meaning: 'The same one-page template at a very different size means the page was re-rasterised or its fonts were re-embedded.' },
  { group: 'metadata', field: 'Created', get: (d) => d.meta.creationDate, expected: true },
  { group: 'metadata', field: 'Modified', get: (d) => d.meta.modDate, expected: true },

  { group: 'forensics', field: 'Incremental saves', get: (d) => String(d.meta.incrementalUpdates),
    meaning: 'Above zero means the file was appended to after it was first written. The earlier revision is still inside it.' },
  { group: 'forensics', field: 'Body fonts', get: (d) => (d.layout.bodyFonts || []).slice(0, 4).join(', '),
    meaning: 'The same template re-exported keeps its typefaces. A different font set means the page was rebuilt from scratch.' },
  { group: 'forensics', field: 'Payment-block fonts', get: (d) => (d.layout.paymentBlockFonts || []).slice(0, 4).join(', '),
    meaning: 'A typeface that appears only in the payment block means those characters were typed in on top of the original.' },
  { group: 'forensics', field: 'Letterhead image', get: (d) => (d.layout.imageHashes || []).slice(0, 2).join(', '),
    meaning: 'One export reuses the same image bytes. A different hash means the logo was re-encoded, so the page was rebuilt rather than re-exported.' },
  { group: 'forensics', field: 'Accounts found in file', get: (d) => (d.layout.allBsbMatches || []).join(', ') || 'one',
    meaning: 'Every BSB found anywhere in the page objects, including any hidden beneath an overlay. Two or more in one file means the original details are still in there, under the replacement.' },
];

export { DIFF_GROUPS };

export function buildDiff(subject, reference) {
  return DIFF_ROWS.map(({ field, group, get, meaning, expected }) => {
    const a = get(reference) ?? null;
    const b = get(subject) ?? null;
    const same = String(a) === String(b);
    return {
      field,
      group,
      groupLabel: DIFF_GROUPS[group],
      reference: a,
      subject: b,
      same,
      expected: Boolean(expected),
      // Only explain a difference that should not have happened.
      meaning: !same && !expected ? meaning || null : null,
    };
  });
}

/**
 * @param {object} subject   extracted invoice under review
 * @param {object|null} reference  extracted known-good invoice, if supplied
 * @param {object|null} details    known-good details typed in, if supplied
 */
export function analyze({ subject, reference = null, details = null, policy = null }) {
  const activePolicy = normalisePolicy(policy || defaultPolicy());
  let knownGood = null;
  if (reference) {
    knownGood = knownGoodFromReference(reference);
  } else if (details) {
    const kg = knownGoodFromDetails(details);
    if (hasAnyKnownGood(kg)) knownGood = kg;
  }

  const ctx = { doc: subject, ref: reference, knownGood, hasKnownGood: Boolean(knownGood) };
  const { ledger, findings } = runRules(ctx, activeRules(activePolicy));
  const risk = score(findings, {
    hasKnownGood: Boolean(knownGood?.accounts?.length),
    parseWarnings: subject.warnings.length,
    caps: capsFor(activePolicy),
    bands: bandsFor(activePolicy),
  });

  const coverage = {
    total: ledger.length,
    triggered: ledger.filter((e) => e.status === 'triggered').length,
    clear: ledger.filter((e) => e.status === 'clear').length,
    skipped: ledger.filter((e) => e.status === 'skipped').length,
  };
  coverage.ran = coverage.triggered + coverage.clear;

  const notices = [];
  if (reference) {
    const sameParty =
      (subject.supplierAbn && reference.supplierAbn
        && subject.supplierAbn.replace(/\D/g, '') === reference.supplierAbn.replace(/\D/g, ''))
      || (subject.supplierName && reference.supplierName
        && subject.supplierName.toLowerCase() === reference.supplierName.toLowerCase());
    if (!sameParty) {
      notices.push({
        kind: 'warning',
        text: `The two documents do not look like the same supplier - reference "${reference.supplierName || 'unknown'}" `
          + `vs "${subject.supplierName || 'unknown'}". Template comparisons across different issuers are not meaningful.`,
      });
    }
    if (reference.sha256 === subject.sha256) {
      notices.push({ kind: 'warning', text: 'The same file was supplied twice, so the comparison has nothing to compare.' });
    }
  }
  if (!knownGood) {
    notices.push({
      kind: 'info',
      text: 'No known-good details were supplied, so the strongest check - has this supplier ever been paid at this account - could not run. '
        + 'The verdict below rests on the document’s own structure and content.',
    });
  }

  ledger.sort((a, b) => {
    const rank = (e) => (e.status === 'triggered' ? 0 : e.status === 'clear' ? 1 : 2);
    return rank(a) - rank(b)
      || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || b.weight - a.weight;
  });

  return {
    risk,
    policy: activePolicy,
    ledger,
    coverage,
    notices,
    knownGood,
    subject,
    reference,
    diff: reference ? buildDiff(subject, reference) : null,
  };
}
