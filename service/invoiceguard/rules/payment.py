"""Layer 1 - the payment instrument.

Invoice-redirection fraud has to change one thing: where the money lands. Every
other edit is decoration. These rules therefore carry the heaviest weights, and
the two that matter most compare the instrument against history rather than
against itself.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..models import ExtractedInvoice, Finding
from ..reference import (
    BANK_CHANGE_NOTICE,
    account_digit_range,
    canonical_bank_name,
    lookup_bsb,
)


def _similar(a: str, b: str) -> float:
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


def evaluate(inv: ExtractedInvoice, ctx) -> list[Finding]:
    out: list[Finding] = []
    pay = inv.payment
    base = ctx.baseline

    if not pay.bsb and not pay.account_number and not pay.payid:
        out.append(Finding(
            code="PAY_NO_INSTRUMENT",
            title="No payment instrument found on the invoice",
            layer="payment", severity="medium", weight=10,
            evidence="Neither a BSB/account pair nor a PayID could be read from the document.",
            recommendation="Do not pay from this document. Request a compliant tax invoice.",
        ))
        return out

    bsb_info = lookup_bsb(pay.bsb)
    printed_bank = canonical_bank_name(pay.bank_printed)

    # ---- intrinsic validity ---------------------------------------------
    if pay.bsb and not bsb_info.known:
        out.append(Finding(
            code="PAY_BSB_UNKNOWN",
            title="BSB is not in the institution registry",
            layer="payment", severity="high", weight=22,
            evidence=f"BSB {pay.bsb_printed or pay.bsb} does not map to a known Australian institution.",
            recommendation="Reject. A valid Australian invoice must quote an allocated BSB.",
            detail={"bsb": pay.bsb},
        ))
    if bsb_info.known and printed_bank and bsb_info.institution != printed_bank:
        out.append(Finding(
            code="PAY_BSB_BANK_MISMATCH",
            title="Printed bank name does not match the BSB",
            layer="payment", severity="high", weight=26,
            evidence=(f"The invoice says '{pay.bank_printed}' but BSB {pay.bsb_printed or pay.bsb} "
                      f"belongs to {bsb_info.institution}."),
            recommendation="Hold payment. This inconsistency is not something a real accounting system produces.",
            detail={"printed": pay.bank_printed, "registry": bsb_info.institution},
        ))
    if pay.account_number and bsb_info.institution:
        lo, hi = account_digit_range(bsb_info.institution)
        n = len(pay.account_number)
        if not (lo <= n <= hi):
            out.append(Finding(
                code="PAY_ACCOUNT_LENGTH_ODD",
                title="Account number length is atypical for the institution",
                layer="payment", severity="low", weight=7,
                evidence=(f"{n} digits quoted; {bsb_info.institution} accounts are normally "
                          f"{lo}-{hi} digits."),
                recommendation="Confirm the account number with the supplier before release.",
            ))

    # ---- account name vs supplier identity -------------------------------
    if pay.account_name and inv.supplier_name:
        ratio = _similar(pay.account_name, inv.supplier_name)
        if ratio < 0.6:
            out.append(Finding(
                code="PAY_NAME_MISMATCH",
                title="Account name does not match the supplier on the invoice",
                layer="payment", severity="high", weight=20,
                evidence=f"Invoice issued by '{inv.supplier_name}' but funds directed to '{pay.account_name}'.",
                recommendation="Third-party payee. Verify assignment/factoring paperwork before paying.",
                detail={"similarity": round(ratio, 2)},
            ))

    # ---- more than one instrument on the page ----------------------------
    distinct_bsbs = [b for b in inv.layout.all_bsb_matches if b]
    if len(distinct_bsbs) > 1:
        out.append(Finding(
            code="PAY_MULTIPLE_ACCOUNTS_ON_DOC",
            title="More than one BSB appears in the page objects",
            layer="payment", severity="critical", weight=40,
            evidence=("BSBs found on the page: " + ", ".join(distinct_bsbs) +
                      ". A genuine single-payee invoice carries one."),
            recommendation=("Treat as tampered. A second account usually means the original details are "
                            "still in the file underneath the replacement."),
            detail={"bsbs": distinct_bsbs},
        ))

    # ---- differential against supplier history ---------------------------
    if not ctx.has_baseline:
        out.append(Finding(
            code="PAY_NO_BASELINE",
            title="No payment history for this supplier",
            layer="payment", severity="info", weight=0,
            evidence=("This supplier has no verified account on file, so the strongest available check - "
                      "'have we paid this account before?' - could not run."),
            recommendation=("Perform a call-back to the number held in the contract (not the invoice) and "
                            "record the confirmed account as the baseline."),
        ))
        if pay.key and not ctx.store.account_is_known_anywhere(pay.bsb, pay.account_number):
            out.append(Finding(
                code="PAY_ACCOUNT_NEW_TO_PORTFOLIO",
                title="Destination account is new to the portfolio",
                layer="payment", severity="low", weight=6,
                evidence=f"BSB {pay.bsb} / account {pay.account_number} has never been used by any payee here.",
                recommendation="Expected for a genuine new supplier; still requires first-payment verification.",
            ))
        return _mule_checks(inv, ctx, out)

    known = base.account(pay.bsb, pay.account_number)
    primary = base.primary_account

    if known and known.verified:
        out.append(Finding(
            code="PAY_ACCOUNT_VERIFIED_MATCH",
            title="Account matches the verified account on file",
            layer="payment", severity="info", weight=-12,
            evidence=(f"BSB {known.bsb} / account {known.account_number} was confirmed out-of-band and has "
                      f"been used on {known.times_seen} prior invoice(s) since {known.first_seen}."),
            recommendation="No payment-side action required.",
        ))
    elif known:
        out.append(Finding(
            code="PAY_ACCOUNT_SEEN_BEFORE",
            title="Account seen before but never verified out-of-band",
            layer="payment", severity="low", weight=4,
            evidence=f"Used on {known.times_seen} prior invoice(s), first seen {known.first_seen}, not call-back verified.",
            recommendation="Verify once and mark as verified so future invoices score cleanly.",
        ))
    else:
        announced = bool(BANK_CHANGE_NOTICE.search(inv.text))
        prior = f"{primary.bsb} / {primary.account_number}" if primary else "the account on file"
        prior_bank = (primary.bank if primary else None) or "the bank on file"
        out.append(Finding(
            code="PAY_ACCOUNT_CHANGED",
            title="Destination account differs from every account on file for this supplier",
            layer="payment", severity="critical", weight=42,
            evidence=(f"This invoice directs payment to {pay.bsb} / {pay.account_number}"
                      f"{' at ' + pay.bank_printed if pay.bank_printed else ''}. "
                      f"{base.name} has been paid at {prior} ({prior_bank}) on "
                      f"{sum(a.times_seen for a in base.accounts)} prior invoice(s)."),
            recommendation=("Hold the drawdown. Call the supplier on the number recorded in the building "
                            "contract - never a number or address taken from this invoice - and confirm the "
                            "change before any payment is released."),
            detail={
                "new": {"bsb": pay.bsb, "account": pay.account_number, "bank": pay.bank_printed},
                "on_file": ({"bsb": primary.bsb, "account": primary.account_number, "bank": primary.bank}
                            if primary else None),
                "announced_on_invoice": announced,
            },
        ))
        if not announced:
            out.append(Finding(
                code="PAY_ACCOUNT_CHANGED_SILENTLY",
                title="Bank details changed with no change notice on the document",
                layer="payment", severity="high", weight=16,
                evidence=("The account changed but the invoice carries no wording announcing new banking "
                          "details. Legitimate suppliers almost always flag the change; forgers avoid "
                          "drawing attention to it."),
                recommendation="Adds weight to the account-change finding above.",
            ))

        prior_bank_name = canonical_bank_name(primary.bank if primary else None)
        if prior_bank_name and bsb_info.institution and prior_bank_name != bsb_info.institution:
            out.append(Finding(
                code="PAY_BANK_CHANGED",
                title="Receiving institution changed",
                layer="payment", severity="high", weight=14,
                evidence=f"{prior_bank_name} on file, {bsb_info.institution} on this invoice.",
                recommendation="Moving banks mid-contract is uncommon for an established builder.",
            ))

        if pay.account_name and primary and primary.account_name and \
                _similar(pay.account_name, primary.account_name) > 0.95:
            out.append(Finding(
                code="PAY_NAME_REUSED_WITH_NEW_ACCOUNT",
                title="Same account name kept over a changed account number",
                layer="payment", severity="medium", weight=12,
                evidence=(f"Account name '{pay.account_name}' is unchanged while the BSB/account pair is new. "
                          "Keeping the name is how a redirection passes a name-only review."),
                recommendation=("Do not rely on the account name. Confirmation of Payee will not clear this: "
                                "the name is only checked against the destination bank's record, which the "
                                "mule account may well match."),
            ))

    return _mule_checks(inv, ctx, out)


def _mule_checks(inv: ExtractedInvoice, ctx, out: list[Finding]) -> list[Finding]:
    """Portfolio-wide: is this account already collecting money for someone else?"""
    pay = inv.payment
    if not pay.key:
        return out
    others = [
        s for s in ctx.store.suppliers_for_account(pay.bsb, pay.account_number)
        if not (ctx.baseline and s.key == ctx.baseline.key)
    ]
    if others:
        out.append(Finding(
            code="PAY_ACCOUNT_SHARED_ACROSS_SUPPLIERS",
            title="Destination account is already used by an unrelated payee",
            layer="payment", severity="critical", weight=45,
            evidence=("BSB {b} / account {a} also appears against: {names}. One account collecting for "
                      "multiple unrelated suppliers is the signature of a mule account.").format(
                          b=pay.bsb, a=pay.account_number, names=", ".join(s.name for s in others)),
            recommendation=("Escalate to financial crime immediately and review every drawdown that has been "
                            "paid to this account across the book."),
            detail={"other_suppliers": [s.name for s in others]},
        ))
    return out
