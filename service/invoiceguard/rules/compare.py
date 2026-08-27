"""Layer 5 - two-document differential.

Used when the reviewer uploads a known-good invoice alongside the one in
question. This is the mode that needs no history at all: everything a supplier's
template holds constant becomes a control, and the differences are the report.
"""
from __future__ import annotations

from ..models import ExtractedInvoice, Finding


def _row(label: str, a, b) -> dict:
    return {"field": label, "reference": a, "subject": b, "same": (a == b)}


def build_diff(subject: ExtractedInvoice, reference: ExtractedInvoice) -> list[dict]:
    rows = [
        _row("Producer", reference.meta.producer, subject.meta.producer),
        _row("Creator", reference.meta.creator, subject.meta.creator),
        _row("Author", reference.meta.author, subject.meta.author),
        _row("Title", reference.meta.title, subject.meta.title),
        _row("PDF version", reference.meta.pdf_version, subject.meta.pdf_version),
        _row("File size (bytes)", reference.meta.byte_size, subject.meta.byte_size),
        _row("Pages", reference.meta.page_count, subject.meta.page_count),
        _row("Created", reference.meta.creation_date, subject.meta.creation_date),
        _row("Modified", reference.meta.mod_date, subject.meta.mod_date),
        _row("Incremental updates", reference.meta.incremental_updates, subject.meta.incremental_updates),
        _row("Supplier", reference.supplier_name, subject.supplier_name),
        _row("ABN", reference.supplier_abn, subject.supplier_abn),
        _row("Licence", reference.supplier_licence, subject.supplier_licence),
        _row("Email", reference.supplier_email, subject.supplier_email),
        _row("Phone", reference.supplier_phone, subject.supplier_phone),
        _row("Account name", reference.payment.account_name, subject.payment.account_name),
        _row("Bank", reference.payment.bank_printed, subject.payment.bank_printed),
        _row("BSB", reference.payment.bsb, subject.payment.bsb),
        _row("Account number", reference.payment.account_number, subject.payment.account_number),
        _row("Invoice number", reference.invoice_number, subject.invoice_number),
        _row("Invoice date", str(reference.invoice_date), str(subject.invoice_date)),
        _row("Amount due", reference.amount_due, subject.amount_due),
        _row("Body fonts", ", ".join(reference.layout.body_fonts[:4]),
             ", ".join(subject.layout.body_fonts[:4])),
        _row("Payment-block fonts", ", ".join(reference.layout.payment_block_fonts[:4]),
             ", ".join(subject.layout.payment_block_fonts[:4])),
        _row("Embedded image hashes", ", ".join(reference.layout.image_hashes[:3]),
             ", ".join(subject.layout.image_hashes[:3])),
        _row("Payment-block position", str(reference.layout.label_anchors.get("BSB")),
             str(subject.layout.label_anchors.get("BSB"))),
    ]
    return rows


def evaluate(subject: ExtractedInvoice, ctx) -> list[Finding]:
    ref: ExtractedInvoice = ctx.reference
    out: list[Finding] = []

    same_supplier = (
        (subject.supplier_abn and ref.supplier_abn and
         subject.supplier_abn.replace(" ", "") == ref.supplier_abn.replace(" ", ""))
        or (subject.supplier_name and ref.supplier_name and
            subject.supplier_name.lower() == ref.supplier_name.lower())
    )
    if not same_supplier:
        out.append(Finding(
            code="CMP_DIFFERENT_SUPPLIER",
            title="The two documents are not from the same supplier",
            layer="compare", severity="info", weight=0,
            evidence=(f"Reference: {ref.supplier_name or 'unknown'} ({ref.supplier_abn or 'no ABN'}); "
                      f"subject: {subject.supplier_name or 'unknown'} ({subject.supplier_abn or 'no ABN'}). "
                      "Template comparisons below are not meaningful across different issuers."),
        ))
        return out

    if subject.payment.key and ref.payment.key and subject.payment.key != ref.payment.key:
        out.append(Finding(
            code="CMP_PAYMENT_CHANGED",
            title="Payment details differ between the two invoices",
            layer="compare", severity="critical", weight=25,
            evidence=(f"Reference pays {ref.payment.bsb} / {ref.payment.account_number} "
                      f"({ref.payment.bank_printed or 'bank not stated'}); subject pays "
                      f"{subject.payment.bsb} / {subject.payment.account_number} "
                      f"({subject.payment.bank_printed or 'bank not stated'}) - same account name, "
                      f"different destination."),
            recommendation="Confirm by phone against the contract before releasing either payment.",
        ))

    if ref.meta.producer and subject.meta.producer and ref.meta.producer != subject.meta.producer:
        out.append(Finding(
            code="CMP_PRODUCER_CHANGED",
            title="The two files were produced by different software",
            layer="compare", severity="high", weight=14,
            evidence=f"Reference: '{ref.meta.producer}'. Subject: '{subject.meta.producer}'.",
        ))

    if (ref.meta.author or ref.meta.title) and not (subject.meta.author or subject.meta.title):
        out.append(Finding(
            code="CMP_METADATA_STRIPPED",
            title="The subject lost identity metadata the reference carries",
            layer="compare", severity="high", weight=13,
            evidence=(f"Reference carries title '{ref.meta.title or '-'}' / author '{ref.meta.author or '-'}'; "
                      f"the subject carries neither."),
        ))

    if ref.meta.byte_size and subject.meta.byte_size and ref.meta.page_count == subject.meta.page_count:
        ratio = subject.meta.byte_size / ref.meta.byte_size
        if ratio >= 1.8 or ratio <= 0.55:
            out.append(Finding(
                code="CMP_SIZE_DIVERGENCE",
                title="Same one-page template, very different file size",
                layer="compare", severity="medium", weight=10,
                evidence=(f"{ref.meta.byte_size:,} vs {subject.meta.byte_size:,} bytes ({ratio:.1f}x) for the "
                          f"same page count."),
            ))

    ref_imgs, sub_imgs = set(ref.layout.image_hashes), set(subject.layout.image_hashes)
    if ref_imgs and sub_imgs and not (ref_imgs & sub_imgs):
        out.append(Finding(
            code="CMP_LOGO_REENCODED",
            title="Letterhead artwork was re-encoded",
            layer="compare", severity="medium", weight=12,
            evidence=("No embedded image is byte-identical across the two files. The same template exported "
                      "twice reuses the same image stream; a rebuilt page does not."),
        ))

    ref_fonts, sub_fonts = set(ref.layout.body_fonts), set(subject.layout.body_fonts)
    if ref_fonts and sub_fonts and not (ref_fonts & sub_fonts):
        out.append(Finding(
            code="CMP_FONT_SET_CHANGED",
            title="The two documents share no fonts",
            layer="compare", severity="medium", weight=12,
            evidence=f"Reference: {', '.join(sorted(ref_fonts)[:4])}. Subject: {', '.join(sorted(sub_fonts)[:4])}.",
        ))

    a, b = ref.layout.label_anchors.get("BSB"), subject.layout.label_anchors.get("BSB")
    if a and b and (abs(a[0] - b[0]) > 6 or abs(a[1] - b[1]) > 250):
        out.append(Finding(
            code="CMP_TEMPLATE_GEOMETRY_DRIFT",
            title="Payment block sits in a different place on the page",
            layer="compare", severity="medium", weight=10,
            evidence=f"BSB label at {a} in the reference, {b} in the subject.",
        ))

    if ref.supplier_email and subject.supplier_email and ref.supplier_email != subject.supplier_email:
        out.append(Finding(
            code="CMP_CONTACT_CHANGED",
            title="Contact email differs between the two invoices",
            layer="compare", severity="high", weight=15,
            evidence=f"Reference: {ref.supplier_email}. Subject: {subject.supplier_email}.",
        ))

    if not out:
        out.append(Finding(
            code="CMP_CONSISTENT",
            title="The two documents are consistent with a common origin",
            layer="compare", severity="info", weight=-8,
            evidence="Payment details, toolchain, metadata shape, fonts and artwork all line up.",
        ))
    return out
