import './styles.css';
// The legacy build avoids very new JS built-ins, so the console works on the
// browsers a bank actually runs, not just the newest Chrome.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extract, setPdfjs } from '../engine/extract.js';
import { analyze } from '../engine/analyze.js';
import { RULES } from '../engine/catalog.js';

/* global __SINGLE_FILE__ */
const SINGLE_FILE = __SINGLE_FILE__;

setPdfjs(pdfjs);

// Normal build: pdf.js parses in a worker, off the UI thread.
// Single-file build: there is no second file to load, so hand pdf.js its own
// message handler and let it parse on the main thread instead.
const pdfReady = SINGLE_FILE
  ? import('pdfjs-dist/legacy/build/pdf.worker.mjs').then(({ WorkerMessageHandler }) => {
      globalThis.pdfjsWorker = { WorkerMessageHandler };
    })
  : import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url').then(({ default: url }) => {
      pdfjs.GlobalWorkerOptions.workerSrc = url;
    });

const $ = (s) => document.querySelector(s);
const state = { subject: null, reference: null, mode: 'reference', last: null, filter: 'all' };

const SAMPLES = [
  { case: 'Harrowgate Homes — the forger controls the document',
    file: 'fraudulent_INV-101544.pdf', ref: 'authentic_INV-101538.pdf',
    name: 'Forged invoice', note: 'Re-rendered anonymously, pays a Commonwealth account' },
  { case: 'Harrowgate Homes — the forger controls the document',
    file: 'tampered_INV-101541.pdf', ref: 'authentic_INV-101538.pdf',
    name: 'Tampered invoice', note: 'White patch pasted over the payment block' },
  { case: 'Harrowgate Homes — the forger controls the document',
    file: 'authentic_INV-101551.pdf', ref: 'authentic_INV-101538.pdf',
    name: 'Genuine invoice', note: 'Never seen before — should come back clean' },
  { case: 'Calderwood Constructions — the attacker also controls the email',
    file: 'fraudulent_INV-2304.pdf', ref: 'authentic_INV-2291.pdf',
    name: 'Email-compromise forgery', note: 'Look-alike reply domain, new bank, 3-day terms, urgency' },
  { case: 'Calderwood Constructions — the attacker also controls the email',
    file: 'authentic_INV-2291.pdf', ref: 'authentic_INV-2291.pdf',
    name: 'Genuine invoice', note: 'The known-good original for this case' },
];

/* ------------------------------------------------------------- helpers */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3600);
}

const esc = (v) => {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};
const show = (v) => esc(v) ?? '<span class="na">not present</span>';
const kb = (n) => `${Number(n).toLocaleString()} bytes`;

/* ---------------------------------------------------------- file input */
function setFile(role, file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    toast('Only PDF files can be screened.');
    return;
  }
  state[role] = file;
  const zone = role === 'subject' ? $('#dropSubject') : $('#dropReference');
  zone.classList.add('filled');
  zone.querySelector('.drop-cta').outerHTML =
    `<div class="drop-cta"><div class="fname">${esc(file.name)}</div><div class="fmeta">${kb(file.size)}</div></div>`;
  refresh();
}

function wireDrop(zoneSel, inputSel, role) {
  const zone = $(zoneSel);
  const input = $(inputSel);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => setFile(role, input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => setFile(role, e.dataTransfer.files[0]));
}

/* ------------------------------------------------- known-good details */
function typedDetails() {
  return {
    bank: $('#kgBank').value.trim(),
    bsb: $('#kgBsb').value.trim(),
    account: $('#kgAccount').value.trim(),
    accountName: $('#kgAccountName').value.trim(),
    abn: $('#kgAbn').value.trim(),
    licence: $('#kgLicence').value.trim(),
    email: $('#kgEmail').value.trim(),
    phone: $('#kgPhone').value.trim(),
  };
}

/** Known-good input is mandatory: without it the decisive check cannot run. */
function blockingReason() {
  if (!state.subject) return 'Add the invoice you want screened.';
  if (state.mode === 'reference') {
    if (!state.reference) return 'Add a known-good invoice from the same supplier, or switch to entering the bank details.';
    return null;
  }
  const d = typedDetails();
  const digits = (v) => v.replace(/\D/g, '');
  if (digits(d.bsb).length !== 6) return 'Enter the known-good BSB — six digits.';
  if (digits(d.account).length < 5) return 'Enter the known-good account number.';
  return null;
}

function refresh() {
  const reason = blockingReason();
  $('#analyseBtn').disabled = Boolean(reason);
  $('#blocker').textContent = reason || '';
}

/* --------------------------------------------------------- run it */
async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

async function screen() {
  const btn = $('#analyseBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Screening';
  try {
    await pdfReady;
    const subject = await extract(await readFile(state.subject), state.subject.name);
    let reference = null;
    let details = null;
    if (state.mode === 'reference' && state.reference) {
      reference = await extract(await readFile(state.reference), state.reference.name);
    } else {
      details = typedDetails();
    }
    render(analyze({ subject, reference, details }));
  } catch (err) {
    console.error(err);
    toast(`Could not screen that file: ${err.message}`);
  } finally {
    btn.textContent = label;
    refresh();
  }
}

async function screenSample(sample) {
  const btn = $('#analyseBtn');
  btn.innerHTML = '<span class="spinner"></span>Screening';
  try {
    const grab = async (name) => {
      if (SINGLE_FILE) {
        const { decodeSample } = await import('./samples.inline.js');
        return decodeSample(name);
      }
      const res = await fetch(`samples/${name}`);
      if (!res.ok) throw new Error(`sample ${name} is missing`);
      return new Uint8Array(await res.arrayBuffer());
    };
    await pdfReady;
    const subject = await extract(await grab(sample.file), sample.file);
    const reference = await extract(await grab(sample.ref), sample.ref);
    render(analyze({ subject, reference }));
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = 'Screen this invoice';
    refresh();
  }
}

/* ---------------------------------------------------------- rendering */
function gauge(score, band) {
  const r = 50, circ = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circ;
  const stroke = {
    likely_authentic: 'var(--clear)', review: 'var(--medium)',
    suspicious: 'var(--high)', high_risk: 'var(--critical)',
  }[band] || 'var(--accent)';
  return `<div class="gauge">
    <svg width="128" height="128" viewBox="0 0 128 128" aria-hidden="true">
      <circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--rule)" stroke-width="11"></circle>
      <circle cx="64" cy="64" r="${r}" fill="none" stroke="${stroke}" stroke-width="11"
              stroke-linecap="round" stroke-dasharray="${filled} ${circ}"></circle>
    </svg>
    <div class="val"><div class="n">${Math.round(score)}</div><div class="of">risk score</div></div>
  </div>`;
}

function findingCard(e) {
  const weight = e.weight === 0 ? 'no score impact'
    : `${e.weight > 0 ? '+' : ''}${e.weight} pts`;
  return `<article class="finding sev-${e.severity}">
    <div class="f-head">
      <span class="sev-tag">${e.polarity === 'reassuring' ? 'cleared' : esc(e.severity)}</span>
      <span class="f-title">${esc(e.title)}</span>
      <span class="f-weight">${weight}</span>
    </div>
    <div class="f-param"><b>Parameter:</b> ${esc(e.parameter)} &nbsp;·&nbsp; ${esc(e.id)}</div>
    <div class="f-evidence">${esc(e.evidence)}</div>
    ${e.recommendation ? `<div class="f-action"><b>Action:</b> ${esc(e.recommendation)}</div>` : ''}
  </article>`;
}

function ledgerSection(ledger) {
  const byLayer = new Map();
  for (const e of ledger) {
    if (state.filter === 'triggered' && e.status !== 'triggered') continue;
    if (state.filter === 'clear' && e.status !== 'clear') continue;
    if (state.filter === 'skipped' && e.status !== 'skipped') continue;
    if (!byLayer.has(e.layerLabel)) byLayer.set(e.layerLabel, []);
    byLayer.get(e.layerLabel).push(e);
  }
  const groups = [...byLayer.entries()].map(([layer, rows]) => {
    const fired = rows.filter((r) => r.status === 'triggered' && r.polarity !== 'reassuring').length;
    return `<div class="ledger-group">
      <h4><span>${esc(layer)}</span><span>${fired} of ${rows.length} triggered</span></h4>
      ${rows.map((e) => {
        const reassuring = e.polarity === 'reassuring' && e.status === 'triggered';
        const statusText = e.status === 'triggered' ? (reassuring ? 'cleared' : 'triggered') : e.status;
        const statusClass = e.status === 'triggered' ? (reassuring ? 'reassuring' : 'triggered') : e.status;
        return `<div class="ledger-row ${e.status === 'triggered' ? (reassuring ? 'is-reassuring' : 'is-triggered') : ''}">
          <span class="lr-status st-${statusClass}">${statusText}</span>
          <span class="lr-title">${esc(e.title)}<span class="lr-id">${esc(e.id)}</span></span>
          <span class="${e.status === 'skipped' ? 'lr-reason' : 'lr-param'}">${esc(e.status === 'skipped' ? e.reason : e.parameter)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
  return groups || '<div class="ledger-group"><h4><span>Nothing in this filter</span></h4></div>';
}

/**
 * Attribute comparison.
 *
 * Two differences are not the same kind of thing. An invoice number and an
 * amount are *supposed* to change between two invoices; a producer string and a
 * letterhead image are not. Colouring both red teaches a reviewer to ignore the
 * colour, so expected differences are shown in grey and only the broken
 * controls are flagged - each with the reason it matters, next to the evidence.
 */
function diffPanel(diff) {
  const unexpected = diff.filter((r) => !r.same && !r.expected);
  const expected = diff.filter((r) => !r.same && r.expected);

  const groups = [];
  for (const row of diff) {
    let g = groups.find((x) => x.key === row.group);
    if (!g) { g = { key: row.group, label: row.groupLabel, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }

  const body = groups.map((g) => {
    const broken = g.rows.filter((r) => !r.same && !r.expected).length;
    const rows = g.rows.map((r) => {
      const cls = r.same ? '' : (r.expected ? 'differs-expected' : 'differs');
      const tag = r.same ? '' : (r.expected
        ? '<span class="diff-tag tag-expected">expected</span>'
        : '<span class="diff-tag tag-broken">changed</span>');
      const why = r.meaning
        ? `<tr class="why"><td></td><td colspan="2">${esc(r.meaning)}</td></tr>`
        : '';
      return `<tr class="${cls}">
        <td>${esc(r.field)} ${tag}</td>
        <td class="v">${show(r.reference)}</td>
        <td class="v">${show(r.subject)}</td>
      </tr>${why}`;
    }).join('');
    return `<tbody class="diff-group">
      <tr class="diff-group-head"><th colspan="3">${esc(g.label)}
        <span>${broken ? `${broken} broken` : 'consistent'}</span></th></tr>
      ${rows}
    </tbody>`;
  }).join('');

  return `<section class="panel">
    <div class="section-title">
      <h3>Attribute comparison against the known-good invoice</h3>
      <span class="fieldnote">${unexpected.length} attribute(s) that should have matched do not.
        ${expected.length} difference(s) are normal between two invoices and are greyed out.</span>
    </div>
    <div class="scroll"><table class="data diff">
      <thead><tr><th>Attribute</th><th>Known good</th><th>Under review</th></tr></thead>
      ${body}
    </table></div>
  </section>`;
}

function detailsPanel(doc, heading) {
  const p = doc.payment;
  return `<section class="panel">
    <div class="section-title"><h3>${esc(heading)}</h3></div>
    <div class="cols">
      <div>
        <h4 style="font-size:13px;margin-bottom:6px">Payment instrument</h4>
        <dl class="kv">
          <dt>Account name</dt><dd>${show(p.accountName)}</dd>
          <dt>Bank</dt><dd>${show(p.bankPrinted)}</dd>
          <dt>BSB</dt><dd class="mono">${show(p.bsbPrinted || p.bsb)}</dd>
          <dt>Account</dt><dd class="mono">${show(p.accountNumber)}</dd>
        </dl>
        <h4 style="font-size:13px;margin:14px 0 6px">Invoice</h4>
        <dl class="kv">
          <dt>Supplier</dt><dd>${show(doc.supplierName)}</dd>
          <dt>ABN</dt><dd class="mono">${show(doc.supplierAbn)}</dd>
          <dt>Licence</dt><dd class="mono">${show(doc.supplierLicence)}</dd>
          <dt>Contact</dt><dd>${show(doc.supplierEmail)} ${esc(doc.supplierPhone) || ''}</dd>
          <dt>Number</dt><dd class="mono">${show(doc.invoiceNumber)}</dd>
          <dt>Dated</dt><dd>${show(doc.invoiceDate)} → due ${show(doc.dueDate)}</dd>
          <dt>Amount due</dt><dd class="num">${show(doc.amountDue == null ? null : doc.amountDue.toLocaleString('en-AU', { minimumFractionDigits: 2 }))}</dd>
        </dl>
      </div>
      <div>
        <h4 style="font-size:13px;margin-bottom:6px">File</h4>
        <dl class="kv">
          <dt>Filename</dt><dd>${show(doc.filename)}</dd>
          <dt>Size</dt><dd class="num">${kb(doc.byteSize)}</dd>
          <dt>PDF version</dt><dd>${show(doc.meta.pdfVersion)} · ${doc.meta.pageCount || 1} page(s)</dd>
          <dt>Producer</dt><dd>${show(doc.meta.producer)}</dd>
          <dt>Creator</dt><dd>${show(doc.meta.creator)}</dd>
          <dt>Title</dt><dd>${show(doc.meta.title)}</dd>
          <dt>Author</dt><dd>${show(doc.meta.author)}</dd>
          <dt>Created</dt><dd class="mono">${show(doc.meta.creationDate)}</dd>
          <dt>Modified</dt><dd class="mono">${show(doc.meta.modDate)}</dd>
          <dt>Incremental saves</dt><dd class="num">${doc.meta.incrementalUpdates}</dd>
          <dt>Fonts</dt><dd class="mono">${show((doc.layout.bodyFonts || []).join(', '))}</dd>
          <dt>SHA-256</dt><dd class="mono">${esc(doc.sha256.slice(0, 24))}…</dd>
        </dl>
      </div>
    </div>
  </section>`;
}

function render(result) {
  state.last = result;
  const { risk, ledger, coverage, notices, diff, subject, reference } = result;

  const triggered = ledger.filter((e) => e.status === 'triggered' && e.polarity !== 'reassuring');
  const reassuring = ledger.filter((e) => e.status === 'triggered' && e.polarity === 'reassuring');

  const layerRows = Object.entries(risk.layerScores)
    .sort((a, b) => b[1] - a[1])
    .map(([layer, value]) => {
      const label = ledger.find((e) => e.layer === layer)?.layerLabel || layer;
      return `<div class="layer-row">
        <span class="nm">${esc(label)}</span>
        <span class="track"><span style="width:${Math.max(0, Math.min(100, (value / 62) * 100))}%"></span></span>
        <span class="sc">${value > 0 ? '+' : ''}${value}</span>
      </div>`;
    }).join('');

  const kgLabel = result.knownGood
    ? (result.knownGood.source === 'reference-invoice' ? 'known-good invoice supplied' : 'known-good details entered')
    : 'no known-good input';

  $('#results').innerHTML = `
    <section class="panel band-${risk.band}">
      <div class="verdict">
        ${gauge(risk.score, risk.band)}
        <div>
          <h2>${esc(risk.bandLabel)}</h2>
          <p class="decision">${esc(risk.decision)}</p>
          <div class="chips">
            <span class="pill pill-quiet">${esc(subject.filename)}</span>
            <span class="pill ${result.knownGood ? 'pill-good' : 'pill-warn'}">${esc(kgLabel)}</span>
            <span class="pill pill-quiet">${coverage.ran} of ${coverage.total} checks ran</span>
            <span class="pill ${triggered.length ? 'pill-bad' : 'pill-good'}">${triggered.length} triggered</span>
            <span class="pill pill-quiet">confidence: ${esc(risk.confidence.level)}</span>
          </div>
        </div>
      </div>
      <div class="layers">${layerRows || '<p class="fieldnote">No layer scored above zero.</p>'}</div>
    </section>

    ${notices.map((n) => `<div class="notice notice-${n.kind}">${esc(n.text)}</div>`).join('')}

    <section class="panel">
      <div class="section-title">
        <h3>Rules triggered — ${triggered.length}</h3>
        <span class="fieldnote">${esc(risk.confidence.text)}</span>
      </div>
      ${triggered.length
        ? triggered.map(findingCard).join('')
        : '<p class="fieldnote">No risk rule fired. Every check that could run came back clear.</p>'}
      ${reassuring.length ? `<div class="section-title" style="margin-top:16px"><h3>Positive confirmations</h3></div>${reassuring.map(findingCard).join('')}` : ''}
    </section>

    <section class="panel">
      <div class="section-title">
        <h3>Full rule ledger — every check, and what it did</h3>
        <div class="filters">
          <button type="button" class="filter" data-filter="all">All ${coverage.total}</button>
          <button type="button" class="filter" data-filter="triggered">Triggered ${coverage.triggered}</button>
          <button type="button" class="filter" data-filter="clear">Clear ${coverage.clear}</button>
          <button type="button" class="filter" data-filter="skipped">Not run ${coverage.skipped}</button>
        </div>
      </div>
      <div class="ledger" id="ledger">${ledgerSection(ledger)}</div>
    </section>

    ${diff ? diffPanel(diff) : ''}

    ${detailsPanel(subject, 'Read from the invoice under review')}
    ${reference ? detailsPanel(reference, 'Read from the known-good invoice') : ''}

    ${subject.warnings.length ? `<div class="notice notice-info">${subject.warnings.map(esc).join(' ')}</div>` : ''}
  `;

  document.querySelectorAll('.filter').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.filter === state.filter);
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === state.filter));
      $('#ledger').innerHTML = ledgerSection(state.last.ledger);
    });
  });
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------- wiring */
wireDrop('#dropSubject', '#fileSubject', 'subject');
wireDrop('#dropReference', '#fileReference', 'reference');

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== state.mode; });
    refresh();
  });
});

document.querySelectorAll('.tabpane[data-pane="details"] input')
  .forEach((input) => input.addEventListener('input', refresh));

$('#intake').addEventListener('submit', (e) => { e.preventDefault(); screen(); });

$('#whyToggle').addEventListener('click', () => {
  const box = $('#whyDetail');
  box.hidden = !box.hidden;
  $('#whyToggle').setAttribute('aria-expanded', String(!box.hidden));
  $('#whyToggle').textContent = box.hidden ? 'See the measured difference' : 'Hide';
});

$('#resetBtn').addEventListener('click', () => {
  state.subject = null;
  state.reference = null;
  ['#dropSubject', '#dropReference'].forEach((sel) => {
    const zone = $(sel);
    zone.classList.remove('filled');
    zone.querySelector('.drop-cta').outerHTML =
      `<p class="drop-cta">${sel === '#dropSubject' ? 'Drop a PDF here, or click to choose' : 'Drop a previous invoice you know is genuine'}</p>`;
  });
  document.querySelectorAll('.tabpane[data-pane="details"] input').forEach((i) => { i.value = ''; });
  $('#fileSubject').value = '';
  $('#fileReference').value = '';
  refresh();
});

const list = $('#sampleList');
let lastCase = null;
SAMPLES.forEach((s) => {
  if (s.case !== lastCase) {
    lastCase = s.case;
    const head = document.createElement('p');
    head.className = 'sample-case';
    head.textContent = s.case;
    list.appendChild(head);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sample';
  btn.innerHTML = `<span><strong>${esc(s.name)}</strong><small>${esc(s.note)}</small></span>`;
  btn.addEventListener('click', () => screenSample(s));
  list.appendChild(btn);
});

$('#ruleCount').textContent = `${RULES.length} checks`;
refresh();
