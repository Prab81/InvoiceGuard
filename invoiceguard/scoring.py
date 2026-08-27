"""Turn findings into a score, a band and a decision.

Design choices that matter for a bank:

* Additive-with-caps, not multiplicative. Each layer is capped so a document
  cannot be condemned by metadata trivia alone, and the payment layer keeps the
  largest cap because it is the only layer a fraudster must trip.
* Severity overrides the arithmetic. One critical finding forces at least the
  "suspicious" band regardless of score, because critical findings here are
  categorical (a second BSB in the file, an invalid ABN, a mule account).
* Negative weights exist. Matching a verified account should actively pull a
  document down, otherwise a clean invoice never scores clean.
* Every point is attributable. The band is never the output on its own - the
  reason codes are, because a declined drawdown has to be explainable to the
  customer, to the broker and to AFCA.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .models import Finding

LAYER_CAPS = {
    "payment": 62.0,
    "forensics": 55.0,
    "metadata": 30.0,
    "document": 40.0,
    "compare": 30.0,
}

LAYER_LABELS = {
    "payment": "Payment instrument",
    "forensics": "Document forensics",
    "metadata": "File metadata",
    "document": "Content & business logic",
    "compare": "Differential vs reference",
}

BANDS = [
    (75, "high_risk", "High risk - block",
     "Do not release funds. Treat as attempted invoice redirection until proven otherwise."),
    (50, "suspicious", "Suspicious - hold",
     "Hold the drawdown and verify the account out-of-band before any release."),
    (25, "review", "Review - verify before paying",
     "Route to a human reviewer; confirm the payment details independently."),
    (0, "likely_authentic", "Likely authentic",
     "Nothing inconsistent found. Normal payment controls still apply."),
]

SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


@dataclass
class RiskResult:
    score: float
    band: str
    band_label: str
    decision: str
    findings: list[Finding] = field(default_factory=list)
    layer_scores: dict[str, float] = field(default_factory=dict)
    top_reasons: list[str] = field(default_factory=list)
    baseline_available: bool = False
    confidence: str = "medium"

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 1),
            "band": self.band,
            "band_label": self.band_label,
            "decision": self.decision,
            "confidence": self.confidence,
            "baseline_available": self.baseline_available,
            "layer_scores": {k: round(v, 1) for k, v in self.layer_scores.items()},
            "layer_labels": LAYER_LABELS,
            "top_reasons": self.top_reasons,
            "findings": [f.to_dict() for f in self.findings],
        }


def score(findings: list[Finding], *, baseline_available: bool) -> RiskResult:
    layer_scores: dict[str, float] = {}
    for f in findings:
        layer_scores[f.layer] = layer_scores.get(f.layer, 0.0) + f.weight

    capped = {
        layer: max(-15.0, min(value, LAYER_CAPS.get(layer, 30.0)))
        for layer, value in layer_scores.items()
    }
    total = max(0.0, min(100.0, sum(capped.values())))

    severity = max((SEVERITY_RANK[f.severity] for f in findings if f.weight > 0), default=0)
    if severity >= 4:
        total = max(total, 78.0)     # a critical finding is categorical
    elif severity == 3:
        total = max(total, 42.0)

    band, band_label, decision = "likely_authentic", BANDS[-1][2], BANDS[-1][3]
    for threshold, key, label, action in BANDS:
        if total >= threshold:
            band, band_label, decision = key, label, action
            break

    ranked = sorted(
        [f for f in findings if f.weight > 0],
        key=lambda f: (SEVERITY_RANK[f.severity], f.weight),
        reverse=True,
    )

    # Confidence describes how much of the model actually got to run.
    if not baseline_available:
        confidence = "low - intrinsic checks only, no supplier history"
    elif any(f.code == "DOC_PARSE_INCOMPLETE" for f in findings):
        confidence = "medium - some fields unreadable"
    else:
        confidence = "high - full check set ran"

    return RiskResult(
        score=total,
        band=band,
        band_label=band_label,
        decision=decision,
        findings=sorted(findings, key=lambda f: (-SEVERITY_RANK[f.severity], -f.weight)),
        layer_scores=capped,
        top_reasons=[f.title for f in ranked[:4]],
        baseline_available=baseline_available,
        confidence=confidence,
    )
