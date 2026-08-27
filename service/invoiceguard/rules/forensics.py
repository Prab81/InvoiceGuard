"""Layer 3 - structural forensics on the page itself.

These are the findings that turn a suspicion into evidence, because they show
the edit rather than infer it: a patch drawn over the payment block, the
original account still recoverable underneath, a font that appears nowhere else
on the page, or an xref chain proving the file was appended to after it was
first written.
"""
from __future__ import annotations

from ..models import ExtractedInvoice, Finding


def evaluate(inv: ExtractedInvoice, ctx) -> list[Finding]:
    out: list[Finding] = []
    lay = inv.layout

    if lay.covered_text_snippets:
        out.append(Finding(
            code="FOR_HIDDEN_TEXT_UNDER_OVERLAY",
            title="Original payment text is still recoverable underneath an overlay",
            layer="forensics", severity="critical", weight=50,
            evidence=("Text sitting beneath an opaque shape in the payment block: "
                      + " | ".join(s[:120] for s in lay.covered_text_snippets)),
            recommendation=("Conclusive tampering. Preserve the file as evidence, block the drawdown and "
                            "report it - the covered text is the genuine account."),
            detail={"snippets": lay.covered_text_snippets},
        ))

    if lay.invisible_text_snippets:
        out.append(Finding(
            code="FOR_INVISIBLE_TEXT",
            title="White or invisible text present on the page",
            layer="forensics", severity="high", weight=20,
            evidence="Non-rendering text found: " + " | ".join(lay.invisible_text_snippets[:3]),
            recommendation="Often the remains of a replaced field, or content hidden from a human reviewer.",
        ))

    overlays = [o for o in lay.overlays_over_payment if o.get("covered_chars", 1) > 0 or o["kind"] == "image"]
    if overlays:
        out.append(Finding(
            code="FOR_OVERLAY_IN_PAYMENT_ZONE",
            title="A shape or image is drawn over the payment-details block",
            layer="forensics", severity="high", weight=24,
            evidence=(f"{len(overlays)} object(s) intersect the payment block: "
                      + "; ".join(f"{o['kind']} at {o['bbox']}" for o in overlays[:3])),
            recommendation="Inspect the region visually against a known-good invoice from the same supplier.",
            detail={"overlays": overlays[:6]},
        ))

    if lay.payment_block_fonts and lay.body_fonts:
        from ..extract import font_family
        block_fams = {font_family(f) for f in lay.payment_block_fonts if f}
        body_fams = {font_family(f) for f in lay.body_fonts if f}
        exclusive = sorted(block_fams - body_fams)
        # A block that still shares a family with the page is a partial patch;
        # FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK owns that case, so this rule
        # fires only when the entire block was replaced.
        if exclusive and not (block_fams & body_fams):
            out.append(Finding(
                code="FOR_FONT_DRIFT_IN_PAYMENT_BLOCK",
                title="Payment block uses a font that appears nowhere else on the page",
                layer="forensics", severity="high", weight=22,
                evidence=(f"Fonts unique to the payment block: {', '.join(exclusive)}. Body fonts: "
                          f"{', '.join(lay.body_fonts[:4])}."),
                recommendation=("A single template renders one font set. A separate font in exactly the block "
                                "that matters means those characters were typed in later."),
                detail={"exclusive": exclusive, "body": lay.body_fonts},
            ))

    typo = lay.typography or {}
    detail_sizes = typo.get("payment_detail_sizes") or []
    if len(detail_sizes) > 1:
        out.append(Finding(
            code="FOR_FONT_SIZE_DRIFT_IN_PAYMENT_BLOCK",
            title="Payment details are set at more than one point size",
            layer="forensics", severity="high", weight=20,
            evidence=("The payment block mixes "
                      + ", ".join(f"{size}pt on {n} run(s)" for size, n in detail_sizes)
                      + f". One template renders the whole block at {detail_sizes[0][0]}pt."),
            recommendation=("A forger retyping inside the same tool keeps the typeface and misses the "
                            "point size. Compare the block against a known-good invoice."),
            detail={"sizes": detail_sizes},
        ))

    detail_fonts = typo.get("payment_detail_fonts") or []
    if len(detail_fonts) > 1:
        out.append(Finding(
            code="FOR_FONT_FAMILY_DRIFT_IN_PAYMENT_BLOCK",
            title="Payment details are set in more than one typeface family",
            layer="forensics", severity="high", weight=20,
            evidence=("The payment block mixes "
                      + ", ".join(f"{font} on {n} run(s)" for font, n in detail_fonts)
                      + ". Weight changes are normal; a second family is not."),
            recommendation="Those characters were typed in later, in a different tool from the one that made the page.",
            detail={"fonts": detail_fonts},
        ))

    figure_outliers = typo.get("figure_outliers") or []
    if figure_outliers and (typo.get("figure_count") or 0) >= 3:
        out.append(Finding(
            code="FOR_TYPOGRAPHY_OUTLIER_IN_FIGURES",
            title="A monetary figure is set differently from every other figure",
            layer="forensics", severity="high", weight=18,
            evidence=(f"Every other amount on this page is set in {typo.get('dominant_figure_font')} at "
                      f"{typo.get('dominant_figure_size')}pt. These are not: "
                      + "; ".join(f"\"{o['text']}\" in {o['font']} at {o['size']}pt" for o in figure_outliers)
                      + "."),
            recommendation=("An amount that does not match the rest of its own column was written after the "
                            "page was. Check it against the contract stage schedule before releasing funds."),
            detail={"outliers": figure_outliers},
        ))

    if lay.line_gap_anomaly is not None and lay.line_gap_anomaly > 0.35:
        out.append(Finding(
            code="FOR_TEXT_ALIGNMENT_ANOMALY",
            title="Line spacing inside the payment block is irregular",
            layer="forensics", severity="medium", weight=12,
            evidence=(f"Largest line-gap deviation is {lay.line_gap_anomaly * 100:.0f}% from the block median; "
                      f"machine-generated blocks hold a constant leading."),
        ))

    if inv.meta.incremental_updates > 0:
        out.append(Finding(
            code="FOR_INCREMENTAL_UPDATE",
            title="File was appended to after it was first saved",
            layer="forensics", severity="high", weight=20,
            evidence=(f"{inv.meta.eof_markers} %%EOF markers and {inv.meta.xref_sections} cross-reference "
                      f"section(s): {inv.meta.incremental_updates} incremental update(s)."),
            recommendation=("The earlier revision is still inside the file and can be reconstructed - do that "
                            "before contacting the supplier."),
        ))

    if lay.full_page_image:
        out.append(Finding(
            code="FOR_PAGE_FLATTENED",
            title="Page is a flattened image rather than a text document",
            layer="forensics", severity="medium", weight=14,
            evidence=("The page carries no usable text layer. Flattening destroys the evidence an edit would "
                      "otherwise leave, and it is not how an accounting system emits an invoice."),
            recommendation="Request the original PDF from the supplier's accounting system.",
        ))

    if lay.annotation_texts:
        out.append(Finding(
            code="FOR_ANNOTATION_TEXT",
            title="Annotations carry visible content",
            layer="forensics", severity="medium", weight=12,
            evidence="Annotation content: " + " | ".join(lay.annotation_texts[:3]),
            recommendation="Text can be placed over a page as an annotation without touching the content stream.",
        ))

    if ctx.baseline and ctx.baseline.logo_hashes and inv.layout.image_hashes:
        if not set(inv.layout.image_hashes) & set(ctx.baseline.logo_hashes):
            out.append(Finding(
                code="FOR_TEMPLATE_IMAGE_CHANGED",
                title="Letterhead artwork does not byte-match this supplier's template",
                layer="forensics", severity="medium", weight=13,
                evidence=("None of the embedded images match the image hashes recorded from this supplier's "
                          "previous invoices - the logo was re-encoded, which happens when a page is "
                          "rebuilt rather than re-exported."),
                detail={"observed": inv.layout.image_hashes[:4], "on_file": ctx.baseline.logo_hashes[:4]},
            ))

    return out
