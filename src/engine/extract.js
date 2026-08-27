// PDF -> extracted invoice: metadata, forensic facts, parsed fields.
//
// Everything runs in the viewer's browser. The file is never uploaded.
//
// Three independent readers, because each sees something the others miss:
//   raw bytes  -> incremental updates, signatures, XMP, embedded image streams
//   pdf.js API -> document info dictionary, page geometry
//   text items -> characters with font identity and position

// pdf.js is loaded lazily so the same module runs in the browser bundle and
// under `node --test`, which needs the legacy build.
let pdfjs = null;
export function setPdfjs(mod) { pdfjs = mod; }
async function loadPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}
import { normaliseBsb } from './reference.js';

/* ------------------------------------------------------------------ regex */
const RE_ABN = /\bABN[:\s]*((?:\d[ \-]?){10}\d)/i;
const RE_LICENCE = /\bLicen[cs]e\s*(?:No\.?|Number)?[:\s]*([A-Z0-9][A-Z0-9\-/]{2,})/i;
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const RE_PHONE = /\b(?:Ph|Phone|Tel|Mob(?:ile)?)[:.\s]*((?:\+?61[\s-]?)?\d[\d\s\-()]{7,13})/i;
const RE_INV_NO = /\bInvoice\s*(?:Number|No\.?|#)[:\s]*([A-Za-z]{0,6}[-\s]?\d[\w-]*)/i;
const RE_DUE = /\bDue\s*Date[:\s]*([0-9A-Za-z/ ]+)/i;
const MONEY = '(-?[\\d,]+\\.\\d{2})';
const RE_SUBTOTAL = new RegExp('\\bSub\\s*-?\\s*total\\b[^\\d\\-]*' + MONEY, 'i');
const RE_GST = new RegExp('\\bTotal\\s*GST\\b[^\\n]*?' + MONEY, 'i');
const RE_TOTAL = new RegExp('\\bInvoice\\s*Total\\b[^\\d\\-]*' + MONEY, 'i');
const RE_PAYMENTS = new RegExp('\\b(?:Total\\s*Net\\s*Payments|Less\\s*Payments?|Payments?\\s*Received)[^\\d\\-]*' + MONEY, 'i');
const RE_AMOUNT_DUE = new RegExp('\\bAmount\\s*(?:Due|Payable|Owing)\\b[^\\d\\-]*' + MONEY, 'i');
const RE_ACCOUNT_NAME = /\bAccount\s*Name[:\s]*(.+)/i;
const RE_BANK = /^\s*Bank(?:\s*Name)?[:\s]*([A-Za-z][A-Za-z .&'-]+?)\s*$/im;
const RE_BSB = /\bBSB[:\s#]*(\d{3}[\s-]?\d{3})/i;
const RE_BSB_LOOSE = /\b(\d{3}[\s-]\d{3})\b/;
const RE_BSB_LOOSE_G = /\b(\d{3}[\s-]\d{3})\b/g;
const RE_BSB_G = /\bBSB[:\s#]*(\d{3}[\s-]?\d{3})/gi;
const RE_ACCOUNT_NO_G = /\bAcc(?:oun)?t(?:\s*(?:Number|No\.?|#))?[:\s]*(\d[\d\s-]{4,})/gi;
const RE_PAYID = /\bPay\s*ID[:\s]*([\w@.+-]+)/i;
// Digit runs that are emphatically not bank accounts. An ABN prints as 3-3-3
// and an Australian mobile as 04xx xxx xxx; both contain a perfect BSB-shaped
// substring, so they must be removed before any bare-pattern scan.
const RE_IDENTITY_RUN = /\b(?:ABN|ACN|ARBN)[:\s]*(?:\d[ \-]?){8,12}/gi;
const RE_CONTACT_RUN = /\b(?:Ph|Phone|Tel|Telephone|Mob(?:ile)?|Fax)[:.\s]*(?:\+?61[\s-]?)?\d[\d\s\-()]{6,}/gi;
const RE_MOBILE_RUN = /\b(?:\+?61[\s-]?)?0?4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
const RE_ENTITY = /\b([A-Z][A-Za-z&'.-]*(?:\s+[A-Z][A-Za-z&'.-]*){0,4}\s+(?:Pty\.?\s*Ltd\.?|Pty\.?\s*Limited|Ltd\.?|Limited))\b/;
const PAYMENT_HEADING = /payment\s*details|remittance|direct\s*deposit|eft\s*details|bank\s*details/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[2], +m[1]); // Australian convention: day first
  }
  return null;
}
const iso = (y, m, d) =>
  (m >= 1 && m <= 12 && d >= 1 && d <= 31)
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null;

export function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

const money = (v) => (v == null ? null : Number(String(v).replace(/,/g, '')));

/* ------------------------------------------------------------- raw bytes */
function latin1(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return out;
}

function countAll(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

async function sha256(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A cheap, stable fingerprint for one embedded image stream.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash every `/Subtype /Image` stream in the file, straight from the bytes. */
function imageStreamHashes(raw) {
  const hashes = [];
  const re = /\/Subtype\s*\/Image/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = raw.indexOf('stream', m.index);
    if (start === -1 || start - m.index > 900) continue;
    let from = start + 6;
    if (raw[from] === '\r') from++;
    if (raw[from] === '\n') from++;
    const end = raw.indexOf('endstream', from);
    if (end === -1) continue;
    const body = raw.slice(from, end);
    hashes.push(`${fnv1a(body)}:${body.length}`);
    re.lastIndex = end;
  }
  return hashes;
}

function rawFacts(bytes) {
  const raw = latin1(bytes);
  const eof = countAll(raw, '%%EOF');
  const startxref = countAll(raw, 'startxref');
  const header = raw.slice(0, 32).match(/%PDF-(\d\.\d)/);
  const hasXmp = raw.includes('<x:xmpmeta') || raw.includes('<?xpacket');
  const docId = raw.match(/xmpMM:DocumentID>?["'=]?([^<"']+)/);
  const instId = raw.match(/xmpMM:InstanceID>?["'=]?([^<"']+)/);
  return {
    raw,
    eofMarkers: eof,
    xrefSections: countAll(raw, '\nxref') + countAll(raw, '/Type/XRef') + countAll(raw, '/Type /XRef'),
    incrementalUpdates: Math.max(0, Math.min(eof, startxref) - 1),
    headerVersion: header ? header[1] : null,
    hasXmp,
    xmpDocumentId: docId ? docId[1].trim() : null,
    xmpInstanceId: instId ? instId[1].trim() : null,
    xmpHistoryEvents: (raw.match(/stEvt:action/g) || []).length,
    hasSignature: raw.includes('/Sig') && raw.includes('/ByteRange'),
    imageHashes: imageStreamHashes(raw),
  };
}

/* --------------------------------------------------------- text handling */
/** One text run, normalised to a top-left origin so lines sort naturally. */
function toRuns(textContent, pageHeight) {
  return textContent.items
    .filter((it) => it.str !== undefined)
    .map((it, index) => {
      const [a, , , d, e, f] = it.transform;
      const size = Math.abs(d) || Math.abs(a) || 10;
      return {
        index,
        text: it.str,
        x0: e,
        x1: e + (it.width || 0),
        top: pageHeight - f - size * 0.8,
        baseline: pageHeight - f,
        size: Math.round(size * 10) / 10,
        font: it.fontName || 'unknown',
      };
    })
    .filter((r) => r.text.length > 0);
}

function groupLines(runs, tol = 2.5) {
  const lines = [];
  for (const r of [...runs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].baseline - r.baseline) <= tol) last.push(r);
    else lines.push([r]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0));
}

/** Join a line's runs, restoring the word gaps the PDF only implies. */
function lineText(line) {
  let out = '';
  let prev = null;
  for (const r of line) {
    if (prev) {
      const gap = r.x0 - prev.x1;
      if (gap > Math.max(0.8, 0.22 * prev.size) && !/\s$/.test(out) && !/^\s/.test(r.text)) out += ' ';
    }
    out += r.text;
    prev = r;
  }
  return out;
}

const blockText = (runs) => groupLines(runs).map(lineText).join('\n');

/**
 * Reconstruct the page once per (font, size) group.
 *
 * When a payment block is patched, the replacement is painted on top of the
 * original at the same coordinates. Read in reading order the two interleave
 * into nonsense ("BBSSBB:: 001674 0-24422") and every regex stops matching.
 * An overlay and the text it hides almost never share a typeface, so splitting
 * on that makes both layers readable again.
 */
function textLayers(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.font}@${r.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    font: members[0].font,
    size: members[0].size,
    runs: members.length,
    // Content-stream position: the layer painted last is the one a reader sees.
    z: Math.max(...members.map((m) => m.index)),
    text: blockText(members),
    members,
  }));
}

const stripIdentity = (text) =>
  [RE_IDENTITY_RUN, RE_CONTACT_RUN, RE_MOBILE_RUN].reduce((t, re) => t.replace(re, ' '), text);

function scanPaymentTokens(text) {
  const clean = stripIdentity(text);
  let bsbs = [...clean.matchAll(RE_BSB_G)].map((m) => normaliseBsb(m[1])).filter(Boolean);
  if (!bsbs.length) bsbs = [...clean.matchAll(RE_BSB_LOOSE_G)].map((m) => normaliseBsb(m[1])).filter(Boolean);
  const accounts = [...clean.matchAll(RE_ACCOUNT_NO_G)]
    .map((m) => m[1].replace(/\D/g, ''))
    .filter((d) => d.length >= 5 && d.length <= 10);
  return { bsbs: [...new Set(bsbs)], accounts: [...new Set(accounts)] };
}

/** Runs that carry a monetary figure - the fields worth editing. */
const RE_FIGURE = /^-?[\d,]+\.\d{2,4}$/;

/**
 * Strip a subset prefix and a weight/style suffix to get the typeface family.
 *
 * A genuine template varies weight for emphasis - a bold total is not an
 * anomaly - so comparisons are made on the family, never the full PostScript
 * name. 'AAAAAA+DejaVuSans-Bold' and 'DejaVuSans' are the same family.
 */
export function fontFamily(name) {
  return String(name || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[-,_](?:Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Light|Medium|Semibold|Black)$/i, '')
    .trim();
}

function tally(items) {
  const counts = new Map();
  for (const key of items) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Typeface and point size, profiled across the page.
 *
 * A forger retyping a field inside the same tool often keeps the typeface and
 * misses the point size by a fraction. Comparing font names alone never sees
 * that, so both are profiled: the payment block should render in one font at
 * one size, and every monetary figure on the page should match every other.
 */
function typographyFacts(runs, detailRuns) {
  const round = (n) => Math.round(n * 10) / 10;
  const body = tally(runs.map((r) => `${fontFamily(r.font)}@${round(r.size)}`));
  const [dominantFont, dominantSize] = (body[0]?.[0] || '@').split('@');

  const figures = runs.filter((r) => RE_FIGURE.test(r.text.trim()));
  const figureProfile = tally(figures.map((r) => `${fontFamily(r.font)}@${round(r.size)}`));
  const [domFigFont, domFigSize] = (figureProfile[0]?.[0] || '@').split('@');

  return {
    dominantFont: dominantFont || null,
    dominantSize: dominantSize ? Number(dominantSize) : null,
    paymentDetailFonts: tally(detailRuns.map((r) => fontFamily(r.font))),
    paymentDetailSizes: tally(detailRuns.map((r) => round(r.size))),
    figureCount: figures.length,
    dominantFigureFont: domFigFont || null,
    dominantFigureSize: domFigSize ? Number(domFigSize) : null,
    figureOutliers: figures
      .filter((r) => fontFamily(r.font) !== domFigFont
        || Math.abs(round(r.size) - Number(domFigSize)) > 0.2)
      .map((r) => ({ text: r.text.trim(), font: fontFamily(r.font), size: round(r.size) })),
  };
}

/** Fraction of runs painted on top of another run. */
function overprintRatio(runs) {
  if (runs.length < 8) return 0;
  const buckets = new Map();
  for (const r of runs) {
    const k = Math.round(r.baseline / 2);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  let overlapping = 0;
  for (const members of buckets.values()) {
    members.sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < members.length - 1; i++) {
      const a = members[i], b = members[i + 1];
      const w = Math.max(1e-6, a.x1 - a.x0);
      if ((Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) / w > 0.55) overlapping++;
    }
  }
  return Math.round((overlapping / runs.length) * 1000) / 1000;
}

/* ----------------------------------------------------- painted shapes */
const fillOps = (OPS) => new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke]);

/** Filled rectangles and painted images, with page-top-origin bounding boxes. */
async function paintedShapes(page, pageHeight, OPS) {
  const FILL_OPS = fillOps(OPS);
  const list = await page.getOperatorList();
  const rects = [];
  const images = [];
  let fill = null;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.setFillRGBColor) fill = args[0];
    else if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = args.slice();
    else if (fn === OPS.paintImageXObject) {
      const w = Math.abs(ctm[0]), h = Math.abs(ctm[3]);
      images.push({
        id: args[0],
        bbox: [ctm[4], pageHeight - ctm[5] - h, ctm[4] + w, pageHeight - ctm[5]],
        pixels: [args[1], args[2]],
      });
    } else if (fn === OPS.constructPath) {
      const drawOp = args[0];
      const mm = args[2];
      if (!FILL_OPS.has(drawOp) || !mm) continue;
      const b = [mm[0], mm[1], mm[2], mm[3]].map(Number);
      if (b.some(Number.isNaN)) continue;
      rects.push({
        bbox: [b[0], pageHeight - b[3], b[2], pageHeight - b[1]],
        fill,
        area: Math.abs((b[2] - b[0]) * (b[3] - b[1])),
      });
    }
  }
  return { rects, images };
}

function isWhite(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  return [1, 3, 5].every((i) => parseInt(hex.slice(i, i + 2), 16) > 234);
}

const intersects = (a, b) => !(b[2] < a[0] || b[0] > a[2] || b[3] < a[1] || b[1] > a[3]);

/* ------------------------------------------------------------ field parse */
function parseFields(doc, text) {
  const lines = text.split('\n').map((l) => l.trim());
  const grab = (re, i = 1) => { const m = text.match(re); return m ? m[i].trim() : null; };

  doc.supplierAbn = grab(RE_ABN)?.replace(/\s+/g, ' ') ?? null;
  doc.supplierLicence = grab(RE_LICENCE);
  doc.supplierEmail = text.match(RE_EMAIL)?.[0]?.toLowerCase() ?? null;
  doc.supplierPhone = grab(RE_PHONE)?.replace(/[\s()-]/g, '') ?? null;
  doc.invoiceNumber = grab(RE_INV_NO);
  doc.dueDate = parseDate(grab(RE_DUE));

  const valueUnder = (labelRe) => {
    for (let i = 0; i < lines.length - 1; i++) {
      if (labelRe.test(lines[i]) && lines[i].replace(labelRe, '').trim() === '') {
        const next = lines[i + 1];
        if (next && !/^[A-Za-z ]{2,20}$/.test(next)) return next;
      }
    }
    return null;
  };
  doc.invoiceDate = parseDate(valueUnder(/^Date$/i));
  if (!doc.invoiceDate) {
    // The 'Date' label often shares a rendered line with unrelated left-hand
    // text. Take the first parseable date on, or immediately below, such a line.
    for (let i = 0; i < lines.length; i++) {
      if (!/(?:^|[^e]\s)Date\b/i.test(lines[i]) || /Due\s*Date/i.test(lines[i])) continue;
      const tail = lines[i].split(/\bDate\b/i).pop();
      const cand = parseDate(tail) || parseDate(lines[i + 1] || '');
      if (cand && cand !== doc.dueDate) { doc.invoiceDate = cand; break; }
    }
  }
  if (!doc.invoiceNumber) doc.invoiceNumber = valueUnder(/^Invoice\s*(?:Number|No\.?|#)$/i);
  doc.invoiceReference = valueUnder(/^Reference$/i) || grab(/^\s*Reference[:\s]*([\w/-]+)\s*$/im);

  doc.subtotal = money(grab(RE_SUBTOTAL));
  doc.gst = money(grab(RE_GST));
  doc.total = money(grab(RE_TOTAL));
  doc.paymentsApplied = money(grab(RE_PAYMENTS));
  doc.amountDue = money(grab(RE_AMOUNT_DUE));

  const pay = doc.payment;
  pay.accountName = grab(RE_ACCOUNT_NAME);
  pay.bankPrinted = grab(RE_BANK);
  const bsbMatch = text.match(RE_BSB) || stripIdentity(text).match(RE_BSB_LOOSE);
  if (bsbMatch) { pay.bsbPrinted = bsbMatch[1].trim(); pay.bsb = normaliseBsb(bsbMatch[1]); }
  for (const m of text.matchAll(RE_ACCOUNT_NO_G)) {
    if (/^\s*Account\s*Name/i.test(m[0])) continue;
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 5 && digits.length <= 10 && digits !== pay.bsb) { pay.accountNumber = digits; break; }
  }
  pay.payid = grab(RE_PAYID);
  pay.referenceNote = grab(/(please use [^\n]{0,80})/i);

  // The letterhead is normally a logo, so fall through: account name, then any
  // company-suffixed entity in the body, then the first header line.
  let candidate = pay.accountName || text.match(RE_ENTITY)?.[1] || null;
  if (!candidate) {
    candidate = lines.slice(0, 6).find((l) => l.length > 3 && !RE_ABN.test(l) && !RE_EMAIL.test(l)) || null;
  }
  doc.supplierName = candidate ? candidate.replace(/\s+/g, ' ').trim() : null;
  if (!candidate) {
    doc.warnings.push('Supplier name could not be read from the text layer - the letterhead is probably an image.');
  }

  for (const line of lines) {
    const m = line.match(/^(.{4,80}?)\s+([\d,]+\.\d{2,4})\s+(\d{1,2})%\s+([\d,]+\.\d{2})$/);
    if (m) doc.lineItems.push({ description: m[1].trim(), unitPrice: money(m[2]), gstRate: +m[3] / 100, amount: money(m[4]) });
  }
}

/* ---------------------------------------------------------------- extract */
export async function extract(bytes, filename = 'invoice.pdf') {
  const doc = {
    filename,
    byteSize: bytes.length,
    sha256: await sha256(bytes),
    meta: {},
    layout: {},
    payment: {},
    lineItems: [],
    warnings: [],
    text: '',
  };

  const facts = rawFacts(bytes);
  doc.meta = {
    pdfVersion: facts.headerVersion,
    eofMarkers: facts.eofMarkers,
    xrefSections: facts.xrefSections,
    incrementalUpdates: facts.incrementalUpdates,
    hasXmp: facts.hasXmp,
    xmpDocumentId: facts.xmpDocumentId,
    xmpInstanceId: facts.xmpInstanceId,
    xmpHistoryEvents: facts.xmpHistoryEvents,
    hasSignature: facts.hasSignature,
  };

  const { getDocument, OPS } = await loadPdfjs();
  let pdf;
  try {
    pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true }).promise;
  } catch (err) {
    doc.warnings.push(`This file could not be opened as a PDF: ${err.message}`);
    doc.layout = emptyLayout();
    doc.layout.imageHashes = facts.imageHashes;
    return doc;
  }

  const info = (await pdf.getMetadata()).info || {};
  Object.assign(doc.meta, {
    pdfVersion: info.PDFFormatVersion || facts.headerVersion,
    title: info.Title || null,
    author: info.Author || null,
    subject: info.Subject || null,
    creator: info.Creator || null,
    producer: info.Producer || null,
    creationDate: normalisePdfDate(info.CreationDate),
    modDate: normalisePdfDate(info.ModDate),
    encrypted: Boolean(info.IsEncrypted) || Boolean(info.EncryptFilterName),
    hasSignature: facts.hasSignature || Boolean(info.IsSignaturesPresent),
    pageCount: pdf.numPages,
  });

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });

  // Read shapes first: walking the operator list is also what resolves the font
  // objects, which turns pdf.js's internal ids into real typeface names.
  let shapes = { rects: [], images: [] };
  try { shapes = await paintedShapes(page, viewport.height, OPS); }
  catch { doc.warnings.push('Page shapes could not be read, so overlay detection was limited.'); }

  const textContent = await page.getTextContent();
  const fontNames = resolveFontNames(page, textContent);
  const runs = toRuns(textContent, viewport.height).map((r) => ({ ...r, font: fontNames[r.font] || r.font }));
  const lines = groupLines(runs);
  const text = lines.map(lineText).join('\n');
  doc.text = text;

  doc.layout = buildLayout({ runs, lines, text, shapes, viewport, imageHashes: facts.imageHashes });

  parseFields(doc, text);

  // A patched page renders two text layers into one unreadable stream. When the
  // flat text yields no usable instrument, fall back to the per-layer read.
  const overprinted = doc.layout.overprintRatio > 0.02;
  const candidates = doc.layout.paymentCandidates;
  if (candidates.length && (overprinted || !(doc.payment.bsb && doc.payment.accountNumber))) {
    const best = candidates.reduce((a, b) => {
      const rank = (c) => (c.bsb ? 4 : 0) + (c.account ? 2 : 0);
      if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
      return b.z > a.z ? b : a;
    });
    const take = overprinted ? (cur, next) => next ?? cur : (cur, next) => cur ?? next;
    doc.payment.bsb = take(doc.payment.bsb, best.bsb);
    doc.payment.accountNumber = take(doc.payment.accountNumber, best.account);
    doc.payment.bankPrinted = take(doc.payment.bankPrinted, best.bank);
    doc.payment.accountName = take(doc.payment.accountName, best.accountName);
    if (doc.payment.bsb) doc.payment.bsbPrinted = `${doc.payment.bsb.slice(0, 3)} ${doc.payment.bsb.slice(3)}`;
    doc.warnings.push('Payment details were read layer by layer: the page carries overlapping text runs, so the instrument shown is the one painted last - what a reader sees.');
  }

  if (!text.trim()) {
    doc.warnings.push('No selectable text: this page is an image. Field-level checks cannot run without OCR.');
  }
  await pdf.destroy?.();
  return doc;
}

function emptyLayout() {
  return {
    pageWidth: 0, pageHeight: 0, bodyFonts: [], paymentBlockFonts: [], paymentBlockBbox: null,
    overlays: [], coveredSnippets: [], invisibleSnippets: [], allBsbMatches: [], allAccountMatches: [],
    lineGapAnomaly: null, imageCount: 0, imageHashes: [], fullPageImage: false, runCount: 0,
    overprintRatio: 0, textLayers: [], paymentCandidates: [], labelAnchors: {},
    typography: {
      dominantFont: null, dominantSize: null,
      paymentDetailFonts: [], paymentDetailSizes: [],
      figureCount: 0, dominantFigureFont: null, dominantFigureSize: null, figureOutliers: [],
    },
  };
}

function buildLayout({ runs, lines, text, shapes, viewport, imageHashes }) {
  const L = emptyLayout();
  L.pageWidth = viewport.width;
  L.pageHeight = viewport.height;
  L.runCount = runs.length;
  L.imageCount = shapes.images.length;
  L.imageHashes = imageHashes;
  L.overprintRatio = overprintRatio(runs);

  // --- payment block region -------------------------------------------
  let headingTop = null;
  for (const line of lines) {
    if (PAYMENT_HEADING.test(lineText(line))) { headingTop = Math.min(...line.map((r) => r.top)); break; }
  }
  if (headingTop === null) {
    for (const line of lines) {
      if (RE_BSB.test(lineText(line))) { headingTop = Math.min(...line.map((r) => r.top)) - 24; break; }
    }
  }
  if (headingTop !== null) {
    const bottom = Math.min(L.pageHeight, headingTop + 140);
    const block = runs.filter((r) => r.top >= headingTop - 6 && r.top <= bottom);
    const body = runs.filter((r) => r.top < headingTop - 6);
    L.paymentBlockBbox = [
      Math.min(...block.map((r) => r.x0), L.pageWidth) - 4,
      headingTop - 6,
      Math.max(...block.map((r) => r.x1), 0) + 4,
      bottom,
    ];
    L.paymentBlockFonts = [...new Set(block.map((r) => r.font))].sort();
    L.bodyFonts = [...new Set(body.map((r) => r.font))].sort();

    const detailLines = groupLines(block).filter((l) => /^\s*(Account\s*Name|Bank|BSB|Acc(?:oun)?t)\s*[:#]/i.test(lineText(l)));
    const gaps = [];
    for (let i = 0; i < detailLines.length - 1; i++) {
      const g = detailLines[i + 1][0].baseline - detailLines[i][0].baseline;
      if (g > 2 && g < 60) gaps.push(g);
    }
    if (gaps.length >= 3) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      if (med > 0) L.lineGapAnomaly = Math.max(...gaps.map((g) => Math.abs(g - med) / med));
    }
    L.typography = typographyFacts(runs, detailLines.flat());
    for (const line of detailLines) {
      const t = lineText(line);
      for (const label of ['Account Name', 'Bank', 'BSB', 'Account']) {
        if (new RegExp(`^\\s*${label}\\s*[:#]`, 'i').test(t) && !L.labelAnchors[label]) {
          L.labelAnchors[label] = [Math.round(line[0].x0 * 10) / 10, Math.round(line[0].top * 10) / 10];
        }
      }
    }
  } else {
    L.bodyFonts = [...new Set(runs.map((r) => r.font))].sort();
    L.typography = typographyFacts(runs, []);
  }

  // --- every payment-looking token anywhere in the page objects ---------
  const flat = scanPaymentTokens(text);
  const bsbs = new Set(flat.bsbs);
  const accounts = new Set(flat.accounts);
  for (const layer of textLayers(runs)) {
    L.textLayers.push({ font: layer.font, size: layer.size, runs: layer.runs });
    const found = scanPaymentTokens(layer.text);
    found.bsbs.forEach((b) => bsbs.add(b));
    found.accounts.forEach((a) => accounts.add(a));
    if (found.bsbs.length || found.accounts.length) {
      L.paymentCandidates.push({
        font: layer.font,
        z: layer.z,
        bsb: found.bsbs[0] || null,
        account: found.accounts[0] || null,
        bank: layer.text.match(RE_BANK)?.[1]?.trim() || null,
        accountName: layer.text.match(RE_ACCOUNT_NAME)?.[1]?.trim() || null,
      });
    }
  }
  L.allBsbMatches = [...bsbs].sort();
  L.allAccountMatches = [...accounts].sort();

  // --- overlays sitting on the payment block ---------------------------
  if (L.paymentBlockBbox) {
    for (const img of shapes.images) {
      if (intersects(L.paymentBlockBbox, img.bbox)) {
        L.overlays.push({ kind: 'image', bbox: img.bbox.map((v) => Math.round(v * 10) / 10), coveredRuns: 0 });
      }
    }
    for (const rect of shapes.rects) {
      if (rect.area < 400 || !intersects(L.paymentBlockBbox, rect.bbox)) continue;
      const covered = runs.filter((r) =>
        (r.x0 + r.x1) / 2 >= rect.bbox[0] && (r.x0 + r.x1) / 2 <= rect.bbox[2] &&
        r.baseline >= rect.bbox[1] && r.baseline <= rect.bbox[3]);
      L.overlays.push({
        kind: isWhite(rect.fill) ? 'white rectangle' : `filled rectangle ${rect.fill || ''}`.trim(),
        bbox: rect.bbox.map((v) => Math.round(v * 10) / 10),
        coveredRuns: covered.length,
      });
      // Read the covered region one typeface at a time: an overlay and the text
      // it hides are two layers occupying the same coordinates.
      for (const layer of textLayers(covered)) {
        if (scanPaymentTokens(layer.text).bsbs.length) {
          L.coveredSnippets.push(`[${layer.font}] ${layer.text.replace(/\s+/g, ' ').slice(0, 180)}`);
        }
      }
    }
  }
  for (const img of shapes.images) {
    if ((img.bbox[2] - img.bbox[0]) > 0.85 * L.pageWidth && (img.bbox[3] - img.bbox[1]) > 0.85 * L.pageHeight) {
      L.fullPageImage = true;
    }
  }
  if (!text.trim() && shapes.images.length) L.fullPageImage = true;
  return L;
}

/** Map pdf.js's per-document font ids to the typeface names in the file. */
function resolveFontNames(page, textContent) {
  const names = {};
  for (const id of new Set(textContent.items.map((i) => i.fontName).filter(Boolean))) {
    try {
      const obj = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
      if (obj && obj.name) names[id] = obj.name;
    } catch {
      // A font that never resolved keeps its internal id, which is still stable
      // within this document and so still separates overlay from original.
    }
  }
  return names;
}

function normalisePdfDate(value) {
  if (!value) return null;
  const m = String(value).match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return String(value);
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}`;
}

export function metaDateGapHours(meta) {
  if (!meta.creationDate || !meta.modDate) return null;
  const a = Date.parse(meta.creationDate), b = Date.parse(meta.modDate);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3600000;
}
