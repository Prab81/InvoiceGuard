"""Turn a PDF into an ExtractedInvoice: metadata, forensic facts, parsed fields.

Three independent readers are used because each sees something the others miss:
  * raw bytes   -> incremental updates, signature dictionaries, XMP packet
  * pypdf       -> document info dictionary, embedded image streams, page tree
  * pdfplumber  -> characters with fonts and coordinates, rectangles, images
"""
from __future__ import annotations

import hashlib
import io
import re
from datetime import date, datetime
from statistics import median
from typing import Any

import pdfplumber
from pypdf import PdfReader

from .models import DocumentMeta, ExtractedInvoice, LayoutFacts, LineItem, PaymentInstrument
from .reference import normalise_bsb

# --------------------------------------------------------------------------
# regex bank
# --------------------------------------------------------------------------
RE_ABN = re.compile(r"\bABN[:\s]*((?:\d[ \-]?){10}\d)", re.I)
RE_ACN = re.compile(r"\bACN[:\s]*((?:\d[ \-]?){8}\d)", re.I)
RE_LICENCE = re.compile(r"\bLicen[cs]e\s*(?:No\.?|Number)?[:\s]*([A-Z0-9][A-Z0-9\-/]{2,})", re.I)
RE_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
RE_PHONE = re.compile(r"\b(?:Ph|Phone|Tel|Mob(?:ile)?|M)[:.\s]*((?:\+?61[\s-]?)?[\d][\d\s\-()]{7,13})", re.I)
RE_INV_NO = re.compile(r"\bInvoice\s*(?:Number|No\.?|#)[:\s]*([A-Za-z]{0,6}[-\s]?\d[\w\-]*)", re.I)
RE_REFERENCE = re.compile(r"^\s*Reference[:\s]*([\w\-/]+)\s*$", re.I | re.M)
RE_DATE_LABEL = re.compile(r"^\s*Date[:\s]*(.+?)\s*$", re.I | re.M)
RE_DUE = re.compile(r"\bDue\s*Date[:\s]*([0-9A-Za-z/ ]+)", re.I)
RE_MONEY = r"(-?[\d,]+\.\d{2})"
RE_SUBTOTAL = re.compile(r"\bSub\s*-?\s*total\b[^\d\-]*" + RE_MONEY, re.I)
RE_GST = re.compile(r"\bTotal\s*GST\b[^\n]*?" + RE_MONEY, re.I)
RE_TOTAL = re.compile(r"\bInvoice\s*Total\b[^\d\-]*" + RE_MONEY, re.I)
RE_PAYMENTS = re.compile(r"\b(?:Total\s*Net\s*Payments|Less\s*Payments?|Payments?\s*Received)[^\d\-]*" + RE_MONEY, re.I)
RE_AMOUNT_DUE = re.compile(r"\bAmount\s*(?:Due|Payable|Owing)\b[^\d\-]*" + RE_MONEY, re.I)

RE_ACCOUNT_NAME = re.compile(r"\bAccount\s*Name[:\s]*(.+)", re.I)
RE_BANK = re.compile(r"^\s*Bank(?:\s*Name)?[:\s]*([A-Za-z][A-Za-z .&'\-]+)\s*$", re.I | re.M)
RE_BSB = re.compile(r"\bBSB[:\s#]*(\d{3}[\s\-]?\d{3})", re.I)
RE_BSB_LOOSE = re.compile(r"\b(\d{3}[\s\-]\d{3})\b")
RE_ACCOUNT_NO = re.compile(r"\bAcc(?:oun)?t(?:\s*(?:Number|No\.?|#))?[:\s]*(\d[\d\s\-]{4,})", re.I)
RE_PAYID = re.compile(r"\bPay\s*ID[:\s]*([\w@.+\-]+)", re.I)
RE_BPAY = re.compile(r"\bBiller\s*Code[:\s]*(\d{3,10})", re.I)
RE_ENTITY = re.compile(
    r"\b([A-Z][A-Za-z&'\-.]*(?:\s+[A-Z][A-Za-z&'\-.]*){0,4}\s+"
    r"(?:Pty\.?\s*Ltd\.?|Pty\.?\s*Limited|Proprietary\s+Limited|Ltd\.?|Limited))\b"
)

MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

PAYMENT_HEADING = re.compile(r"payment\s*details|remittance|direct\s*deposit|eft\s*details|bank\s*details", re.I)


def parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    raw = raw.strip()
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", raw)
    if m and m.group(2)[:3].lower() in MONTHS:
        return date(int(m.group(3)), MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
    m = re.search(r"([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})", raw)
    if m and m.group(1)[:3].lower() in MONTHS:
        return date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
    m = re.search(r"(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})", raw)
    if m:
        d, mth, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y += 2000 if y < 100 else 0
        try:
            return date(y, mth, d)  # AU convention: day first
        except ValueError:
            return None
    return None


def _money(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _pdf_date(raw: Any) -> str | None:
    if not raw:
        return None
    s = str(raw)
    m = re.match(r"D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?", s)
    if not m:
        return s
    y, mo, d, hh, mm, ss = (m.group(i) or "00" for i in range(1, 7))
    return f"{y}-{mo}-{d}T{hh}:{mm}:{ss}"


def _pdf_date_obj(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso[:19])
    except ValueError:
        return None


# --------------------------------------------------------------------------
# raw byte layer
# --------------------------------------------------------------------------
def _raw_facts(data: bytes) -> dict[str, Any]:
    eof = data.count(b"%%EOF")
    startxref = data.count(b"startxref")
    xref = data.count(b"\nxref") + data.count(b"/Type/XRef") + data.count(b"/Type /XRef")
    version = None
    m = re.match(rb"%PDF-(\d\.\d)", data[:32])
    if m:
        version = m.group(1).decode()
    xmp = b"<x:xmpmeta" in data or b"<?xpacket" in data
    doc_id = inst_id = None
    hist = 0
    if xmp:
        mm = re.search(rb"xmpMM:DocumentID>?[=\"']?([^<\"']+)", data)
        if mm:
            doc_id = mm.group(1).decode("utf-8", "ignore").strip()
        mm = re.search(rb"xmpMM:InstanceID>?[=\"']?([^<\"']+)", data)
        if mm:
            inst_id = mm.group(1).decode("utf-8", "ignore").strip()
        hist = len(re.findall(rb"stEvt:action", data))
    return {
        "eof_markers": eof,
        "startxref": startxref,
        "xref_sections": xref,
        "incremental_updates": max(0, min(eof, startxref) - 1),
        "header_version": version,
        "has_xmp": xmp,
        "xmp_document_id": doc_id,
        "xmp_instance_id": inst_id,
        "xmp_history_events": hist,
        "has_signature": b"/Sig" in data and b"/ByteRange" in data,
    }


# --------------------------------------------------------------------------
# layout layer
# --------------------------------------------------------------------------
RE_FIGURE = re.compile(r"^-?[\d,]+\.\d{2,4}$")


def font_family(name: str | None) -> str:
    """Strip a subset prefix and a weight/style suffix to get the family.

    A genuine template varies weight for emphasis - a bold total is not an
    anomaly - so comparisons are made on the family, never the full PostScript
    name.
    """
    fam = re.sub(r"^[A-Z]{6}\+", "", str(name or ""))
    return re.sub(
        r"[-,_](?:Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Light|Medium|Semibold|Black)$",
        "", fam, flags=re.I).strip()


def _tally(items) -> list[tuple[Any, int]]:
    counts: dict[Any, int] = {}
    for key in items:
        counts[key] = counts.get(key, 0) + 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


def _words(line: list[dict]) -> list[list[dict]]:
    """Split a line into gap-separated runs, so a figure is profiled on its own
    rather than inside whatever label happens to share its line."""
    words: list[list[dict]] = []
    prev = None
    for ch in sorted(line, key=lambda c: c["x0"]):
        gap = ch["x0"] - prev["x1"] if prev else 0
        if prev is None or gap > max(0.8, 0.22 * float(prev.get("size") or 8)):
            words.append([ch])
        else:
            words[-1].append(ch)
        prev = ch
    return words


def _typography(chars: list[dict], detail_chars: list[dict]) -> dict[str, Any]:
    """Typeface family and point size, profiled across the page.

    A forger retyping a field inside the same tool often keeps the typeface and
    misses the point size by a fraction, which a font-name comparison never
    sees.
    """
    rnd = lambda c: round(float(c.get("size") or 0), 1)  # noqa: E731
    body = _tally(f"{font_family(c.get('fontname'))}@{rnd(c)}" for c in chars)
    dom_font, _, dom_size = (body[0][0] if body else "@").partition("@")

    figures = [
        w for ln in _group_lines(chars) for w in _words(ln)
        if RE_FIGURE.match("".join(c["text"] for c in w).strip())
    ]
    fig_profile = _tally(f"{font_family(ln[0].get('fontname'))}@{rnd(ln[0])}" for ln in figures)
    fig_font, _, fig_size = (fig_profile[0][0] if fig_profile else "@").partition("@")

    outliers = [
        {"text": "".join(c["text"] for c in ln).strip(),
         "font": font_family(ln[0].get("fontname")), "size": rnd(ln[0])}
        for ln in figures
        if font_family(ln[0].get("fontname")) != fig_font
        or abs(rnd(ln[0]) - float(fig_size or 0)) > 0.2
    ]
    return {
        "dominant_font": dom_font or None,
        "dominant_size": float(dom_size) if dom_size else None,
        "payment_detail_fonts": _tally(font_family(c.get("fontname")) for c in detail_chars),
        "payment_detail_sizes": _tally(rnd(c) for c in detail_chars),
        "figure_count": len(figures),
        "dominant_figure_font": fig_font or None,
        "dominant_figure_size": float(fig_size) if fig_size else None,
        "figure_outliers": outliers,
    }


def _white(color: Any) -> bool:
    if color is None:
        return False
    if isinstance(color, (int, float)):
        return color > 0.92
    try:
        vals = list(color)
    except TypeError:
        return False
    return bool(vals) and all(isinstance(v, (int, float)) and v > 0.92 for v in vals)


def _group_lines(chars: list[dict], tol: float = 2.0) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for ch in sorted(chars, key=lambda c: (round(c["top"], 1), c["x0"])):
        if lines and abs(lines[-1][0]["top"] - ch["top"]) <= tol:
            lines[-1].append(ch)
        else:
            lines.append([ch])
    return lines


def _line_text(line: list[dict]) -> str:
    """Concatenate a line's glyphs, restoring the word gaps the PDF only implies.

    Without this, positionally separated runs fuse ("HARROWGATEABN 53 173 584 802")
    and every word-boundary-anchored pattern silently stops matching.
    """
    out: list[str] = []
    prev: dict | None = None
    for ch in sorted(line, key=lambda c: c["x0"]):
        if prev is not None:
            gap = ch["x0"] - prev["x1"]
            if gap > max(0.8, 0.22 * float(prev.get("size") or 8)):
                out.append(" ")
        out.append(ch["text"])
        prev = ch
    return "".join(out)


# Digit runs that are emphatically not bank accounts. An ABN prints as 3-3-3 and
# an Australian mobile as 04xx xxx xxx; both contain a perfect BSB-shaped
# substring, so they must be removed before any bare-pattern scan.
RE_IDENTITY_RUN = re.compile(r"\b(?:ABN|ACN|ARBN)[:\s]*(?:\d[ \-]?){8,12}", re.I)
RE_CONTACT_RUN = re.compile(
    r"\b(?:Ph|Phone|Tel|Telephone|Mob(?:ile)?|Fax)[:.\s]*(?:\+?61[\s-]?)?[\d][\d\s\-()]{6,}", re.I)
RE_MOBILE_RUN = re.compile(r"\b(?:\+?61[\s-]?)?0?4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b")


def _strip_identity_numbers(text: str) -> str:
    """Remove digit runs that mimic a BSB but cannot be one."""
    for pattern in (RE_IDENTITY_RUN, RE_CONTACT_RUN, RE_MOBILE_RUN):
        text = pattern.sub(" ", text)
    return text


def _text_layers(chars: list[dict]) -> list[dict]:
    """Reconstruct the page once per (font, size) group.

    When a payment block is patched, the replacement text is drawn on top of the
    original at the same coordinates. Read in reading order the two interleave
    into nonsense ("BBSSBB:: 001674 0-24422"), which defeats every regex. Split
    by the properties that differ between an original and an overlay - typeface
    and point size - and each layer reads cleanly again.
    """
    groups: dict[tuple, list[tuple[int, dict]]] = {}
    for idx, ch in enumerate(chars):
        groups.setdefault((str(ch.get("fontname", "")), round(float(ch.get("size", 0)), 1)), []).append((idx, ch))
    layers = []
    for (font, size), members in groups.items():
        only = [c for _, c in members]
        text = "\n".join(_line_text(ln) for ln in _group_lines(only))
        layers.append({
            "font": font, "size": size, "chars": len(only), "text": text, "members": only,
            # Content-stream position: the later a layer is painted, the more of
            # it a reader actually sees.
            "z": max(i for i, _ in members),
        })
    return layers


def _scan_payment_tokens(text: str) -> tuple[list[str], list[str]]:
    clean = _strip_identity_numbers(text)
    bsbs = {normalise_bsb(m) for m in RE_BSB.findall(clean)}
    if not bsbs:
        bsbs = {normalise_bsb(m) for m in RE_BSB_LOOSE.findall(clean)}
    accounts = {
        re.sub(r"\D", "", m) for m in RE_ACCOUNT_NO.findall(clean)
        if 5 <= len(re.sub(r"\D", "", m)) <= 10
    }
    return sorted(b for b in bsbs if b), sorted(accounts)


def _overprint_ratio(chars: list[dict]) -> float:
    """Fraction of glyphs that sit on top of another glyph."""
    if len(chars) < 20:
        return 0.0
    buckets: dict[float, list[dict]] = {}
    for ch in chars:
        buckets.setdefault(round(ch["top"] / 2.0), []).append(ch)
    overlapping = 0
    for members in buckets.values():
        members.sort(key=lambda c: c["x0"])
        for i in range(len(members) - 1):
            a, b = members[i], members[i + 1]
            width = max(1e-6, a["x1"] - a["x0"])
            if (min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])) / width > 0.55:
                overlapping += 1
    return overlapping / len(chars)


def _layout_facts(pdf: pdfplumber.PDF, visible_text: str) -> LayoutFacts:
    facts = LayoutFacts()
    if not pdf.pages:
        return facts
    page = pdf.pages[0]
    facts.page_width = float(page.width)
    facts.page_height = float(page.height)
    chars = page.chars
    facts.text_char_count = len(chars)

    # ---- payment block region -------------------------------------------
    lines = _group_lines(chars)
    heading_top = None
    for line in lines:
        if PAYMENT_HEADING.search(_line_text(line)):
            heading_top = min(c["top"] for c in line)
            break
    if heading_top is None:
        for line in lines:
            if RE_BSB.search(_line_text(line)):
                heading_top = min(c["top"] for c in line) - 24
                break
    if heading_top is not None:
        block_bottom = min(facts.page_height, heading_top + 140)
        block = [c for c in chars if heading_top - 4 <= c["top"] <= block_bottom]
        facts.payment_block_bbox = (
            min((c["x0"] for c in block), default=0.0) - 4,
            heading_top - 4,
            max((c["x1"] for c in block), default=facts.page_width) + 4,
            block_bottom,
        )
        facts.payment_block_fonts = sorted({str(c.get("fontname", "")) for c in block})
        body = [c for c in chars if c["top"] < heading_top - 4]
        facts.body_fonts = sorted({str(c.get("fontname", "")) for c in body})

        block_lines = [ln for ln in _group_lines(block) if _line_text(ln).strip()]
        detail_lines = [
            ln for ln in block_lines
            if re.match(r"\s*(Account\s*Name|Bank|BSB|Acc(?:oun)?t)\s*[:#]", _line_text(ln), re.I)
        ]
        gaps = [
            detail_lines[i + 1][0]["top"] - detail_lines[i][0]["top"]
            for i in range(len(detail_lines) - 1)
        ]
        gaps = [g for g in gaps if 2 < g < 60]
        if len(gaps) >= 3:
            med = median(gaps)
            if med > 0:
                facts.line_gap_anomaly = max(abs(g - med) / med for g in gaps)
        # Profile every line of the block except its heading and trailing note.
        # Selecting by label regex fails on exactly the documents that matter:
        # pdfplumber yields characters, so a patched line interleaves into
        # nonsense ("BBaannkk::") and stops matching the label it still shows.
        detail_chars = [
            c for ln in block_lines
            for c in ln
            if not PAYMENT_HEADING.search(_line_text(ln))
            and not re.search(r"please use|payment reference", _line_text(ln), re.I)
        ]
        facts.typography = _typography(chars, detail_chars)
        for ln in block_lines:
            txt = _line_text(ln)
            for label in ("Account Name", "Bank", "BSB", "Account"):
                if re.match(rf"\s*{label}\s*[:#]", txt, re.I) and label not in facts.label_anchors:
                    facts.label_anchors[label] = (
                        round(min(c["x0"] for c in ln), 1),
                        round(min(c["top"] for c in ln), 1),
                    )
    else:
        facts.body_fonts = sorted({str(c.get("fontname", "")) for c in chars})
        facts.typography = _typography(chars, [])

    # ---- every payment-looking token anywhere in the page objects --------
    joined = "\n".join(_line_text(ln) for ln in lines)
    bsbs, accounts = _scan_payment_tokens(joined)
    layers = _text_layers(chars)
    facts.text_layers = [
        {"font": l["font"], "size": l["size"], "chars": l["chars"]} for l in layers
    ]
    for layer in layers:
        lb, la = _scan_payment_tokens(layer["text"])
        for b in lb:
            if b not in bsbs:
                bsbs.append(b)
        for a in la:
            if a not in accounts:
                accounts.append(a)
        if lb or la:
            facts.payment_candidates.append({
                "font": layer["font"],
                "z": layer["z"],
                "bsb": lb[0] if lb else None,
                "account": la[0] if la else None,
                "bank": (RE_BANK.search(layer["text"]).group(1).strip()
                         if RE_BANK.search(layer["text"]) else None),
                "account_name": (RE_ACCOUNT_NAME.search(layer["text"]).group(1).strip()
                                 if RE_ACCOUNT_NAME.search(layer["text"]) else None),
            })
    facts.all_bsb_matches = sorted(set(bsbs))
    facts.all_account_matches = sorted(set(accounts))
    facts.overprint_ratio = round(_overprint_ratio(chars), 3)

    # ---- invisible text --------------------------------------------------
    invisible = [c for c in chars if _white(c.get("non_stroking_color")) and c["text"].strip()]
    if invisible:
        facts.invisible_text_snippets = [
            _line_text(ln).strip() for ln in _group_lines(invisible) if _line_text(ln).strip()
        ][:6]

    # ---- overlays sitting on the payment block ---------------------------
    def _intersects(bbox) -> bool:
        if not facts.payment_block_bbox:
            return False
        ax0, ay0, ax1, ay1 = facts.payment_block_bbox
        bx0, by0, bx1, by1 = bbox
        return not (bx1 < ax0 or bx0 > ax1 or by1 < ay0 or by0 > ay1)

    for im in page.images:
        bbox = (im["x0"], im["top"], im["x1"], im["bottom"])
        if _intersects(bbox):
            facts.overlays_over_payment.append(
                {"kind": "image", "bbox": [round(v, 1) for v in bbox],
                 "width": round(im["x1"] - im["x0"], 1), "height": round(im["bottom"] - im["top"], 1)}
            )
        if (im["x1"] - im["x0"]) > 0.85 * facts.page_width and (im["bottom"] - im["top"]) > 0.85 * facts.page_height:
            facts.full_page_image = True
    facts.image_count = len(page.images)

    for rect in page.rects:
        bbox = (rect["x0"], rect["top"], rect["x1"], rect["bottom"])
        area = (rect["x1"] - rect["x0"]) * (rect["bottom"] - rect["top"])
        opaque = rect.get("fill") and area > 400
        if not opaque or not _intersects(bbox):
            continue
        covered = [
            c for c in chars
            if bbox[0] <= (c["x0"] + c["x1"]) / 2 <= bbox[2] and bbox[1] <= (c["top"] + c["bottom"]) / 2 <= bbox[3]
        ]
        entry = {
            "kind": "white rectangle" if _white(rect.get("non_stroking_color")) else "filled rectangle",
            "bbox": [round(v, 1) for v in bbox],
            "covered_chars": len(covered),
        }
        facts.overlays_over_payment.append(entry)
        # Read the covered region one typeface at a time: an overlay and the text
        # it hides are two layers occupying the same coordinates.
        for layer in _text_layers(covered):
            lb, _la = _scan_payment_tokens(layer["text"])
            if lb:
                facts.covered_text_snippets.append(
                    f"[{layer['font']}] " + " ".join(layer["text"].split())[:180]
                )

    for annot in (page.annots or []):
        txt = (annot.get("contents") or annot.get("title") or "")
        if isinstance(txt, str) and txt.strip():
            facts.annotation_texts.append(txt.strip()[:200])

    if not visible_text.strip() and facts.image_count:
        facts.full_page_image = True
    return facts


def _image_hashes(reader: PdfReader) -> list[str]:
    hashes: list[str] = []
    for page in reader.pages:
        try:
            for img in page.images:
                hashes.append(hashlib.sha256(img.data).hexdigest()[:16])
        except Exception:  # malformed / unsupported filter
            continue
    return hashes


# --------------------------------------------------------------------------
# field parsing
# --------------------------------------------------------------------------
def _parse_fields(inv: ExtractedInvoice, text: str) -> None:
    lines = [ln.strip() for ln in text.splitlines()]

    m = RE_ABN.search(text)
    if m:
        inv.supplier_abn = re.sub(r"\s+", " ", m.group(1).strip())
    m = RE_LICENCE.search(text)
    if m:
        inv.supplier_licence = m.group(1).strip()
    m = RE_EMAIL.search(text)
    if m:
        inv.supplier_email = m.group(0).strip().lower()
    m = RE_PHONE.search(text)
    if m:
        inv.supplier_phone = re.sub(r"[\s()\-]", "", m.group(1))

    m = RE_INV_NO.search(text)
    if m:
        inv.invoice_number = m.group(1).strip()
    m = RE_REFERENCE.search(text)
    if m:
        inv.invoice_reference = m.group(1).strip()
    m = RE_DUE.search(text)
    if m:
        inv.due_date = parse_date(m.group(1))
    for m in RE_DATE_LABEL.finditer(text):
        d = parse_date(m.group(1))
        if d:
            inv.invoice_date = d
            break
    # Xero/MYOB-style templates stack the label above the value.
    def _value_under(label_pattern: str) -> str | None:
        for i, ln in enumerate(lines):
            if re.fullmatch(label_pattern, ln, re.I) and i + 1 < len(lines):
                nxt = lines[i + 1].strip()
                if nxt and not re.fullmatch(r"[A-Za-z ]{2,20}", nxt):
                    return nxt
        return None

    if inv.invoice_date is None:
        inv.invoice_date = parse_date(_value_under(r"Date"))
    if inv.invoice_date is None:
        # The 'Date' label often shares a rendered line with unrelated left-hand
        # text (customer block on the left, dates on the right). Take the first
        # parseable date on, or immediately below, such a line.
        for i, ln in enumerate(lines):
            if not re.search(r"(?<!Due )\bDate\b", ln, re.I):
                continue
            tail = re.split(r"\bDate\b", ln, maxsplit=1, flags=re.I)[-1]
            cand = parse_date(tail) or (parse_date(lines[i + 1]) if i + 1 < len(lines) else None)
            if cand and cand != inv.due_date:
                inv.invoice_date = cand
                break
    if inv.invoice_number is None:
        inv.invoice_number = _value_under(r"Invoice\s*(?:Number|No\.?|#)")
    if inv.invoice_reference is None:
        inv.invoice_reference = _value_under(r"Reference")

    inv.subtotal = _money(RE_SUBTOTAL.search(text).group(1)) if RE_SUBTOTAL.search(text) else None
    inv.gst = _money(RE_GST.search(text).group(1)) if RE_GST.search(text) else None
    inv.total = _money(RE_TOTAL.search(text).group(1)) if RE_TOTAL.search(text) else None
    inv.payments_applied = _money(RE_PAYMENTS.search(text).group(1)) if RE_PAYMENTS.search(text) else None
    inv.amount_due = _money(RE_AMOUNT_DUE.search(text).group(1)) if RE_AMOUNT_DUE.search(text) else None

    pay = inv.payment
    m = RE_ACCOUNT_NAME.search(text)
    if m:
        pay.account_name = m.group(1).strip()
    m = RE_BANK.search(text)
    if m:
        pay.bank_printed = m.group(1).strip()
    m = RE_BSB.search(text) or RE_BSB_LOOSE.search(_strip_identity_numbers(text))
    if m:
        pay.bsb_printed = m.group(1).strip()
        pay.bsb = normalise_bsb(m.group(1))
    for m in RE_ACCOUNT_NO.finditer(text):
        if re.match(r"\s*Account\s*Name", m.group(0), re.I):
            continue
        digits = re.sub(r"\D", "", m.group(1))
        if 5 <= len(digits) <= 10 and digits != (pay.bsb or ""):
            pay.account_number = digits
            break
    m = RE_PAYID.search(text)
    if m:
        pay.payid = m.group(1).strip()
    m = RE_BPAY.search(text)
    if m:
        pay.bpay_biller = m.group(1).strip()
    m = re.search(r"(please use [^\n]{0,80})", text, re.I)
    if m:
        pay.reference_note = m.group(1).strip()

    # Supplier identity: the header is usually a logo, so fall back through
    # the account name, then any company-suffixed entity in the body text.
    cand = None
    if pay.account_name:
        cand = pay.account_name
    else:
        m = RE_ENTITY.search(text)
        if m:
            cand = m.group(1)
    if not cand:
        for ln in lines[:6]:
            if ln and not RE_ABN.search(ln) and not RE_EMAIL.search(ln) and len(ln) > 3:
                cand = ln
                break
    if cand:
        inv.supplier_name = re.sub(r"\s+", " ", cand).strip()
    else:
        inv.parse_warnings.append(
            "Supplier name could not be read from the text layer (letterhead is likely an image). "
            "Supply it via the supplier hint, or enable OCR of the header region."
        )

    m = re.search(r"(?:at|Site|Property)[:\s]+(\d+[^\n,]{3,60}(?:,[^\n]{2,40})?)", text)
    if m:
        inv.site_address = m.group(1).strip()

    # Line items: description followed by unit price / gst / amount.
    for ln in lines:
        m = re.match(r"(.{4,80}?)\s+([\d,]+\.\d{2,4})\s+(\d{1,2})%\s+([\d,]+\.\d{2})$", ln)
        if m:
            inv.line_items.append(
                LineItem(m.group(1).strip(), _money(m.group(2)),
                         float(m.group(3)) / 100.0, _money(m.group(4)))
            )


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------
def extract(data: bytes, filename: str = "invoice.pdf", supplier_hint: str | None = None) -> ExtractedInvoice:
    inv = ExtractedInvoice()
    raw = _raw_facts(data)

    meta = DocumentMeta(
        filename=filename,
        byte_size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        pdf_version=raw["header_version"],
        eof_markers=raw["eof_markers"],
        xref_sections=raw["xref_sections"],
        incremental_updates=raw["incremental_updates"],
        has_xmp=raw["has_xmp"],
        xmp_document_id=raw["xmp_document_id"],
        xmp_instance_id=raw["xmp_instance_id"],
        xmp_history_events=raw["xmp_history_events"],
        has_signature=raw["has_signature"],
    )

    try:
        reader = PdfReader(io.BytesIO(data))
        meta.encrypted = bool(reader.is_encrypted)
        meta.page_count = len(reader.pages)
        info = reader.metadata or {}
        meta.title = str(info.get("/Title")) if info.get("/Title") else None
        meta.author = str(info.get("/Author")) if info.get("/Author") else None
        meta.subject = str(info.get("/Subject")) if info.get("/Subject") else None
        meta.creator = str(info.get("/Creator")) if info.get("/Creator") else None
        meta.producer = str(info.get("/Producer")) if info.get("/Producer") else None
        meta.creation_date = _pdf_date(info.get("/CreationDate"))
        meta.mod_date = _pdf_date(info.get("/ModDate"))
        image_hashes = _image_hashes(reader)
    except Exception as exc:  # noqa: BLE001 - a broken PDF is itself a signal
        inv.parse_warnings.append(f"pypdf could not fully read the document: {exc}")
        image_hashes = []

    inv.meta = meta

    text = ""
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if not meta.page_count:
                meta.page_count = len(pdf.pages)
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
            inv.layout = _layout_facts(pdf, text)
    except Exception as exc:  # noqa: BLE001
        inv.parse_warnings.append(f"pdfplumber could not render the page: {exc}")

    inv.layout.image_hashes = image_hashes
    inv.text = text
    _parse_fields(inv, text)

    # A patched page renders two text layers into one unreadable stream. When the
    # flat text yields no usable instrument, fall back to the per-layer read.
    overprinted = inv.layout.overprint_ratio > 0.02
    if inv.layout.payment_candidates and (
        overprinted or not (inv.payment.bsb and inv.payment.account_number)
    ):
        # Where layers overlap, the one painted last is the one a human sees.
        best = max(
            inv.layout.payment_candidates,
            key=lambda c: (bool(c.get("bsb")), bool(c.get("account")), c.get("z", 0)),
        )
        pay = inv.payment
        take = (lambda cur, new: new or cur) if overprinted else (lambda cur, new: cur or new)
        pay.bsb = take(pay.bsb, best.get("bsb"))
        pay.account_number = take(pay.account_number, best.get("account"))
        pay.bank_printed = take(pay.bank_printed, best.get("bank"))
        pay.account_name = take(pay.account_name, best.get("account_name"))
        if pay.bsb:
            pay.bsb_printed = f"{pay.bsb[:3]} {pay.bsb[3:]}"
        inv.parse_warnings.append(
            "Payment details were read layer-by-layer: the page carries overlapping text runs, so the "
            "instrument reported is the one painted last (what a reader sees)."
        )

    if supplier_hint:
        inv.supplier_name = supplier_hint

    if not text.strip():
        inv.parse_warnings.append(
            "No selectable text: the page is an image. Field-level checks are unavailable without OCR."
        )
    return inv


def creation_vs_mod_gap_hours(meta: DocumentMeta) -> float | None:
    c, m = _pdf_date_obj(meta.creation_date), _pdf_date_obj(meta.mod_date)
    if not c or not m:
        return None
    return (m - c).total_seconds() / 3600.0


def creation_datetime(meta: DocumentMeta) -> datetime | None:
    return _pdf_date_obj(meta.creation_date)
