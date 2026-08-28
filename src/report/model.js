// One report model, two renderers.
//
// Word and PDF differ only in how they draw; what they say has to be identical,
// or the two exports of the same assessment disagree in a file that may end up
// in a dispute. So the content is assembled once, here, as plain blocks.

import { describeCustomRule } from '../engine/policy.js';
import { defaultPolicy } from '../engine/policy.js';

const money = (n) => (n === null || n === undefined
  ? '—' : Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2 }));
const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

function policySummary(policy) {
  const base = defaultPolicy();
  const notes = [];
  if (policy.disabled?.length) {
    notes.push(`${policy.disabled.length} shipped check(s) switched off: ${policy.disabled.join(', ')}.`);
  }
  const tuned = Object.entries(policy.overrides || {});
  if (tuned.length) {
    notes.push('Weights or severities retuned: '
      + tuned.map(([id, o]) => `${id} (${[o.severity && `severity ${o.severity}`, o.weight !== undefined && `weight ${o.weight}`].filter(Boolean).join(', ')})`).join('; ') + '.');
  }
  if (policy.custom?.length) {
    notes.push('Custom checks in force: '
      + policy.custom.map((c) => `${c.title} — ${describeCustomRule(c)}`).join('; ') + '.');
  }
  if (JSON.stringify(policy.thresholds) !== JSON.stringify(base.thresholds)) {
    notes.push('Band thresholds moved from the shipped defaults: '
      + Object.entries(policy.thresholds).map(([k, v]) => `${k} at ${v}`).join(', ') + '.');
  }
  if (JSON.stringify(policy.caps) !== JSON.stringify(base.caps)) {
    notes.push('Layer caps changed: '
      + Object.entries(policy.caps).map(([k, v]) => `${k} ${v}`).join(', ') + '.');
  }
  return notes;
}

export function buildReport(result) {
  const { risk, ledger, coverage, diff, subject, reference, knownGood, notices, policy } = result;
  const triggered = ledger.filter((e) => e.status === 'triggered' && e.polarity !== 'reassuring');
  const reassuring = ledger.filter((e) => e.status === 'triggered' && e.polarity === 'reassuring');
  const generatedAt = new Date();

  const sections = [];

  /* ---- verdict ------------------------------------------------------- */
  sections.push({
    heading: 'Assessment',
    blocks: [
      {
        type: 'kv',
        rows: [
          ['Verdict', `${risk.bandLabel} — risk score ${risk.score} of 100`],
          ['Action', risk.decision],
          ['Invoice screened', subject.filename],
          ['Known-good source', knownGood
            ? (knownGood.source === 'reference-invoice'
              ? `reference invoice${reference ? ` (${reference.filename})` : ''}`
              : 'payment details entered by the reviewer')
            : 'none supplied'],
          ['Checks run', `${coverage.ran} of ${coverage.total} (${coverage.triggered} triggered, `
            + `${coverage.clear} clear, ${coverage.skipped} could not run)`],
          ['Confidence', risk.confidence.text],
          ['Screened at', generatedAt.toLocaleString('en-AU')],
        ],
      },
      {
        type: 'table',
        caption: 'Score by layer',
        columns: ['Layer', 'Contribution'],
        rows: Object.entries(risk.layerScores)
          .sort((a, b) => b[1] - a[1])
          .map(([layer, value]) => [
            ledger.find((e) => e.layer === layer)?.layerLabel || layer,
            `${value > 0 ? '+' : ''}${value}`,
          ]),
      },
    ],
  });

  for (const n of notices || []) {
    sections[0].blocks.push({ type: 'para', tone: n.kind === 'warning' ? 'warn' : 'muted', text: n.text });
  }

  /* ---- triggered rules ----------------------------------------------- */
  const findingBlocks = [];
  if (!triggered.length) {
    findingBlocks.push({ type: 'para', text: 'No risk rule fired. Every check that could run came back clear.' });
  }
  for (const e of triggered) {
    findingBlocks.push({ type: 'finding', severity: e.severity, title: e.title, weight: e.weight, id: e.id });
    findingBlocks.push({ type: 'caption', text: `Parameter: ${e.parameter}` });
    findingBlocks.push({ type: 'para', text: e.evidence });
    if (e.recommendation) findingBlocks.push({ type: 'para', tone: 'muted', text: `Action: ${e.recommendation}` });
  }
  sections.push({ heading: `Rules triggered (${triggered.length})`, blocks: findingBlocks });

  if (reassuring.length) {
    sections.push({
      heading: 'Positive confirmations',
      blocks: reassuring.flatMap((e) => ([
        { type: 'finding', severity: 'info', title: e.title, weight: e.weight, id: e.id },
        { type: 'para', text: e.evidence },
      ])),
    });
  }

  /* ---- comparison ----------------------------------------------------- */
  if (diff) {
    const rows = diff.map((r) => [
      r.field,
      show(r.reference),
      show(r.subject),
      r.same ? 'match' : (r.expected ? 'differs (expected)' : 'CHANGED'),
    ]);
    sections.push({
      heading: 'Attribute comparison against the known-good invoice',
      blocks: [
        {
          type: 'para',
          text: `${diff.filter((r) => !r.same && !r.expected).length} attribute(s) that should have matched do not. `
            + `${diff.filter((r) => !r.same && r.expected).length} difference(s) are normal between two invoices.`,
        },
        { type: 'table', columns: ['Attribute', 'Known good', 'Under review', 'Status'], rows, flagColumn: 3, flagValue: 'CHANGED' },
        ...diff.filter((r) => r.meaning).map((r) => ({
          type: 'para', tone: 'muted', text: `${r.field}: ${r.meaning}`,
        })),
      ],
    });
  }

  /* ---- full ledger ---------------------------------------------------- */
  sections.push({
    heading: `Full rule ledger (${ledger.length} checks)`,
    blocks: [
      {
        type: 'para',
        tone: 'muted',
        text: 'Every check the policy defines, including the ones that could not run and why. '
          + 'A check that silently does not run is worse than one that fails loudly.',
      },
      {
        type: 'table',
        columns: ['Status', 'Check', 'Rule id', 'Parameter or reason'],
        rows: ledger.map((e) => [
          e.status === 'triggered' ? (e.polarity === 'reassuring' ? 'cleared' : 'TRIGGERED') : e.status,
          e.title,
          e.id,
          e.status === 'skipped' ? e.reason : e.parameter,
        ]),
        flagColumn: 0,
        flagValue: 'TRIGGERED',
      },
    ],
  });

  /* ---- documents ------------------------------------------------------ */
  const docBlocks = (d, label) => ([
    { type: 'subheading', text: label },
    {
      type: 'kv',
      rows: [
        ['Account name', show(d.payment.accountName)],
        ['Bank', show(d.payment.bankPrinted)],
        ['BSB', show(d.payment.bsbPrinted || d.payment.bsb)],
        ['Account number', show(d.payment.accountNumber)],
        ['Supplier', show(d.supplierName)],
        ['ABN', show(d.supplierAbn)],
        ['Contact', `${show(d.supplierEmail)}  ${show(d.supplierPhone)}`],
        ['Invoice number', show(d.invoiceNumber)],
        ['Dated', `${show(d.invoiceDate)} — due ${show(d.dueDate)}`],
        ['Amount due', money(d.amountDue)],
        ['PDF producer', show(d.meta.producer)],
        ['PDF creator', show(d.meta.creator)],
        ['Title / author', `${show(d.meta.title)} / ${show(d.meta.author)}`],
        ['PDF version', `${show(d.meta.pdfVersion)}, ${d.meta.pageCount || 1} page(s)`],
        ['File size', `${d.byteSize.toLocaleString()} bytes`],
        ['Created / modified', `${show(d.meta.creationDate)} / ${show(d.meta.modDate)}`],
        ['Incremental saves', String(d.meta.incrementalUpdates)],
        ['Fonts', show((d.layout.bodyFonts || []).join(', '))],
        ['SHA-256', d.sha256],
      ],
    },
  ]);

  sections.push({
    heading: 'Documents',
    blocks: [
      ...docBlocks(subject, 'Read from the invoice under review'),
      ...(reference ? docBlocks(reference, 'Read from the known-good invoice') : []),
    ],
  });

  /* ---- policy --------------------------------------------------------- */
  const notes = policySummary(policy || defaultPolicy());
  sections.push({
    heading: 'Policy in force',
    blocks: notes.length
      ? [
        { type: 'para', tone: 'warn', text: 'This assessment did NOT use the shipped rule set unchanged:' },
        ...notes.map((t) => ({ type: 'bullet', text: t })),
      ]
      : [{ type: 'para', text: 'The shipped rule set was used unchanged — no checks disabled, no weights retuned, no custom checks.' }],
  });

  return {
    title: 'Invoice screening report',
    subtitle: `${subject.filename} — ${risk.bandLabel}`,
    generatedAt,
    band: risk.band,
    score: risk.score,
    filenameStem: subject.filename.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_'),
    sections,
  };
}
