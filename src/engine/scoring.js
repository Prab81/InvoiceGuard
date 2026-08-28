// Findings -> score, band, decision.
//
// Additive within a layer, capped per layer, then severity overrides the
// arithmetic. Four properties are deliberate:
//   * caps, so no single layer can convict a document on its own;
//   * critical findings are categorical, not cumulative;
//   * negative weights exist, so a clean invoice scores 0 rather than merely low;
//   * confidence is reported separately, so "nothing found" is never confused
//     with "the strongest check could not run".

import { LAYERS } from './catalog.js';

export const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const BANDS = [
  { min: 75, key: 'high_risk', label: 'High risk - block',
    decision: 'Do not release funds. Treat as attempted invoice redirection until proven otherwise.' },
  { min: 50, key: 'suspicious', label: 'Suspicious - hold',
    decision: 'Hold the drawdown and verify the account out of band before any release.' },
  { min: 25, key: 'review', label: 'Review before paying',
    decision: 'Route to a human reviewer and confirm the payment details independently.' },
  { min: 0, key: 'likely_authentic', label: 'Likely authentic',
    decision: 'Nothing inconsistent was found. Normal payment controls still apply.' },
];

export function score(findings, { hasKnownGood, parseWarnings = 0, caps = null, bands = null }) {
  const layerCaps = caps || Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.cap]));
  const bandTable = bands || BANDS;
  const raw = {};
  for (const f of findings) raw[f.layer] = (raw[f.layer] || 0) + f.weight;

  const layerScores = {};
  for (const [layer, value] of Object.entries(raw)) {
    layerScores[layer] = Math.max(-15, Math.min(value, layerCaps[layer] ?? 30));
  }
  let total = Math.max(0, Math.min(100, Object.values(layerScores).reduce((a, b) => a + b, 0)));

  const worst = findings
    .filter((f) => f.weight > 0)
    .reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity]), 0);
  // A critical finding is categorical: it lands in the top band whatever the
  // arithmetic said, and it follows the threshold if the policy moved it.
  const topBand = bandTable[0];
  const reviewBand = bandTable[bandTable.length - 2] || topBand;
  if (worst >= 4) total = Math.max(total, topBand.min + 3);
  else if (worst === 3) total = Math.max(total, reviewBand.min);

  const band = bandTable.find((b) => total >= b.min) || bandTable[bandTable.length - 1];

  const confidence = !hasKnownGood
    ? { level: 'limited', text: 'Limited - no known-good details, so the account-change check could not run.' }
    : parseWarnings
      ? { level: 'medium', text: 'Medium - some fields could not be read from the document.' }
      : { level: 'full', text: 'Full - every applicable check ran.' };

  return {
    score: Math.round(total * 10) / 10,
    band: band.key,
    bandLabel: band.label,
    decision: band.decision,
    layerScores,
    confidence,
    topReasons: findings
      .filter((f) => f.weight > 0)
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.weight - a.weight)
      .slice(0, 4)
      .map((f) => f.title),
  };
}
