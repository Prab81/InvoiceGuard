"""Orchestration: bytes in, risk assessment out."""
from __future__ import annotations

from typing import Any

from .baseline import BaselineStore
from .extract import extract
from .rules import RuleContext, evaluate_all
from .rules.compare import build_diff
from .scoring import RiskResult, score


def analyze_single(
    data: bytes,
    filename: str,
    store: BaselineStore,
    supplier_hint: str | None = None,
) -> dict[str, Any]:
    inv = extract(data, filename, supplier_hint=supplier_hint)
    baseline = store.get_supplier(inv.supplier_name, inv.supplier_abn)
    ctx = RuleContext(store=store, baseline=baseline)
    findings = evaluate_all(inv, ctx)
    result: RiskResult = score(findings, baseline_available=ctx.has_baseline)
    return {
        "mode": "single",
        "document": inv.to_dict(),
        "baseline": baseline.to_dict() if baseline else None,
        "risk": result.to_dict(),
    }


def analyze_pair(
    subject_data: bytes,
    subject_name: str,
    reference_data: bytes,
    reference_name: str,
    store: BaselineStore,
    supplier_hint: str | None = None,
) -> dict[str, Any]:
    subject = extract(subject_data, subject_name, supplier_hint=supplier_hint)
    reference = extract(reference_data, reference_name, supplier_hint=supplier_hint)

    baseline = store.get_supplier(subject.supplier_name, subject.supplier_abn)
    ctx = RuleContext(store=store, baseline=baseline, reference=reference)
    findings = evaluate_all(subject, ctx)
    result = score(findings, baseline_available=ctx.has_baseline or True)

    ref_ctx = RuleContext(store=store, baseline=store.get_supplier(reference.supplier_name, reference.supplier_abn))
    ref_findings = evaluate_all(reference, ref_ctx)
    ref_result = score(ref_findings, baseline_available=ref_ctx.has_baseline)

    return {
        "mode": "compare",
        "document": subject.to_dict(),
        "reference_document": reference.to_dict(),
        "baseline": baseline.to_dict() if baseline else None,
        "risk": result.to_dict(),
        "reference_risk": ref_result.to_dict(),
        "diff": build_diff(subject, reference),
    }


def which_is_reference(a, b) -> tuple[Any, Any]:
    """Pick the more credible of two documents as the reference.

    Preference order: an established verified baseline match, then a first
    generation accounting export, then the earlier invoice date.
    """
    from .reference import looks_like_accounting_export

    a_export = looks_like_accounting_export(a.meta.producer, a.meta.creator)
    b_export = looks_like_accounting_export(b.meta.producer, b.meta.creator)
    if a_export != b_export:
        return (a, b) if a_export else (b, a)
    if a.invoice_date and b.invoice_date and a.invoice_date != b.invoice_date:
        return (a, b) if a.invoice_date < b.invoice_date else (b, a)
    return a, b
