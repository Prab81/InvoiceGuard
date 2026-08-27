"""Rule layers. Each module exposes `evaluate(inv, ctx) -> list[Finding]`."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..baseline import BaselineStore, SupplierBaseline
from ..models import ExtractedInvoice, Finding


@dataclass
class RuleContext:
    store: BaselineStore
    baseline: SupplierBaseline | None = None
    reference: ExtractedInvoice | None = None       # the "known good" doc in compare mode
    reference_baseline: SupplierBaseline | None = None
    notes: dict[str, Any] = field(default_factory=dict)

    @property
    def has_baseline(self) -> bool:
        return bool(self.baseline and self.baseline.is_established())


from . import payment, metadata, forensics, document, compare  # noqa: E402


def evaluate_all(inv: ExtractedInvoice, ctx: RuleContext) -> list[Finding]:
    findings: list[Finding] = []
    for module in (payment, metadata, forensics, document):
        findings.extend(module.evaluate(inv, ctx))
    if ctx.reference is not None:
        findings.extend(compare.evaluate(inv, ctx))
    return findings
