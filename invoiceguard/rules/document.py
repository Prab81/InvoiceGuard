"""Layer 4 - content and business logic.

Arithmetic, identity numbers, contact channels, numbering and - specific to
construction lending - whether the progress claim makes sense against the stage
schedule and what has already been drawn.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..models import ExtractedInvoice, Finding
from ..reference import URGENCY_LANGUAGE, classify_stage, validate_abn

# Substitutions a look-alike domain typically relies on.
_HOMOGLYPHS = str.maketrans({"0": "o", "1": "l", "5": "s", "3": "e", "4": "a"})


def _skeleton(s: str) -> str:
    """Collapse a domain to the shape a human eye actually reads."""
    return s.translate(_HOMOGLYPHS).replace("rn", "m").replace("vv", "w")


def _domain(email: str | None) -> str | None:
    return email.split("@", 1)[1].lower() if email and "@" in email else None


def _lookalike(a: str, b: str) -> bool:
    if a == b:
        return False
    ratio = SequenceMatcher(None, a, b).ratio()
    return ratio >= 0.8 or _skeleton(a) == _skeleton(b)


def evaluate(inv: ExtractedInvoice, ctx) -> list[Finding]:
    out: list[Finding] = []
    base = ctx.baseline

    # ---- arithmetic ------------------------------------------------------
    if inv.subtotal is not None and inv.gst is not None:
        expected = round(inv.subtotal * 0.10, 2)
        if abs(expected - inv.gst) > 0.02:
            out.append(Finding(
                code="DOC_GST_MISMATCH",
                title="GST is not 10% of the subtotal",
                layer="document", severity="high", weight=20,
                evidence=f"Subtotal {inv.subtotal:,.2f} implies GST {expected:,.2f}; invoice states {inv.gst:,.2f}.",
                recommendation="An edited amount that misses one of the totals leaves exactly this trace.",
            ))
    if inv.subtotal is not None and inv.gst is not None and inv.total is not None:
        if abs((inv.subtotal + inv.gst) - inv.total) > 0.02:
            out.append(Finding(
                code="DOC_TOTAL_MISMATCH",
                title="Subtotal plus GST does not equal the invoice total",
                layer="document", severity="high", weight=22,
                evidence=f"{inv.subtotal:,.2f} + {inv.gst:,.2f} = {inv.subtotal + inv.gst:,.2f}, stated total {inv.total:,.2f}.",
            ))
    if inv.total is not None and inv.amount_due is not None:
        paid = inv.payments_applied or 0.0
        if abs((inv.total - paid) - inv.amount_due) > 0.02:
            out.append(Finding(
                code="DOC_AMOUNT_DUE_MISMATCH",
                title="Amount due does not reconcile to total less payments",
                layer="document", severity="high", weight=18,
                evidence=f"Total {inv.total:,.2f} less payments {paid:,.2f} = {inv.total - paid:,.2f}, stated due {inv.amount_due:,.2f}.",
            ))
    if inv.line_items:
        line_sum = sum(li.amount for li in inv.line_items if li.amount is not None)
        if inv.subtotal is not None and line_sum and abs(line_sum - inv.subtotal) > 0.02:
            out.append(Finding(
                code="DOC_LINES_DONT_SUM",
                title="Line items do not sum to the subtotal",
                layer="document", severity="high", weight=18,
                evidence=f"Line items total {line_sum:,.2f} against a stated subtotal of {inv.subtotal:,.2f}.",
            ))

    # ---- identity numbers -------------------------------------------------
    if inv.supplier_abn:
        if not validate_abn(inv.supplier_abn):
            out.append(Finding(
                code="DOC_ABN_INVALID",
                title="ABN fails the ATO checksum",
                layer="document", severity="critical", weight=30,
                evidence=f"ABN {inv.supplier_abn} is not a valid Australian Business Number.",
                recommendation="Reject: this is not a valid tax invoice and the GST is not claimable.",
            ))
        elif base and base.abn and re.sub(r"\D", "", base.abn) != re.sub(r"\D", "", inv.supplier_abn):
            out.append(Finding(
                code="DOC_ABN_CHANGED",
                title="ABN differs from the ABN on file for this supplier",
                layer="document", severity="critical", weight=28,
                evidence=f"On file {base.abn}; this invoice {inv.supplier_abn}.",
                recommendation="Check the ABR for a related entity; otherwise treat as a different party entirely.",
            ))
    else:
        out.append(Finding(
            code="DOC_ABN_MISSING",
            title="No ABN on the document",
            layer="document", severity="medium", weight=12,
            evidence="A compliant Australian tax invoice must show the supplier's ABN.",
        ))

    if base and base.licence and inv.supplier_licence and base.licence != inv.supplier_licence:
        out.append(Finding(
            code="DOC_LICENCE_CHANGED",
            title="Builder licence number differs from the one on file",
            layer="document", severity="medium", weight=12,
            evidence=f"On file {base.licence}; this invoice {inv.supplier_licence}.",
            recommendation="Verify against the state building-licence register.",
        ))

    # ---- contact channels -------------------------------------------------
    if base and base.emails and inv.supplier_email and inv.supplier_email not in base.emails:
        new_dom = _domain(inv.supplier_email) or ""
        known_doms = {_domain(e) for e in base.emails if _domain(e)}
        if any(_lookalike(new_dom, d) for d in known_doms):
            out.append(Finding(
                code="DOC_LOOKALIKE_DOMAIN",
                title="Contact email uses a look-alike domain",
                layer="document", severity="critical", weight=35,
                evidence=f"'{new_dom}' closely resembles the known domain(s) {', '.join(sorted(known_doms))}.",
                recommendation=("Classic thread-hijack setup. Any reply goes to the attacker. Escalate and "
                                "warn the borrower directly by phone."),
            ))
        else:
            out.append(Finding(
                code="DOC_CONTACT_CHANGED",
                title="Contact email differs from the address on file",
                layer="document", severity="medium", weight=12,
                evidence=f"On file: {', '.join(base.emails)}. This invoice: {inv.supplier_email}.",
            ))
    if base and base.phones and inv.supplier_phone and inv.supplier_phone not in base.phones:
        out.append(Finding(
            code="DOC_PHONE_CHANGED",
            title="Contact phone number differs from the number on file",
            layer="document", severity="high", weight=16,
            evidence=f"On file: {', '.join(base.phones)}. This invoice: {inv.supplier_phone}.",
            recommendation="Never call back on a number printed on the document under review.",
        ))

    # ---- numbering and dates ---------------------------------------------
    if inv.invoice_date and inv.due_date:
        terms = (inv.due_date - inv.invoice_date).days
        if terms < 0:
            out.append(Finding(
                code="DOC_DUE_BEFORE_ISSUE",
                title="Due date is before the invoice date",
                layer="document", severity="high", weight=18,
                evidence=f"Issued {inv.invoice_date}, due {inv.due_date}.",
            ))
        elif base and base.payment_terms_days:
            usual = sorted(base.payment_terms_days)[len(base.payment_terms_days) // 2]
            if terms < usual - 3:
                out.append(Finding(
                    code="DOC_TERMS_SHORTENED",
                    title="Payment terms are shorter than this supplier's norm",
                    layer="document", severity="medium", weight=10,
                    evidence=f"{terms}-day terms against a usual {usual} days. Compressed terms reduce the time available to check.",
                ))

    already_on_file = bool(base and inv.meta.sha256 and inv.meta.sha256 in base.document_hashes)
    if already_on_file:
        out.append(Finding(
            code="DOC_ALREADY_ACCEPTED",
            title="This exact file is already recorded as accepted for this supplier",
            layer="document", severity="info", weight=-8,
            evidence=f"Content hash {inv.meta.sha256[:16]}... matches a document already in the baseline.",
            recommendation="Re-presentation of a document the bank has already cleared.",
        ))

    if base and base.invoice_numbers and inv.invoice_number and not already_on_file:
        if inv.invoice_number in base.invoice_numbers:
            out.append(Finding(
                code="DOC_DUPLICATE_NUMBER",
                title="Invoice number has already been presented",
                layer="document", severity="high", weight=25,
                evidence=f"{inv.invoice_number} appears in this supplier's history.",
                recommendation="Duplicate presentment - check whether the original was already paid.",
            ))
        else:
            out.extend(_sequence_check(inv, base))

    # ---- construction progress claim -------------------------------------
    out.extend(_stage_checks(inv, base) if not already_on_file else [])

    # ---- language ---------------------------------------------------------
    if URGENCY_LANGUAGE.search(inv.text):
        m = URGENCY_LANGUAGE.search(inv.text)
        out.append(Finding(
            code="DOC_URGENCY_LANGUAGE",
            title="Document uses pressure language",
            layer="document", severity="low", weight=6,
            evidence=f"Matched '{m.group(0)}'. Urgency is used to push a payment past the normal checks.",
        ))

    if inv.parse_warnings:
        out.append(Finding(
            code="DOC_PARSE_INCOMPLETE",
            title="Some fields could not be read",
            layer="document", severity="info", weight=0,
            evidence=" ".join(inv.parse_warnings),
            recommendation="Findings below are limited to what could be extracted; review manually.",
        ))

    return out


def _sequence_check(inv: ExtractedInvoice, base) -> list[Finding]:
    """Compare invoice-number velocity against elapsed time."""
    out: list[Finding] = []

    def numeric(s: str) -> int | None:
        digits = re.findall(r"\d+", s or "")
        return int(digits[-1]) if digits else None

    cur_n = numeric(inv.invoice_number or "")
    history = [(numeric(n), d) for n, d in zip(base.invoice_numbers, base.invoice_dates)]
    history = [(n, d) for n, d in history if n is not None and d]
    if cur_n is None or not history or not inv.invoice_date:
        return out

    from datetime import date as _date
    last_n, last_d = max(history, key=lambda t: t[1])
    last_date = _date.fromisoformat(last_d)
    days = (inv.invoice_date - last_date).days
    delta = cur_n - last_n

    if delta < 0 and days > 0:
        out.append(Finding(
            code="DOC_SEQUENCE_REGRESSION",
            title="Invoice number went backwards against its date",
            layer="document", severity="medium", weight=14,
            evidence=f"{inv.invoice_number} dated {inv.invoice_date} follows number {last_n} dated {last_date}.",
        ))
    elif days >= 60 and 0 < delta <= 8:
        out.append(Finding(
            code="DOC_SEQUENCE_VELOCITY_LOW",
            title="Invoice numbering barely advanced over a long gap",
            layer="document", severity="medium", weight=11,
            evidence=(f"Only {delta} invoice number(s) issued across {days} days. An active builder issues "
                      f"many more; a number picked to look plausible often lands close to the last one seen."),
            detail={"delta": delta, "days": days},
        ))
    return out


def _stage_checks(inv: ExtractedInvoice, base) -> list[Finding]:
    out: list[Finding] = []
    stages = [classify_stage(li.description) for li in inv.line_items]
    stages = [s for s in stages if s]
    if not stages:
        return out
    name, order = stages[0]

    if base and name in base.stages_claimed:
        out.append(Finding(
            code="DOC_STAGE_ALREADY_CLAIMED",
            title=f"'{name}' stage has already been claimed on this file",
            layer="document", severity="high", weight=24,
            evidence=f"Stages already drawn: {', '.join(base.stages_claimed)}.",
            recommendation="Confirm against the fixed-price contract's stage schedule before releasing funds.",
        ))
    if base and base.stages_claimed:
        from ..reference import CONSTRUCTION_STAGES
        order_of = dict(CONSTRUCTION_STAGES)
        prior_max = max((order_of.get(s, 0) for s in base.stages_claimed), default=0)
        if order > prior_max + 1:
            out.append(Finding(
                code="DOC_STAGE_SKIPPED",
                title="Progress claim skips a stage",
                layer="document", severity="medium", weight=12,
                evidence=(f"Claiming '{name}' when the last stage drawn was at position {prior_max}. "
                          f"Construction draws follow the contract order."),
            ))
    return out
