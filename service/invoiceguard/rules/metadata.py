"""Layer 2 - document metadata.

Nothing here is proof on its own: metadata is trivially editable, and honest
suppliers do change software. Its value is corroborative and, in the Harrowgate
case, decisive - the genuine invoice was a first-generation export carrying its
author and title, the forgery was an anonymous re-render at twice the size.
"""
from __future__ import annotations

from ..extract import creation_datetime, creation_vs_mod_gap_hours
from ..models import ExtractedInvoice, Finding
from ..reference import looks_like_accounting_export, match_editor_fingerprint


def evaluate(inv: ExtractedInvoice, ctx) -> list[Finding]:
    out: list[Finding] = []
    meta = inv.meta
    base = ctx.baseline

    # ---- toolchain -------------------------------------------------------
    hit = match_editor_fingerprint(meta.producer, meta.creator)
    if hit:
        label, note = hit
        out.append(Finding(
            code="META_EDITOR_FINGERPRINT",
            title=f"Produced by {label}",
            layer="metadata", severity="medium", weight=13,
            evidence=f"Producer/Creator: '{meta.producer or '-'}' / '{meta.creator or '-'}' - {note}.",
            recommendation="Ask the supplier which system issued the invoice; compare with the answer on file.",
            detail={"producer": meta.producer, "creator": meta.creator, "tool": label},
        ))

    if base and base.producers:
        current = (meta.producer or "").strip()
        if current and current not in base.producers:
            out.append(Finding(
                code="META_PRODUCER_CHANGED",
                title="PDF was produced by different software than this supplier's previous invoices",
                layer="metadata", severity="high", weight=18,
                evidence=(f"On file: {', '.join(base.producers)}. This document: '{current}'."),
                recommendation=("A supplier's billing system rarely changes between invoices. Combine with the "
                                "payment findings before deciding."),
                detail={"on_file": base.producers, "observed": current},
            ))
        elif current and looks_like_accounting_export(meta.producer, meta.creator):
            out.append(Finding(
                code="META_PRODUCER_CONSISTENT",
                title="Producer matches this supplier's usual toolchain",
                layer="metadata", severity="info", weight=-6,
                evidence=f"'{current}' matches the software on file for {base.name}.",
            ))

    # ---- stripped identity ----------------------------------------------
    stripped = []
    if not meta.title:
        stripped.append("Title")
    if not meta.author:
        stripped.append("Author")
    if stripped:
        if base and (base.title_pattern_present or base.authors):
            out.append(Finding(
                code="META_STRIPPED",
                title="Document identity fields were removed",
                layer="metadata", severity="high", weight=15,
                evidence=(f"{' and '.join(stripped)} absent. Previous invoices from {base.name} carried "
                          f"{'a title' if base.title_pattern_present else ''}"
                          f"{' and ' if base.title_pattern_present and base.authors else ''}"
                          f"{'author ' + ', '.join(base.authors) if base.authors else ''}."),
                recommendation="Re-rendering a PDF through an editor is the usual cause of a blank info dictionary.",
                detail={"missing": stripped, "authors_on_file": base.authors},
            ))
        else:
            out.append(Finding(
                code="META_STRIPPED_NO_BASELINE",
                title="Document carries no title or author",
                layer="metadata", severity="low", weight=5,
                evidence=f"{' and '.join(stripped)} absent from the document information dictionary.",
            ))
    elif base and base.authors and meta.author and meta.author not in base.authors:
        out.append(Finding(
            code="META_AUTHOR_UNKNOWN",
            title="Document author is not a known author for this supplier",
            layer="metadata", severity="medium", weight=9,
            evidence=f"Author '{meta.author}'; on file: {', '.join(base.authors)}.",
        ))

    # ---- PDF version -----------------------------------------------------
    if base and base.pdf_versions and meta.pdf_version:
        try:
            newest = max(float(v) for v in base.pdf_versions)
            if float(meta.pdf_version) < newest:
                out.append(Finding(
                    code="META_PDF_VERSION_DOWNGRADE",
                    title="PDF specification version went backwards",
                    layer="metadata", severity="medium", weight=9,
                    evidence=(f"Previous invoices are PDF {', '.join(base.pdf_versions)}; this one is "
                              f"PDF {meta.pdf_version}. A downgrade means the file was re-written by a "
                              f"different generator, not re-exported by the same one."),
                ))
        except ValueError:
            pass

    # ---- file size -------------------------------------------------------
    med = base.median_byte_size() if base else None
    if med and meta.byte_size and meta.page_count:
        ratio = meta.byte_size / med
        if ratio >= 1.8 or ratio <= 0.55:
            out.append(Finding(
                code="META_SIZE_ANOMALY",
                title="File size is far from this supplier's template norm",
                layer="metadata", severity="medium", weight=11,
                evidence=(f"{meta.byte_size:,} bytes against a {med:,}-byte norm for the same one-page "
                          f"template ({ratio:.1f}x). Re-rasterising a page or re-embedding full fonts "
                          f"inflates the file; flattening to a single image shrinks the text and inflates "
                          f"the stream."),
                detail={"bytes": meta.byte_size, "baseline_bytes": med, "ratio": round(ratio, 2)},
            ))

    # ---- dates -----------------------------------------------------------
    gap = creation_vs_mod_gap_hours(meta)
    if gap is not None and gap > 0.05:
        out.append(Finding(
            code="META_MODIFIED_AFTER_CREATION",
            title="Document was modified after it was created",
            layer="metadata", severity="medium", weight=10,
            evidence=f"ModDate is {gap:.1f} hours after CreationDate.",
            recommendation="Accounting exports write both timestamps at once; a gap means a later save.",
        ))

    created = creation_datetime(meta)
    if created and inv.invoice_date:
        delta_days = (created.date() - inv.invoice_date).days
        if delta_days < -1:
            out.append(Finding(
                code="META_CREATED_BEFORE_INVOICE_DATE",
                title="PDF was created before the invoice date printed on it",
                layer="metadata", severity="high", weight=16,
                evidence=f"File created {created.date()}, invoice dated {inv.invoice_date}.",
                recommendation="A document cannot predate the transaction it records.",
            ))
        elif delta_days > 45:
            out.append(Finding(
                code="META_CREATED_LONG_AFTER_INVOICE_DATE",
                title="PDF was created long after the printed invoice date",
                layer="metadata", severity="medium", weight=10,
                evidence=f"File created {created.date()}, invoice dated {inv.invoice_date} ({delta_days} days earlier).",
                recommendation="Consistent with an old invoice being re-issued with edits.",
            ))

    # ---- XMP -------------------------------------------------------------
    if meta.has_xmp and meta.xmp_document_id and meta.xmp_instance_id and \
            meta.xmp_document_id != meta.xmp_instance_id and meta.xmp_history_events:
        out.append(Finding(
            code="META_XMP_SAVE_CHAIN",
            title="XMP metadata records a save/edit chain",
            layer="metadata", severity="medium", weight=9,
            evidence=f"{meta.xmp_history_events} recorded history event(s); InstanceID differs from DocumentID.",
        ))

    if meta.encrypted:
        out.append(Finding(
            code="META_ENCRYPTED",
            title="Document carries encryption/permissions",
            layer="metadata", severity="low", weight=4,
            evidence="An owner password or permission flags are set.",
        ))

    return out
