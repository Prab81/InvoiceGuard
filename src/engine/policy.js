// The policy: which rules run, how hard they score, and where the bands sit.
//
// The catalogue is the *shipped* rule set. A bank's policy is a layer on top of
// it: rules switched off, weights retuned, thresholds moved, plus any custom
// rules the reviewer has added. Keeping the two separate means an upgrade to the
// catalogue never silently discards local tuning, and a policy can be exported,
// reviewed and version-controlled like any other control document.

import { LAYERS, RULES } from './catalog.js';
import { BANDS } from './scoring.js';

export const POLICY_STORAGE_KEY = 'invoiceguard.policy.v1';
export const POLICY_VERSION = 1;

/* ====================================================================== */
/* Custom rules: a constrained builder, not arbitrary code                */
/* ====================================================================== */

/**
 * The fields a custom rule may read.
 *
 * Deliberately a whitelist. A rule is executable logic, and letting a reviewer
 * type JavaScript into a fraud tool would be both a security hole and
 * unshippable under the page's content-security policy. Everything expressible
 * here is data, so a policy stays safe to share and safe to load.
 */
export const RULE_FIELDS = [
  { id: 'payment.bsb', label: 'BSB', group: 'Payment', get: (d) => d.payment.bsb, knownGood: (kg) => kg?.accounts?.[0]?.bsb },
  { id: 'payment.accountNumber', label: 'Account number', group: 'Payment', get: (d) => d.payment.accountNumber, knownGood: (kg) => kg?.accounts?.[0]?.account },
  { id: 'payment.bankPrinted', label: 'Bank name', group: 'Payment', get: (d) => d.payment.bankPrinted, knownGood: (kg) => kg?.accounts?.[0]?.bank },
  { id: 'payment.accountName', label: 'Account name', group: 'Payment', get: (d) => d.payment.accountName, knownGood: (kg) => kg?.accountName },

  { id: 'supplierName', label: 'Supplier name', group: 'Supplier', get: (d) => d.supplierName, knownGood: (kg) => kg?.supplierName },
  { id: 'supplierAbn', label: 'ABN', group: 'Supplier', get: (d) => d.supplierAbn, knownGood: (kg) => kg?.abn },
  { id: 'supplierLicence', label: 'Builder licence', group: 'Supplier', get: (d) => d.supplierLicence, knownGood: (kg) => kg?.licence },
  { id: 'supplierEmail', label: 'Contact email', group: 'Supplier', get: (d) => d.supplierEmail, knownGood: (kg) => kg?.emails?.[0] },
  { id: 'emailDomain', label: 'Email domain', group: 'Supplier', get: (d) => (d.supplierEmail || '').split('@')[1] || null, knownGood: (kg) => (kg?.emails?.[0] || '').split('@')[1] || null },
  { id: 'supplierPhone', label: 'Contact phone', group: 'Supplier', get: (d) => d.supplierPhone, knownGood: (kg) => kg?.phones?.[0] },

  { id: 'invoiceNumber', label: 'Invoice number', group: 'Invoice', get: (d) => d.invoiceNumber },
  { id: 'invoiceDate', label: 'Invoice date', group: 'Invoice', get: (d) => d.invoiceDate },
  { id: 'dueDate', label: 'Due date', group: 'Invoice', get: (d) => d.dueDate },
  { id: 'termsDays', label: 'Payment terms (days)', group: 'Invoice', numeric: true,
    get: (d) => (d.invoiceDate && d.dueDate ? Math.round((Date.parse(d.dueDate) - Date.parse(d.invoiceDate)) / 86400000) : null) },
  { id: 'subtotal', label: 'Subtotal', group: 'Invoice', numeric: true, get: (d) => d.subtotal },
  { id: 'gst', label: 'GST', group: 'Invoice', numeric: true, get: (d) => d.gst },
  { id: 'amountDue', label: 'Amount due', group: 'Invoice', numeric: true, get: (d) => d.amountDue },

  { id: 'meta.producer', label: 'PDF producer', group: 'File', get: (d) => d.meta.producer, knownGood: (kg) => kg?.producers?.[0] },
  { id: 'meta.creator', label: 'PDF creator', group: 'File', get: (d) => d.meta.creator, knownGood: (kg) => kg?.creators?.[0] },
  { id: 'meta.title', label: 'Document title', group: 'File', get: (d) => d.meta.title },
  { id: 'meta.author', label: 'Document author', group: 'File', get: (d) => d.meta.author, knownGood: (kg) => kg?.authors?.[0] },
  { id: 'meta.pdfVersion', label: 'PDF version', group: 'File', get: (d) => d.meta.pdfVersion, knownGood: (kg) => kg?.pdfVersions?.[0] },
  { id: 'byteSize', label: 'File size (bytes)', group: 'File', numeric: true, get: (d) => d.byteSize, knownGood: (kg) => kg?.byteSize },
  { id: 'meta.pageCount', label: 'Page count', group: 'File', numeric: true, get: (d) => d.meta.pageCount },
  { id: 'meta.incrementalUpdates', label: 'Incremental saves', group: 'File', numeric: true, get: (d) => d.meta.incrementalUpdates },

  { id: 'layout.accountCount', label: 'Accounts found in file', group: 'Structure', numeric: true, get: (d) => (d.layout.allBsbMatches || []).length },
  { id: 'layout.overprintRatio', label: 'Overprinted text ratio', group: 'Structure', numeric: true, get: (d) => d.layout.overprintRatio || 0 },
  { id: 'layout.imageCount', label: 'Embedded images', group: 'Structure', numeric: true, get: (d) => d.layout.imageCount || 0 },
  { id: 'text', label: 'Full invoice text', group: 'Structure', get: (d) => d.text },
];

export const RULE_OPERATORS = [
  { id: 'equals', label: 'is exactly', needsValue: true },
  { id: 'notEquals', label: 'is not', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'notContains', label: 'does not contain', needsValue: true },
  { id: 'matches', label: 'matches the pattern', needsValue: true, regex: true },
  { id: 'inList', label: 'is one of', needsValue: true, list: true },
  { id: 'notInList', label: 'is not one of', needsValue: true, list: true },
  { id: 'isEmpty', label: 'is missing', needsValue: false },
  { id: 'isNotEmpty', label: 'is present', needsValue: false },
  { id: 'greaterThan', label: 'is greater than', needsValue: true, numeric: true },
  { id: 'lessThan', label: 'is less than', needsValue: true, numeric: true },
  { id: 'differsFromKnownGood', label: 'differs from the known good', needsValue: false, knownGood: true },
  { id: 'matchesKnownGood', label: 'matches the known good', needsValue: false, knownGood: true },
];

const fieldById = (id) => RULE_FIELDS.find((f) => f.id === id);
const norm = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const listOf = (v) => norm(v).split(',').map((s) => s.trim()).filter(Boolean);

/** Turn a stored custom-rule definition into a rule the engine can run. */
export function compileCustomRule(def) {
  const field = fieldById(def.field);
  const operator = RULE_OPERATORS.find((o) => o.id === def.operator);
  return {
    id: def.id,
    title: def.title || 'Custom rule',
    parameter: `${field ? field.label : def.field} ${operator ? operator.label : def.operator}`
      + (operator?.needsValue ? ` "${def.value}"` : ''),
    layer: def.layer,
    severity: def.severity,
    weight: Number(def.weight),
    custom: true,
    definition: def,
    requires(ctx) {
      if (!field || !operator) return 'This rule refers to a field or comparison that no longer exists.';
      if (operator.knownGood && !ctx.knownGood) return 'Needs known-good details to compare against.';
      if (operator.knownGood && !field.knownGood) return 'This field has no known-good counterpart to compare against.';
      const actual = field.get(ctx.doc);
      if ((actual === null || actual === undefined || actual === '')
        && !['isEmpty', 'differsFromKnownGood'].includes(operator.id)) {
        return `${field.label} could not be read from this invoice.`;
      }
      return null;
    },
    evaluate(ctx) {
      const actual = field.get(ctx.doc);
      const expected = def.value;
      const shown = norm(actual) || '(not present)';
      let hit = false;

      switch (operator.id) {
        case 'equals': hit = norm(actual).toLowerCase() === norm(expected).toLowerCase(); break;
        case 'notEquals': hit = norm(actual).toLowerCase() !== norm(expected).toLowerCase(); break;
        case 'contains': hit = norm(actual).toLowerCase().includes(norm(expected).toLowerCase()); break;
        case 'notContains': hit = !norm(actual).toLowerCase().includes(norm(expected).toLowerCase()); break;
        case 'matches': {
          try { hit = new RegExp(expected, 'i').test(norm(actual)); }
          catch { return null; }   // a malformed pattern must never fail the run
          break;
        }
        case 'inList': hit = listOf(expected).some((v) => v.toLowerCase() === norm(actual).toLowerCase()); break;
        case 'notInList': hit = !listOf(expected).some((v) => v.toLowerCase() === norm(actual).toLowerCase()); break;
        case 'isEmpty': hit = norm(actual) === ''; break;
        case 'isNotEmpty': hit = norm(actual) !== ''; break;
        case 'greaterThan': hit = Number(actual) > Number(expected); break;
        case 'lessThan': hit = Number(actual) < Number(expected); break;
        case 'differsFromKnownGood':
        case 'matchesKnownGood': {
          const good = field.knownGood(ctx.knownGood);
          if (good === null || good === undefined || good === '') return null;
          const same = norm(actual).toLowerCase() === norm(good).toLowerCase();
          hit = operator.id === 'matchesKnownGood' ? same : !same;
          if (!hit) return null;
          return {
            evidence: def.evidence
              || `${field.label} is "${shown}"; the known good is "${norm(good)}".`,
            recommendation: def.recommendation || null,
            detail: { field: field.id, actual, knownGood: good },
          };
        }
        default: return null;
      }
      if (!hit) return null;
      return {
        evidence: def.evidence
          || `${field.label} is "${shown}", which ${operator.label}`
             + (operator.needsValue ? ` "${norm(expected)}".` : '.'),
        recommendation: def.recommendation || null,
        detail: { field: field.id, actual, operator: operator.id, value: expected },
      };
    },
  };
}

/** Human-readable description used in the settings list and the report. */
export function describeCustomRule(def) {
  const field = fieldById(def.field);
  const operator = RULE_OPERATORS.find((o) => o.id === def.operator);
  return `${field?.label || def.field} ${operator?.label || def.operator}`
    + (operator?.needsValue ? ` "${def.value}"` : '');
}

/* ====================================================================== */
/* The policy itself                                                      */
/* ====================================================================== */
export function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    disabled: [],
    overrides: {},                       // ruleId -> { severity?, weight? }
    custom: [],
    caps: Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.cap])),
    thresholds: Object.fromEntries(BANDS.map((b) => [b.key, b.min])),
  };
}

export function normalisePolicy(raw) {
  const base = defaultPolicy();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: POLICY_VERSION,
    disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x) => typeof x === 'string') : [],
    overrides: (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {},
    custom: Array.isArray(raw.custom) ? raw.custom.filter((c) => c && c.id && c.field && c.operator) : [],
    caps: { ...base.caps, ...(raw.caps || {}) },
    thresholds: { ...base.thresholds, ...(raw.thresholds || {}) },
  };
}

/** The rules that will actually run, with policy weights and severities applied. */
export function activeRules(policy) {
  const p = normalisePolicy(policy);
  const shipped = RULES.map((rule) => {
    const o = p.overrides[rule.id] || {};
    return {
      ...rule,
      severity: o.severity || rule.severity,
      weight: o.weight === undefined || o.weight === null ? rule.weight : Number(o.weight),
    };
  });
  const custom = p.custom.map(compileCustomRule);
  return [...shipped, ...custom].filter((r) => !p.disabled.includes(r.id));
}

/** Every rule the policy knows about, including the ones switched off. */
export function allRules(policy) {
  const p = normalisePolicy(policy);
  const shipped = RULES.map((rule) => {
    const o = p.overrides[rule.id] || {};
    return {
      ...rule,
      severity: o.severity || rule.severity,
      weight: o.weight === undefined || o.weight === null ? rule.weight : Number(o.weight),
      enabled: !p.disabled.includes(rule.id),
      modified: Boolean(o.severity || o.weight !== undefined),
    };
  });
  const custom = p.custom.map((def) => ({
    ...compileCustomRule(def),
    enabled: !p.disabled.includes(def.id),
    modified: false,
  }));
  return [...shipped, ...custom];
}

export function bandsFor(policy) {
  const p = normalisePolicy(policy);
  return BANDS
    .map((b) => ({ ...b, min: Number(p.thresholds[b.key] ?? b.min) }))
    .sort((a, b) => b.min - a.min);
}

export function capsFor(policy) {
  return normalisePolicy(policy).caps;
}

/* ---------------------------------------------------------- persistence */
export function loadPolicy() {
  try {
    const raw = globalThis.localStorage?.getItem(POLICY_STORAGE_KEY);
    return raw ? normalisePolicy(JSON.parse(raw)) : defaultPolicy();
  } catch {
    // A private window, blocked site data, or corrupt JSON must never stop the
    // tool screening an invoice - it just falls back to the shipped rule set.
    return defaultPolicy();
  }
}

export function savePolicy(policy) {
  try {
    globalThis.localStorage?.setItem(POLICY_STORAGE_KEY, JSON.stringify(normalisePolicy(policy)));
    return true;
  } catch {
    return false;
  }
}

export function policyIsCustomised(policy) {
  const p = normalisePolicy(policy);
  const base = defaultPolicy();
  return p.disabled.length > 0
    || Object.keys(p.overrides).length > 0
    || p.custom.length > 0
    || JSON.stringify(p.caps) !== JSON.stringify(base.caps)
    || JSON.stringify(p.thresholds) !== JSON.stringify(base.thresholds);
}
