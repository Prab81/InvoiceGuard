// Orchestration: a PDF plus whatever is known to be good, in; a verdict and a
// full rule ledger, out.

import { RULES, LAYERS } from './catalog.js';
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
export function runRules(ctx) {
  const ledger = [];
  const findings = [];
  for (const rule of RULES) {
    const entry = {
      id: rule.id,
      title: rule.title,
      parameter: rule.parameter,
      layer: rule.layer,
      layerLabel: LAYERS[rule.layer].label,
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

const DIFF_ROWS = [
  ['Supplier', (d) => d.supplierName],
  ['ABN', (d) => d.supplierAbn],
  ['Builder licence', (d) => d.supplierLicence],
  ['Contact email', (d) => d.supplierEmail],
  ['Contact phone', (d) => d.supplierPhone],
  ['Account name', (d) => d.payment.accountName],
  ['Bank', (d) => d.payment.bankPrinted],
  ['BSB', (d) => d.payment.bsbPrinted || d.payment.bsb],
  ['Account number', (d) => d.payment.accountNumber],
  ['Invoice number', (d) => d.invoiceNumber],
  ['Invoice date', (d) => d.invoiceDate],
  ['Due date', (d) => d.dueDate],
  ['Amount due', (d) => (d.amountDue == null ? null : d.amountDue.toLocaleString('en-AU', { minimumFractionDigits: 2 }))],
  ['PDF producer', (d) => d.meta.producer],
  ['PDF creator', (d) => d.meta.creator],
  ['Document title', (d) => d.meta.title],
  ['Document author', (d) => d.meta.author],
  ['PDF version', (d) => d.meta.pdfVersion],
  ['File size', (d) => `${d.byteSize.toLocaleString()} bytes`],
  ['Created', (d) => d.meta.creationDate],
  ['Modified', (d) => d.meta.modDate],
  ['Incremental saves', (d) => String(d.meta.incrementalUpdates)],
  ['Body fonts', (d) => (d.layout.bodyFonts || []).slice(0, 4).join(', ')],
  ['Payment-block fonts', (d) => (d.layout.paymentBlockFonts || []).slice(0, 4).join(', ')],
  ['Letterhead image hash', (d) => (d.layout.imageHashes || []).slice(0, 2).join(', ')],
];

export function buildDiff(subject, reference) {
  return DIFF_ROWS.map(([field, get]) => {
    const a = get(reference) ?? null;
    const b = get(subject) ?? null;
    return { field, reference: a, subject: b, same: String(a) === String(b) };
  });
}

/**
 * @param {object} subject   extracted invoice under review
 * @param {object|null} reference  extracted known-good invoice, if supplied
 * @param {object|null} details    known-good details typed in, if supplied
 */
export function analyze({ subject, reference = null, details = null }) {
  let knownGood = null;
  if (reference) {
    knownGood = knownGoodFromReference(reference);
  } else if (details) {
    const kg = knownGoodFromDetails(details);
    if (hasAnyKnownGood(kg)) knownGood = kg;
  }

  const ctx = { doc: subject, ref: reference, knownGood, hasKnownGood: Boolean(knownGood) };
  const { ledger, findings } = runRules(ctx);
  const risk = score(findings, {
    hasKnownGood: Boolean(knownGood?.accounts?.length),
    parseWarnings: subject.warnings.length,
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
    ledger,
    coverage,
    notices,
    knownGood,
    subject,
    reference,
    diff: reference ? buildDiff(subject, reference) : null,
  };
}
