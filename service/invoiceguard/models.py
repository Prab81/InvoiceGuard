"""Shared data shapes: what we pull out of a PDF, and what a rule emits."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Any

# Severity ordering matters -- scoring.py relies on it.
SEVERITIES = ("info", "low", "medium", "high", "critical")

LAYERS = ("payment", "metadata", "forensics", "document", "compare")


@dataclass
class Finding:
    code: str
    title: str
    layer: str
    severity: str
    weight: float
    evidence: str
    recommendation: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PaymentInstrument:
    account_name: str | None = None
    bank_printed: str | None = None
    bsb: str | None = None          # normalised, 6 digits
    bsb_printed: str | None = None
    account_number: str | None = None
    payid: str | None = None
    bpay_biller: str | None = None
    reference_note: str | None = None

    @property
    def key(self) -> str | None:
        if self.bsb and self.account_number:
            return f"{self.bsb}:{self.account_number}"
        return None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["key"] = self.key
        return d


@dataclass
class LineItem:
    description: str
    unit_price: float | None = None
    gst_rate: float | None = None
    amount: float | None = None


@dataclass
class DocumentMeta:
    filename: str = ""
    byte_size: int = 0
    sha256: str = ""
    pdf_version: str | None = None
    page_count: int = 0
    title: str | None = None
    author: str | None = None
    subject: str | None = None
    creator: str | None = None
    producer: str | None = None
    creation_date: str | None = None
    mod_date: str | None = None
    has_xmp: bool = False
    xmp_document_id: str | None = None
    xmp_instance_id: str | None = None
    xmp_history_events: int = 0
    encrypted: bool = False
    has_signature: bool = False
    eof_markers: int = 0
    xref_sections: int = 0
    incremental_updates: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LayoutFacts:
    """Geometry / render-level observations used by the forensics layer."""
    page_width: float = 0.0
    page_height: float = 0.0
    body_fonts: list[str] = field(default_factory=list)
    payment_block_fonts: list[str] = field(default_factory=list)
    payment_block_bbox: tuple[float, float, float, float] | None = None
    overlays_over_payment: list[dict[str, Any]] = field(default_factory=list)
    covered_text_snippets: list[str] = field(default_factory=list)
    invisible_text_snippets: list[str] = field(default_factory=list)
    all_bsb_matches: list[str] = field(default_factory=list)
    all_account_matches: list[str] = field(default_factory=list)
    line_gap_anomaly: float | None = None
    overprint_ratio: float = 0.0
    text_layers: list[dict[str, Any]] = field(default_factory=list)
    payment_candidates: list[dict[str, Any]] = field(default_factory=list)
    typography: dict[str, Any] = field(default_factory=dict)
    image_count: int = 0
    image_hashes: list[str] = field(default_factory=list)
    full_page_image: bool = False
    text_char_count: int = 0
    annotation_texts: list[str] = field(default_factory=list)
    label_anchors: dict[str, tuple[float, float]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExtractedInvoice:
    meta: DocumentMeta = field(default_factory=DocumentMeta)
    layout: LayoutFacts = field(default_factory=LayoutFacts)
    payment: PaymentInstrument = field(default_factory=PaymentInstrument)

    supplier_name: str | None = None
    supplier_abn: str | None = None
    supplier_licence: str | None = None
    supplier_email: str | None = None
    supplier_phone: str | None = None
    supplier_address: str | None = None

    customer_name: str | None = None
    site_address: str | None = None

    invoice_number: str | None = None
    invoice_reference: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None

    subtotal: float | None = None
    gst: float | None = None
    total: float | None = None
    payments_applied: float | None = None
    amount_due: float | None = None
    line_items: list[LineItem] = field(default_factory=list)

    text: str = ""
    parse_warnings: list[str] = field(default_factory=list)

    @property
    def supplier_key(self) -> str | None:
        """Prefer ABN -- it survives a renamed trading entity."""
        import re
        if self.supplier_abn:
            digits = re.sub(r"\D", "", self.supplier_abn)
            if len(digits) == 11:
                return f"abn:{digits}"
        if self.supplier_name:
            return "name:" + re.sub(r"[^a-z0-9]", "", self.supplier_name.lower())
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "meta": self.meta.to_dict(),
            "layout": self.layout.to_dict(),
            "payment": self.payment.to_dict(),
            "supplier": {
                "name": self.supplier_name,
                "abn": self.supplier_abn,
                "licence": self.supplier_licence,
                "email": self.supplier_email,
                "phone": self.supplier_phone,
                "address": self.supplier_address,
                "key": self.supplier_key,
            },
            "customer": {"name": self.customer_name, "site_address": self.site_address},
            "invoice": {
                "number": self.invoice_number,
                "reference": self.invoice_reference,
                "date": self.invoice_date.isoformat() if self.invoice_date else None,
                "due_date": self.due_date.isoformat() if self.due_date else None,
            },
            "amounts": {
                "subtotal": self.subtotal,
                "gst": self.gst,
                "total": self.total,
                "payments_applied": self.payments_applied,
                "amount_due": self.amount_due,
            },
            "line_items": [asdict(li) for li in self.line_items],
            "parse_warnings": self.parse_warnings,
        }
