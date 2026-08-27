'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { subject: null, reference: null, last: null };

const SAMPLE_META = {
  'authentic_INV-101538.pdf': { label: 'Genuine — ANZ, first-generation export', tag: 'good' },
  'authentic_INV-101540.pdf': { label: 'Genuine — second invoice on file', tag: 'good' },
  'authentic_INV-101551.pdf': { label: 'Genuine — never seen before (true negative)', tag: 'good' },
  'fraudulent_INV-101544.pdf': { label: 'Forged — re-rendered, Commonwealth account', tag: 'bad' },
  'tampered_INV-101541.pdf': { label: 'Tampered — patch pasted over payment block', tag: 'bad' },
};

/* ------------------------------------------------------------------ utils */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function esc(v) {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const show = (v) => esc(v) ?? '<span class="na">not present</span>';
const bytes = (n) => (n ? `${Number(n).toLocaleString()} bytes` : '—');
const money = (n) => (n === null || n === undefined ? null : Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2 }));

/* ------------------------------------------------------------- dropzones */
function wireDrop(zoneId, inputId, role) {
  const zone = $(zoneId);
  const input = $(inputId);

  const set = (file) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast('Only PDF files can be screened.');
      return;
    }
    state[role] = file;
    zone.classList.add('filled');
    zone.querySelector('.drop-body').innerHTML =
      `<div class="fname">${esc(file.name)}</div><div class="fsize">${bytes(file.size)}</div>`;
    refreshButtons();
  };

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => set(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', (e) => set(e.dataTransfer.files[0]));
}

function refreshButtons() {
  $('#analyzeBtn').disabled = !state.subject;
  $('#acceptBtn').disabled = !state.subject;
}

/* --------------------------------------------------------------- requests */
async function post(url, body, method = 'POST') {
  const res = await fetch(url, { method, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { detail: text }; }
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}

async function analyze() {
  const btn = $('#analyzeBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Analysing';
  try {
    const fd = new FormData();
    fd.append('invoice', state.subject);
    if (state.reference) fd.append('reference', state.reference);
    const hint = $('#supplierHint').value.trim();
    if (hint) fd.append('supplier_hint', hint);
    render(await post('/api/analyze', fd));
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = original;
    refreshButtons();
  }
}

async function analyzeSample(name) {
  try {
    const fd = new FormData();
    fd.append('name', name);
    if (state.referenceSample) fd.append('reference_name', state.referenceSample);
    render(await post('/api/analyze/sample', fd));
  } catch (err) { toast(err.message); }
}

async function accept() {
  try {
    const fd = new FormData();
    fd.append('invoice', state.subject);
    fd.append('verified', 'true');
    fd.append('note', 'Marked verified in the InvoiceGuard console.');
    const hint = $('#supplierHint').value.trim();
    if (hint) fd.append('supplier_hint', hint);
    const out = await post('/api/baselines/accept', fd);
    toast(`Baseline updated for ${out.supplier.name} (${out.supplier.invoice_count} on file).`);
    loadBaseline();
  } catch (err) { toast(err.message); }
}

async function loadBaseline() {
  try {
    const { suppliers } = await post('/api/baselines', null, 'GET');
    const el = $('#baselineStatus');
    if (!suppliers.length) {
      el.textContent = 'baseline: empty';
      el.className = 'pill pill-warn';
      return;
    }
    const invoices = suppliers.reduce((n, s) => n + s.invoice_count, 0);
    el.textContent = `baseline: ${suppliers.length} supplier${suppliers.length > 1 ? 's' : ''}, ${invoices} invoice${invoices > 1 ? 's' : ''}`;
    el.className = 'pill pill-ok';
  } catch { /* status is cosmetic */ }
}

async function loadSamples() {
  try {
    const { samples } = await post('/api/samples', null, 'GET');
    const list = $('#sampleList');
    list.innerHTML = '';
    samples.forEach((name) => {
      const meta = SAMPLE_META[name] || { label: name, tag: 'good' };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sample';
      btn.innerHTML = `<span>${esc(meta.label)}</span><span class="tag tag-${meta.tag}">${
        meta.tag === 'bad' ? 'fraud' : 'genuine'}</span>`;
      btn.addEventListener('click', () => analyzeSample(name));
      list.appendChild(btn);
    });
  } catch { /* samples are optional */ }
}

/* ---------------------------------------------------------------- render */
function gauge(score, band) {
  const r = 52, circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, score)) / 100 * circ;
  const color = { likely_authentic: 'var(--ok)', review: 'var(--medium)',
                  suspicious: 'var(--high)', high_risk: 'var(--critical)' }[band] || 'var(--accent)';
  return `<div class="gauge">
    <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--border)" stroke-width="11"></circle>
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="${color}" stroke-width="11"
              stroke-linecap="round" stroke-dasharray="${filled} ${circ}"></circle>
    </svg>
    <div class="val"><div class="num">${Math.round(score)}</div><div class="of">risk score</div></div>
  </div>`;
}

function findingCard(f) {
  const rec = f.recommendation
    ? `<div class="rec"><b>Action:</b> ${esc(f.recommendation)}</div>` : '';
  const weight = f.weight === 0 ? 'no score impact'
    : `${f.weight > 0 ? '+' : ''}${f.weight} pts`;
  return `<article class="finding sev-${f.severity}">
    <div class="finding-head">
      <span class="sev">${f.severity}</span>
      <span class="finding-title">${esc(f.title)}</span>
      <span class="weight">${weight}</span>
    </div>
    <div class="code">${esc(f.code)}</div>
    <div class="evidence">${esc(f.evidence)}</div>
    ${rec}
  </article>`;
}

function layerBars(risk) {
  const rows = Object.entries(risk.layer_scores)
    .sort((a, b) => b[1] - a[1])
    .map(([layer, value]) => {
      const pct = Math.max(0, Math.min(100, (value / 62) * 100));
      return `<div class="layer-row">
        <span class="name">${esc(risk.layer_labels[layer] || layer)}</span>
        <span class="bar"><span style="width:${pct}%"></span></span>
        <span class="score">${value > 0 ? '+' : ''}${value}</span>
      </div>`;
    }).join('');
  return `<div class="layers">${rows}</div>`;
}

function fieldsPanel(doc, title) {
  const p = doc.payment, inv = doc.invoice, m = doc.meta, s = doc.supplier, a = doc.amounts;
  return `<section class="panel">
    <h3 class="section-title">${esc(title)}</h3>
    <div class="grid-2">
      <div>
        <h4 style="font-size:13px;margin-bottom:6px">Payment instrument</h4>
        <dl class="kv">
          <dt>Account name</dt><dd>${show(p.account_name)}</dd>
          <dt>Bank</dt><dd>${show(p.bank_printed)}</dd>
          <dt>BSB</dt><dd class="mono">${show(p.bsb_printed || p.bsb)}</dd>
          <dt>Account</dt><dd class="mono">${show(p.account_number)}</dd>
          ${p.payid ? `<dt>PayID</dt><dd class="mono">${show(p.payid)}</dd>` : ''}
        </dl>
        <h4 style="font-size:13px;margin:14px 0 6px">Invoice</h4>
        <dl class="kv">
          <dt>Supplier</dt><dd>${show(s.name)}</dd>
          <dt>ABN</dt><dd class="mono">${show(s.abn)}</dd>
          <dt>Licence</dt><dd class="mono">${show(s.licence)}</dd>
          <dt>Contact</dt><dd>${show(s.email)} ${s.phone ? esc(s.phone) : ''}</dd>
          <dt>Number</dt><dd class="mono">${show(inv.number)}</dd>
          <dt>Dated</dt><dd>${show(inv.date)} → due ${show(inv.due_date)}</dd>
          <dt>Amount due</dt><dd>${show(money(a.amount_due))}</dd>
        </dl>
      </div>
      <div>
        <h4 style="font-size:13px;margin-bottom:6px">File</h4>
        <dl class="kv">
          <dt>Filename</dt><dd>${show(m.filename)}</dd>
          <dt>Size</dt><dd>${bytes(m.byte_size)}</dd>
          <dt>PDF version</dt><dd>${show(m.pdf_version)} · ${m.page_count} page(s)</dd>
          <dt>Producer</dt><dd>${show(m.producer)}</dd>
          <dt>Creator</dt><dd>${show(m.creator)}</dd>
          <dt>Title</dt><dd>${show(m.title)}</dd>
          <dt>Author</dt><dd>${show(m.author)}</dd>
          <dt>Created</dt><dd class="mono">${show(m.creation_date)}</dd>
          <dt>Modified</dt><dd class="mono">${show(m.mod_date)}</dd>
          <dt>Incremental saves</dt><dd>${m.incremental_updates}</dd>
          <dt>SHA-256</dt><dd class="mono">${esc(m.sha256.slice(0, 32))}…</dd>
        </dl>
      </div>
    </div>
  </section>`;
}

function baselinePanel(base) {
  if (!base) {
    return `<section class="panel">
      <h3 class="section-title">Supplier baseline</h3>
      <p style="font-size:13.5px;color:var(--text-dim)">
        No history on file for this supplier, so the account-change check could not run.
        Verify the account by calling the number in the building contract, then use
        <b>Mark verified &amp; learn</b> so the next invoice is measured against it.
      </p>
    </section>`;
  }
  const rows = base.accounts.map((a) => `<tr>
    <td class="mono">${esc(a.bsb)}</td>
    <td class="mono">${esc(a.account_number)}</td>
    <td>${show(a.bank)}</td>
    <td>${a.times_seen}</td>
    <td>${a.verified ? '<span class="pill pill-ok">verified</span>' : '<span class="pill pill-muted">unverified</span>'}</td>
  </tr>`).join('');
  return `<section class="panel">
    <h3 class="section-title">Supplier baseline — ${esc(base.name)}</h3>
    <dl class="kv" style="margin-bottom:12px">
      <dt>Invoices on file</dt><dd>${base.invoice_count}</dd>
      <dt>Known producers</dt><dd>${show(base.producers.join(', '))}</dd>
      <dt>Known authors</dt><dd>${show(base.authors.join(', '))}</dd>
      <dt>Known contacts</dt><dd>${show(base.emails.concat(base.phones).join(', '))}</dd>
      <dt>Stages drawn</dt><dd>${show(base.stages_claimed.join(', '))}</dd>
    </dl>
    <div class="table-wrap"><table>
      <thead><tr><th>BSB</th><th>Account</th><th>Bank</th><th>Seen</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function diffPanel(diff, refRisk) {
  const rows = diff.map((r) => `<tr class="${r.same ? '' : 'differs'}">
    <td>${esc(r.field)}</td>
    <td class="mono">${show(r.reference)}</td>
    <td class="mono">${show(r.subject)}</td>
  </tr>`).join('');
  const differing = diff.filter((r) => !r.same).length;
  return `<section class="panel">
    <h3 class="section-title">Reference comparison — ${differing} of ${diff.length} attributes differ</h3>
    <p style="font-size:13px;color:var(--text-dim);margin-bottom:10px">
      The reference scored <b>${refRisk.score}</b> (${esc(refRisk.band_label)}).
      Everything a supplier's template holds constant between invoices is a control;
      the highlighted rows are where this document broke one.
    </p>
    <div class="table-wrap"><table>
      <thead><tr><th>Attribute</th><th>Reference (known good)</th><th>Under review</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function render(data) {
  state.last = data;
  const risk = data.risk;
  const scored = risk.findings.filter((f) => f.weight !== 0);
  const informational = risk.findings.filter((f) => f.weight === 0);

  const byLayer = {};
  scored.forEach((f) => { (byLayer[f.layer] = byLayer[f.layer] || []).push(f); });
  const order = ['payment', 'forensics', 'metadata', 'document', 'compare'];

  const findingsHtml = order.filter((l) => byLayer[l]).map((l) => `
    <section class="panel">
      <h3 class="section-title">${esc(risk.layer_labels[l] || l)} — ${byLayer[l].length} finding(s)</h3>
      ${byLayer[l].map(findingCard).join('')}
    </section>`).join('');

  const notes = informational.length ? `<section class="panel">
    <h3 class="section-title">Notes</h3>${informational.map(findingCard).join('')}</section>` : '';

  $('#results').innerHTML = `
    <section class="panel band-${risk.band}">
      <div class="verdict">
        ${gauge(risk.score, risk.band)}
        <div>
          <div class="verdict-band">${esc(risk.band_label)}</div>
          <div class="verdict-decision">${esc(risk.decision)}</div>
          <div class="chips">
            <span class="pill pill-muted">${esc(data.document.meta.filename)}</span>
            <span class="pill ${risk.baseline_available ? 'pill-ok' : 'pill-warn'}">${
              risk.baseline_available ? 'supplier history available' : 'no supplier history'}</span>
            <span class="pill pill-muted">confidence: ${esc(risk.confidence)}</span>
            ${data.mode === 'compare' ? '<span class="pill pill-muted">reference comparison</span>' : ''}
          </div>
        </div>
      </div>
      ${layerBars(risk)}
    </section>
    ${findingsHtml}
    ${data.diff ? diffPanel(data.diff, data.reference_risk) : ''}
    ${baselinePanel(data.baseline)}
    ${fieldsPanel(data.document, 'Extracted from the document under review')}
    ${data.reference_document ? fieldsPanel(data.reference_document, 'Extracted from the reference document') : ''}
    ${notes}
  `;
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------------ boot */
wireDrop('#dropSubject', '#fileSubject', 'subject');
wireDrop('#dropReference', '#fileReference', 'reference');
$('#analyzeBtn').addEventListener('click', analyze);
$('#acceptBtn').addEventListener('click', accept);
$('#seedBtn').addEventListener('click', async () => {
  try { await post('/api/baselines/seed', null); toast('Demo payment history loaded.'); loadBaseline(); }
  catch (err) { toast(err.message); }
});
$('#clearBtn').addEventListener('click', async () => {
  try { await post('/api/baselines', null, 'DELETE'); toast('Baseline cleared.'); loadBaseline(); }
  catch (err) { toast(err.message); }
});
loadBaseline();
loadSamples();
