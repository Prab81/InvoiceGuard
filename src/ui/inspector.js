// The document inspector: findings drawn on the page they came from.
//
// The ledger explains what is wrong. It does not show *where*, and for a lot of
// reviewers that is the difference between reading a verdict and seeing one.
// Every forensic finding already carries page coordinates - the extractor needs
// them to work - so this view renders page one and puts each finding back on the
// spot it came from.

/**
 * Which page region each rule is talking about.
 *
 * Kept here rather than on the rules themselves: where a finding is drawn is a
 * presentation decision, and the engine should not carry one.
 */
const REGION_MAP = {
  PAY_NO_INSTRUMENT: ['paymentBlock'],
  PAY_BSB_UNKNOWN: ['bsb'],
  PAY_BSB_BANK_MISMATCH: ['bsb', 'bank'],
  PAY_ACCOUNT_LENGTH_ODD: ['account'],
  PAY_NAME_MISMATCH: ['accountName'],
  PAY_NAME_REUSED_WITH_NEW_ACCOUNT: ['accountName', 'account'],
  PAY_MULTIPLE_ACCOUNTS_ON_DOC: ['paymentBlock', 'overlays'],
  PAY_ACCOUNT_CHANGED: ['bsb', 'account'],
  PAY_ACCOUNT_CHANGED_SILENTLY: ['paymentBlock'],
  PAY_BANK_CHANGED: ['bank'],
  PAY_ACCOUNT_MATCHES_KNOWN_GOOD: ['bsb', 'account'],

  FOR_HIDDEN_TEXT_UNDER_OVERLAY: ['overlays'],
  FOR_OVERLAY_IN_PAYMENT_ZONE: ['overlays'],
  FOR_OVERPRINTED_TEXT: ['paymentBlock'],
  FOR_FONT_DRIFT_IN_PAYMENT_BLOCK: ['paymentBlock'],
  FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK: ['paymentBlock'],
  FOR_FONT_SIZE_DRIFT_IN_PAYMENT_BLOCK: ['paymentBlock'],
  FOR_TEXT_ALIGNMENT_ANOMALY: ['paymentBlock'],
  FOR_TYPOGRAPHY_OUTLIER_IN_FIGURES: ['figureOutliers'],
  FOR_TEMPLATE_IMAGE_CHANGED: ['header'],
  FOR_TEMPLATE_GEOMETRY_DRIFT: ['paymentBlock'],

  DOC_GST_MISMATCH: ['gst', 'subtotal'],
  DOC_TOTAL_MISMATCH: ['totals'],
  DOC_AMOUNT_DUE_MISMATCH: ['amountDue'],
  DOC_LINES_DONT_SUM: ['totals'],
  DOC_ABN_INVALID: ['abn'],
  DOC_ABN_MISSING: ['header'],
  DOC_ABN_CHANGED: ['abn'],
  DOC_LICENCE_CHANGED: ['licence'],
  DOC_LOOKALIKE_DOMAIN: ['email'],
  DOC_CONTACT_CHANGED: ['email'],
  DOC_PHONE_CHANGED: ['phone'],
  DOC_DUE_BEFORE_ISSUE: ['dueDate'],
  DOC_TERMS_SHORTENED: ['dueDate'],
  DOC_DUPLICATE_NUMBER: ['invoiceNumber'],
  DOC_SEQUENCE_VELOCITY_LOW: ['invoiceNumber'],

  CON_ACCOUNT_NOT_CONTRACTED: ['bsb', 'account'],
  CON_ACCOUNT_MATCHES_CONTRACT: ['bsb', 'account'],
  CON_ABN_MISMATCH: ['abn'],
  CON_LICENCE_MISMATCH: ['licence'],
  CON_CLAIM_EXCEEDS_STAGE: ['totals'],
  CON_CUMULATIVE_EXCEEDS_CONTRACT: ['amountDue'],
};

/** Custom checks point at whichever field they were built to read. */
const FIELD_REGION = {
  'payment.bsb': 'bsb', 'payment.accountNumber': 'account', 'payment.bankPrinted': 'bank',
  'payment.accountName': 'accountName', 'supplierAbn': 'abn', 'supplierLicence': 'licence',
  'supplierEmail': 'email', emailDomain: 'email', supplierPhone: 'phone',
  dueDate: 'dueDate', termsDays: 'dueDate', invoiceNumber: 'invoiceNumber',
  subtotal: 'subtotal', gst: 'gst', amountDue: 'amountDue',
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Every box a finding should highlight, resolved against the page regions. */
function boxesFor(entry, regions) {
  const keys = REGION_MAP[entry.id]
    || (entry.custom && entry.detail?.field && FIELD_REGION[entry.detail.field]
      ? [FIELD_REGION[entry.detail.field]] : null);
  if (!keys) return [];
  const out = [];
  for (const key of keys) {
    const value = regions[key];
    if (!value) continue;
    if (Array.isArray(value[0])) out.push(...value);
    else out.push(value);
  }
  return out.filter((b) => Array.isArray(b) && b.length === 4);
}

export function createInspector({ pdfjs }) {
  let state = null;

  async function render(host, { bytes, doc, ledger }) {
    const regions = doc.layout.regions || {};
    const findings = ledger
      .filter((e) => e.status === 'triggered')
      .map((e) => ({ ...e, boxes: boxesFor(e, regions) }));

    const located = findings.filter((f) => f.boxes.length);
    const unlocated = findings.filter((f) => !f.boxes.length);

    host.innerHTML = `
      <section class="panel inspect">
        <div class="section-title">
          <h3>Inspect the document</h3>
          <div class="inspect-tools">
            <span class="fieldnote">${located.length} of ${findings.length} findings sit on the page</span>
            <button type="button" class="btn btn-quiet btn-small" data-zoom="out">−</button>
            <button type="button" class="btn btn-quiet btn-small" data-zoom="in">+</button>
          </div>
        </div>
        <div class="inspect-legend">
          <b>Click a highlight or a finding — they select each other.</b>
          <span class="fieldnote">Click bare page to clear.</span>
          ${['critical', 'high', 'medium', 'low'].map((sev) =>
            `<span class="sev-${sev}"><i></i>${sev}</span>`).join('')}
        </div>
        <div class="inspect-grid">
          <div class="page-wrap" id="pageWrap">
            <div class="page-stage" id="pageStage">
              <canvas id="pageCanvas"></canvas>
              <div class="hotspots" id="hotspots"></div>
            </div>
          </div>
          <aside class="hot-list" id="hotList">
            ${located.length ? '' : '<p class="fieldnote">No finding could be placed on the page — the issues found are document-level.</p>'}
            ${located.map((f, i) => `
              <button type="button" class="hot-item sev-${f.severity}" data-idx="${i}">
                <span class="hot-pin">${i + 1}</span>
                <span>
                  <span class="hot-title">${esc(f.title)}</span>
                  <span class="hot-evidence">${esc(f.evidence)}</span>
                </span>
              </button>`).join('')}
            ${unlocated.length ? `
              <div class="hot-doclevel">
                <h4>Not on the page</h4>
                <p class="fieldnote">Document-level findings — metadata, the file's own structure, or the contract.</p>
                ${unlocated.map((f) => `<div class="hot-item is-flat sev-${f.severity}">
                  <span class="hot-pin">·</span>
                  <span><span class="hot-title">${esc(f.title)}</span>
                  <span class="hot-evidence">${esc(f.evidence)}</span></span>
                </div>`).join('')}
              </div>` : ''}
          </aside>
        </div>
      </section>`;

    state = { located, doc, host, scale: 1, pdf: null };
    await paint(bytes, host);
    wire(host);
  }

  async function paint(bytes, host) {
    const canvas = host.querySelector('#pageCanvas');
    const wrap = host.querySelector('#pageWrap');
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });

    // Fit the column, then honour the zoom the reviewer chose. clientWidth counts
    // the padding, and the left padding is the badge gutter, so take it back out.
    const pad = getComputedStyle(wrap);
    const inner = (wrap.clientWidth || 520)
      - (parseFloat(pad.paddingLeft) || 0) - (parseFloat(pad.paddingRight) || 0);
    const cssWidth = Math.max(280, inner - 2) * state.scale;
    const cssScale = cssWidth / base.width;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: cssScale * dpr });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${base.height * cssScale}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const stage = host.querySelector('#pageStage');
    stage.style.width = `${cssWidth}px`;
    // Several findings can land on the same place - an overlay draws both the
    // covered-text finding and the shape finding on one rectangle - so the page
    // gets one marker per region carrying every finding on it, rather than
    // identical boxes stacked where only the top one is clickable.
    const byBox = new Map();
    state.located.forEach((f, i) => {
      for (const b of f.boxes) {
        const key = b.map((v) => Math.round(v)).join(',');
        if (!byBox.has(key)) byBox.set(key, { box: b, findings: [] });
        byBox.get(key).findings.push(i);
      }
    });

    // Regions still nest - the payment block contains the BSB line - so paint
    // the largest first and stack smaller ones above, and a click lands on the
    // most specific region under the cursor.
    const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const spots = [...byBox.values()]
      .map((sp) => ({
        ...sp,
        area: Math.max(1, (sp.box[2] - sp.box[0]) * (sp.box[3] - sp.box[1])),
        severity: sp.findings
          .map((i) => state.located[i].severity)
          .sort((a, b) => rank[b] - rank[a])[0],
      }))
      .sort((a, b) => b.area - a.area);
    state.spots = spots;

    // Badges hang in the margin beside their box. Regions stack - the BSB line
    // sits inside the payment block - so badges that would land on top of each
    // other step out into a further lane instead.
    const placed = [];
    for (const sp of spots) {
      const cy = ((sp.box[1] + sp.box[3]) / 2) * cssScale;
      const cx = sp.box[0] * cssScale;
      let lane = 0;
      while (lane < 1 && placed.some((q) => q.lane === lane
        && Math.abs(q.cy - cy) < 20 && Math.abs(q.cx - cx) < 70)) lane += 1;
      placed.push({ cx, cy, lane });
      sp.lane = lane;
    }

    const layer = host.querySelector('#hotspots');
    layer.classList.remove('is-selecting');
    layer.innerHTML = spots.map((sp, z) => {
      const [x0, top, x1, bottom] = sp.box;
      return `<span class="hotspot sev-${sp.severity}" data-spot="${z}"
        data-findings="${sp.findings.join(',')}"
        data-label="${sp.findings.map((i) => i + 1).join('/')}" style="
          --lane:${sp.lane};
          left:${x0 * cssScale}px; top:${top * cssScale}px;
          width:${Math.max(8, (x1 - x0) * cssScale)}px;
          height:${Math.max(8, (bottom - top) * cssScale)}px; z-index:${z + 1}"
        title="${esc(sp.findings.map((i) => state.located[i].title).join(' · '))}"></span>`;
    }).join('');

    await pdf.destroy?.();
  }

  /** Highlight a set of findings, on the page and in the list together. */
  function select(host, indices) {
    const set = new Set(indices.map(String));
    host.querySelectorAll('.hot-item[data-idx]').forEach((el) => {
      el.classList.toggle('is-active', set.has(el.dataset.idx));
    });
    let lead = true;
    host.querySelectorAll('.hotspot').forEach((el) => {
      const on = el.dataset.findings.split(',').some((i) => set.has(i));
      // Drop the class first so the attention pulse replays on a repeat click.
      el.classList.remove('is-active', 'is-lead');
      if (!on) return;
      void el.offsetWidth;
      el.classList.add('is-active');
      // One finding can light two boxes; only the first carries the number, or
      // the two badges land on top of each other.
      if (lead) { el.classList.add('is-lead'); lead = false; }
    });
    host.querySelector('#hotspots')?.classList.add('is-selecting');
    host.querySelector(`.hot-item[data-idx="${indices[0]}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    host.querySelector('.hotspot.is-active')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearSelection(host) {
    host.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active', 'is-lead'));
    host.querySelector('#hotspots')?.classList.remove('is-selecting');
  }

  function wire(host) {
    host.addEventListener('click', (e) => {
      const spot = e.target.closest('.hotspot');
      if (spot) select(host, spot.dataset.findings.split(','));
      const item = e.target.closest('.hot-item[data-idx]');
      if (item) select(host, [item.dataset.idx]);

      if (!spot && !item && e.target.closest('#pageWrap')) clearSelection(host);

      const zoom = e.target.closest('[data-zoom]')?.dataset.zoom;
      if (zoom) {
        state.scale = Math.min(2.4, Math.max(0.6, state.scale + (zoom === 'in' ? 0.25 : -0.25)));
        host.dispatchEvent(new CustomEvent('inspect:zoom', { bubbles: true }));
      }
    });

    function clearHover() {
      host.querySelectorAll('.is-hover, .is-lead-hover')
        .forEach((el) => el.classList.remove('is-hover', 'is-lead-hover'));
    }

    host.addEventListener('mouseleave', clearHover);
    host.addEventListener('mouseover', (e) => {
      const spot = e.target.closest('.hotspot');
      const item = e.target.closest('.hot-item[data-idx]');
      if (!spot && !item) { clearHover(); return; }
      const ids = new Set(spot ? spot.dataset.findings.split(',') : [item.dataset.idx]);
      host.querySelectorAll('.hot-item[data-idx]').forEach((el) => {
        el.classList.toggle('is-hover', ids.has(el.dataset.idx));
      });
      let lead = true;
      host.querySelectorAll('.hotspot').forEach((el) => {
        const on = el.dataset.findings.split(',').some((i) => ids.has(i));
        el.classList.toggle('is-hover', on);
        // As with selection, the number goes on one box, not on every box the
        // finding touches - two badges a few pixels apart are unreadable.
        el.classList.toggle('is-lead-hover', on && (spot ? el === spot : lead));
        if (on) lead = false;
      });
    });
  }

  return { render, repaint: (bytes, host) => paint(bytes, host), get scale() { return state?.scale; } };
}
