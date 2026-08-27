// Static reference data. No network calls.
// In production the BSB table is replaced by the AusPayNet directory and the
// ABN check by the ABR service; the exported function shapes stay the same.

export const BSB_3 = {
  '013': 'Australia and New Zealand Banking Group',
  '017': 'Australia and New Zealand Banking Group',
  '032': 'Westpac Banking Corporation',
  '033': 'Westpac Banking Corporation',
  '036': 'Westpac Banking Corporation',
  '062': 'Commonwealth Bank of Australia',
  '063': 'Commonwealth Bank of Australia',
  '064': 'Commonwealth Bank of Australia',
  '065': 'Commonwealth Bank of Australia',
  '066': 'Commonwealth Bank of Australia',
  '067': 'Commonwealth Bank of Australia',
  '082': 'National Australia Bank',
  '083': 'National Australia Bank',
  '084': 'National Australia Bank',
  '085': 'National Australia Bank',
  '112': 'BankSA',
  '114': 'St George Bank',
  '182': 'Macquarie Bank',
  '183': 'Macquarie Bank',
  '193': 'Bank of Melbourne',
  '484': 'Suncorp Bank',
  '633': 'Bendigo and Adelaide Bank',
  '637': 'Greater Bank',
  '650': 'Newcastle Permanent',
  '670': 'ubank',
  '923': 'ING Bank (Australia)',
};

export const BSB_2 = {
  '01': 'Australia and New Zealand Banking Group',
  '03': 'Westpac Banking Corporation',
  '04': 'Westpac Banking Corporation',
  '06': 'Commonwealth Bank of Australia',
  '08': 'National Australia Bank',
  '09': 'Reserve Bank of Australia',
  '10': 'BankSA',
  '11': 'St George Bank',
  '12': 'Bank of Queensland',
  '14': 'Rabobank Australia',
  '18': 'Macquarie Bank',
  '19': 'Bank of Melbourne',
  '48': 'Suncorp Bank',
  '63': 'Bendigo and Adelaide Bank',
  '80': 'Cuscal (mutuals / credit unions)',
  '92': 'ING Bank (Australia)',
};

const BANK_ALIASES = {
  'anz': 'Australia and New Zealand Banking Group',
  'commonwealth': 'Commonwealth Bank of Australia',
  'commbank': 'Commonwealth Bank of Australia',
  'cba': 'Commonwealth Bank of Australia',
  'westpac': 'Westpac Banking Corporation',
  'nab': 'National Australia Bank',
  'national australia': 'National Australia Bank',
  'st george': 'St George Bank',
  'stgeorge': 'St George Bank',
  'banksa': 'BankSA',
  'bank of melbourne': 'Bank of Melbourne',
  'boq': 'Bank of Queensland',
  'bank of queensland': 'Bank of Queensland',
  'bendigo': 'Bendigo and Adelaide Bank',
  'macquarie': 'Macquarie Bank',
  'suncorp': 'Suncorp Bank',
  'ing': 'ING Bank (Australia)',
  'ubank': 'ubank',
  'rabobank': 'Rabobank Australia',
};

const ACCOUNT_DIGITS = {
  'Commonwealth Bank of Australia': [8, 9],
  'Australia and New Zealand Banking Group': [9, 9],
  'Westpac Banking Corporation': [6, 9],
  'National Australia Bank': [9, 10],
  'St George Bank': [9, 9],
  'Bank of Queensland': [8, 9],
  'Bendigo and Adelaide Bank': [9, 9],
  'Macquarie Bank': [9, 9],
  'Suncorp Bank': [8, 9],
  'ING Bank (Australia)': [9, 9],
};

export function normaliseBsb(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

export function lookupBsb(value) {
  const digits = normaliseBsb(value);
  if (!digits) return { digits: null, known: false, institution: null };
  if (BSB_3[digits.slice(0, 3)]) return { digits, known: true, institution: BSB_3[digits.slice(0, 3)] };
  if (BSB_2[digits.slice(0, 2)]) return { digits, known: true, institution: BSB_2[digits.slice(0, 2)] };
  return { digits, known: false, institution: null };
}

export function canonicalBankName(printed) {
  if (!printed) return null;
  let key = String(printed).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  key = key.replace(/\s+(bank|banking corporation|pty ltd|limited|ltd)$/, '').trim();
  if (BANK_ALIASES[key]) return BANK_ALIASES[key];
  for (const [alias, name] of Object.entries(BANK_ALIASES)) {
    if (key.startsWith(alias) || key.includes(alias)) return name;
  }
  return null;
}

export function accountDigitRange(institution) {
  return ACCOUNT_DIGITS[institution] || [5, 10];
}

// ATO modulus-89 check, computed offline.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
export function validateAbn(value) {
  if (!value) return false;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 11) return false;
  const nums = digits.split('').map(Number);
  nums[0] -= 1;
  return nums.reduce((sum, n, i) => sum + n * ABN_WEIGHTS[i], 0) % 89 === 0;
}

// Toolchains that indicate the file was re-rendered or edited after leaving the
// issuer's accounting system. Corroboration, never proof.
export const EDITOR_FINGERPRINTS = [
  [/pdftools?\s*sdk|pdftools ag|3-heights/i, 'Pdftools SDK / 3-Heights', 'server-side PDF manipulation library, common in re-write and flattening pipelines'],
  [/ilovepdf/i, 'iLovePDF', 'free online PDF editor'],
  [/smallpdf/i, 'Smallpdf', 'free online PDF editor'],
  [/sejda/i, 'Sejda', 'free online PDF editor'],
  [/pdf24/i, 'PDF24', 'free desktop/online PDF editor'],
  [/pdfescape/i, 'PDFescape', 'free online PDF form and text editor'],
  [/pdfelement|wondershare/i, 'Wondershare PDFelement', 'consumer PDF editing suite'],
  [/foxit\s*(phantom|pdf editor)/i, 'Foxit PhantomPDF', 'consumer PDF editing suite'],
  [/nitro\s*pdf|nitro pro/i, 'Nitro Pro', 'consumer PDF editing suite'],
  [/acrobat|adobe pdf library/i, 'Adobe Acrobat', 'interactive PDF editor'],
  [/ghostscript/i, 'Ghostscript', 're-distiller, strips the original structure'],
  [/skia\/pdf/i, 'Chromium print-to-PDF', 'page re-printed from a browser'],
  [/quartz pdfcontext/i, 'macOS Quartz', 're-saved through macOS Preview or the print pipeline'],
  [/itext|openpdf/i, 'iText / OpenPDF', 'programmatic PDF assembly library'],
  [/pdftk/i, 'PDFtk', 'command-line PDF manipulation'],
  [/cairo|reportlab|fpdf|tcpdf|dompdf/i, 'script-generated PDF', 'built by a script rather than an accounting package'],
];

export function matchEditorFingerprint(producer, creator) {
  const blob = `${producer || ''} ${creator || ''}`;
  if (!blob.trim()) return null;
  for (const [pattern, label, note] of EDITOR_FINGERPRINTS) {
    if (pattern.test(blob)) return { label, note };
  }
  return null;
}

export const BANK_CHANGE_NOTICE =
  /(new|updated|changed|change of|different)\s+(bank|banking|account|payment)\s*(details|account|information)?|please note our (bank|account)|we have (changed|updated) our (bank|account)/i;

export const URGENCY_LANGUAGE =
  /\burgent(ly)?\b|\bimmediate(ly)?\b|as soon as possible|\basap\b|same day|today only|avoid (delay|penalt)|final notice|overdue/i;

// Residential construction progress-payment stages, in contract order.
export const CONSTRUCTION_STAGES = [
  ['deposit', 1], ['site works', 2], ['site start', 2], ['slab', 3], ['base', 3],
  ['frame', 4], ['lock up', 5], ['lockup', 5], ['lock-up', 5],
  ['fixing', 6], ['fit out', 6], ['fitout', 6],
  ['practical completion', 7], ['completion', 7], ['final', 7],
];

export function classifyStage(description) {
  if (!description) return null;
  const low = description.toLowerCase();
  let best = null;
  for (const [name, order] of CONSTRUCTION_STAGES) {
    if (low.includes(name) && (!best || name.length > best.name.length)) best = { name, order };
  }
  return best;
}
