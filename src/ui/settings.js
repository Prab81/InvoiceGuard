// The settings panel: which checks run, how hard they score, and any the bank
// has added of its own.

import { LAYERS } from '../engine/catalog.js';
import {
  RULE_FIELDS, RULE_OPERATORS, allRules, defaultPolicy, describeCustomRule,
  normalisePolicy, policyIsCustomised, savePolicy,
} from '../engine/policy.js';
import { MIME, inSandboxedFrame, readTextFile, saveFile } from './export.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createSettings({ getPolicy, setPolicy, onChange, toast }) {
  const root = document.createElement('div');
  root.className = 'settings-overlay';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Detection policy settings');
  document.body.appendChild(root);

  let draft = normalisePolicy(getPolicy());

  const close = () => { root.hidden = true; document.body.style.overflow = ''; };
  const open = () => {
    draft = normalisePolicy(getPolicy());
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    render();
    root.querySelector('.settings-panel')?.focus();
  };

  const commit = ({ rerun = true } = {}) => {
    setPolicy(draft);
    if (!savePolicy(draft)) {
      toast('Settings applied for this session — this browser would not let the page save them.');
    }
    render();
    if (rerun) onChange();
  };

  /* -------------------------------------------------------------- render */
  function ruleRow(rule) {
    const layerName = LAYERS[rule.layer]?.label || rule.layer;
    return `<tr class="rule-row ${rule.enabled ? '' : 'is-off'}" data-rule="${esc(rule.id)}">
      <td class="rule-toggle">
        <label class="switch"><input type="checkbox" data-act="toggle" ${rule.enabled ? 'checked' : ''}
          aria-label="Enable ${esc(rule.title)}"><span></span></label>
      </td>
      <td>
        <div class="rule-title">${esc(rule.title)}
          ${rule.custom ? '<span class="tagline tag-custom">custom</span>' : ''}
          ${rule.modified ? '<span class="tagline tag-tuned">tuned</span>' : ''}</div>
        <div class="rule-meta"><code>${esc(rule.id)}</code> · ${esc(layerName)}</div>
        <div class="rule-param">${esc(rule.parameter)}</div>
      </td>
      <td>
        <select data-act="severity" aria-label="Severity for ${esc(rule.title)}">
          ${SEVERITIES.map((s) => `<option value="${s}" ${s === rule.severity ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" data-act="weight" value="${rule.weight}" step="1" min="-30" max="80"
        aria-label="Weight for ${esc(rule.title)}"></td>
      <td>${rule.custom ? '<button type="button" class="btn-icon" data-act="delete" title="Delete this check">Delete</button>' : ''}</td>
    </tr>`;
  }

  function render() {
    const rules = allRules(draft);
    const byLayer = Object.keys(LAYERS).map((key) => ({
      key,
      label: LAYERS[key].label,
      blurb: LAYERS[key].blurb,
      rules: rules.filter((r) => r.layer === key),
    })).filter((g) => g.rules.length);

    const enabled = rules.filter((r) => r.enabled).length;

    root.innerHTML = `
      <div class="settings-panel" tabindex="-1">
        <header class="settings-head">
          <div>
            <h2>Detection policy</h2>
            <p>${enabled} of ${rules.length} checks enabled${
              policyIsCustomised(draft) ? ' · <b class="tuned-flag">customised from the shipped set</b>' : ' · shipped set, unchanged'}</p>
          </div>
          <div class="settings-actions">
            <button type="button" class="btn btn-quiet" data-act="export-policy">Export</button>
            <button type="button" class="btn btn-quiet" data-act="import-policy">Import</button>
            <button type="button" class="btn btn-quiet" data-act="reset">Reset to defaults</button>
            <button type="button" class="btn btn-primary" data-act="done">Done</button>
          </div>
        </header>

        <div class="settings-body">
          <section class="settings-block">
            <h3>Bands and caps</h3>
            <p class="fieldnote">Thresholds decide which band a score lands in. Layer caps stop any one
              layer convicting a document on its own.</p>
            <div class="tune-grid">
              ${[['high_risk', 'Block at'], ['suspicious', 'Hold at'], ['review', 'Review at']].map(([k, label]) => `
                <label class="field"><span>${label}</span>
                  <input type="number" data-act="threshold" data-key="${k}" value="${draft.thresholds[k]}" min="1" max="100"></label>`).join('')}
              ${Object.entries(LAYERS).map(([k, v]) => `
                <label class="field"><span>${esc(v.label)} cap</span>
                  <input type="number" data-act="cap" data-key="${k}" value="${draft.caps[k]}" min="0" max="100"></label>`).join('')}
            </div>
          </section>

          <section class="settings-block">
            <h3>Add a check</h3>
            <p class="fieldnote">
              Checks are declarative, not code: pick a field, a comparison and a value. That keeps a
              policy safe to share and safe to load. Anything needing new evidence from the page
              itself — overlays, hidden text, typography profiling — has to be added to the engine.
            </p>
            <form class="add-rule" id="addRuleForm">
              <div class="tune-grid">
                <label class="field wide"><span>What to call it</span>
                  <input name="title" placeholder="Producer must be the supplier's accounting system" required></label>
                <label class="field"><span>Field</span>
                  <select name="field">${RULE_FIELDS.map((f) => `<option value="${f.id}">${esc(f.group)} — ${esc(f.label)}</option>`).join('')}</select></label>
                <label class="field"><span>Comparison</span>
                  <select name="operator">${RULE_OPERATORS.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select></label>
                <label class="field"><span>Value</span>
                  <input name="value" placeholder="MYOB"></label>
                <label class="field"><span>Layer</span>
                  <select name="layer">${Object.entries(LAYERS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
                <label class="field"><span>Severity</span>
                  <select name="severity">${SEVERITIES.map((s) => `<option value="${s}" ${s === 'high' ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
                <label class="field"><span>Weight</span>
                  <input type="number" name="weight" value="15" min="-30" max="80"></label>
                <label class="field wide"><span>Action for the reviewer <i>optional</i></span>
                  <input name="recommendation" placeholder="Confirm with the supplier before releasing funds."></label>
              </div>
              <div class="add-rule-foot">
                <span class="rule-preview" id="rulePreview"></span>
                <button type="submit" class="btn btn-primary">Add check</button>
              </div>
            </form>
          </section>

          ${byLayer.map((g) => `
            <section class="settings-block">
              <h3>${esc(g.label)} <span class="count">${g.rules.filter((r) => r.enabled).length}/${g.rules.length} on</span></h3>
              <p class="fieldnote">${esc(g.blurb)}</p>
              <div class="scroll"><table class="rules-table">
                <thead><tr><th>On</th><th>Check</th><th>Severity</th><th>Weight</th><th></th></tr></thead>
                <tbody>${g.rules.map(ruleRow).join('')}</tbody>
              </table></div>
            </section>`).join('')}
        </div>
      </div>`;

    wire();
  }

  /* ---------------------------------------------------------------- wiring */
  function updatePreview() {
    const form = root.querySelector('#addRuleForm');
    if (!form) return;
    const def = Object.fromEntries(new FormData(form).entries());
    const op = RULE_OPERATORS.find((o) => o.id === def.operator);
    form.querySelector('[name="value"]').disabled = !op?.needsValue;
    root.querySelector('#rulePreview').textContent = `Fires when: ${describeCustomRule(def)}`;
  }

  function wire() {
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChangeEvent);
    root.addEventListener('input', (e) => {
      if (e.target.closest('#addRuleForm')) updatePreview();
    });
    root.querySelector('#addRuleForm')?.addEventListener('submit', onAddRule);
    updatePreview();
  }

  function onClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const row = e.target.closest('.rule-row');

    if (act === 'done') { close(); return; }
    if (act === 'delete' && row) {
      const id = row.dataset.rule;
      draft.custom = draft.custom.filter((c) => c.id !== id);
      draft.disabled = draft.disabled.filter((d) => d !== id);
      commit();
      toast('Check removed.');
      return;
    }
    if (act === 'reset') {
      draft = defaultPolicy();
      commit();
      toast('Policy reset to the shipped rule set.');
      return;
    }
    if (act === 'export-policy') {
      saveFile(new TextEncoder().encode(JSON.stringify(draft, null, 2)),
        'invoiceguard-policy.json', MIME.json);
      toast(inSandboxedFrame
        ? 'Policy file generated. If nothing downloaded, this preview blocks downloads — use the deployed app.'
        : 'Policy exported to invoiceguard-policy.json.');
      return;
    }
    if (act === 'import-policy') {
      readTextFile()
        .then(({ text }) => {
          draft = normalisePolicy(JSON.parse(text));
          commit();
          toast('Policy imported.');
        })
        .catch((err) => toast(`Could not import that policy: ${err.message}`));
    }
  }

  function onChangeEvent(e) {
    const act = e.target.dataset.act;
    const row = e.target.closest('.rule-row');

    if (act === 'toggle' && row) {
      const id = row.dataset.rule;
      draft.disabled = e.target.checked
        ? draft.disabled.filter((d) => d !== id)
        : [...new Set([...draft.disabled, id])];
      commit();
      return;
    }
    if ((act === 'severity' || act === 'weight') && row) {
      const id = row.dataset.rule;
      const custom = draft.custom.find((c) => c.id === id);
      const value = act === 'weight' ? Number(e.target.value) : e.target.value;
      if (custom) custom[act] = value;
      else draft.overrides = { ...draft.overrides, [id]: { ...draft.overrides[id], [act]: value } };
      commit();
      return;
    }
    if (act === 'threshold') {
      draft.thresholds = { ...draft.thresholds, [e.target.dataset.key]: Number(e.target.value) };
      commit();
      return;
    }
    if (act === 'cap') {
      draft.caps = { ...draft.caps, [e.target.dataset.key]: Number(e.target.value) };
      commit();
    }
  }

  function onAddRule(e) {
    e.preventDefault();
    const def = Object.fromEntries(new FormData(e.target).entries());
    const op = RULE_OPERATORS.find((o) => o.id === def.operator);
    if (!def.title.trim()) { toast('Give the check a name.'); return; }
    if (op?.needsValue && !String(def.value).trim()) { toast('That comparison needs a value.'); return; }
    draft.custom = [...draft.custom, {
      ...def,
      id: `CUSTOM_${Date.now().toString(36).toUpperCase()}`,
      weight: Number(def.weight),
    }];
    commit();
    toast(`Added "${def.title}".`);
  }

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });

  return { open, close };
}
